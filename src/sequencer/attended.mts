// Attended local sequencer (issue #55, extended for `implement` in #57 and for the
// PR verbs in #141 and #142). The SECOND entry point: `agent-workflows <verb> <number>`
// runs a verb on the developer's own machine, streaming to the terminal. It began
// with the read-only `explore`; `implement` builds an issue end to end — commits on an
// agent branch and, by default, a finalize with full parity to the unattended path
// (push, open the draft PR, update the tracker), because what provides inspection is
// the surviving worktree, not a withheld push. A `--finalize=ask|never` flag holds
// everything off GitHub for the runs where the developer wants to look first.
// `review-pr` reviews a pull request the same way, and reads the same flag: `auto` posts
// the review through the reviews API exactly as the unattended run's does, while
// `ask`/`never` compose the review and leave the pull request untouched (issue #143); and
// `implement-pr` addresses that pull request's feedback, committing onto its checked-out
// head and pushing those commits to the head ref by name (never force-pushing) before the
// replies are posted — reading the same flag too (issue #144), so the commits can be
// looked at before anything is pushed.
//
// It creates a git worktree UNDER the configured root — never the checkout the
// developer is sitting in — invokes the repo's own opaque bootstrap command to make
// that tree runnable, then hands the SAME sequence the reusable workflow runs to the
// sequencer inside the worktree, so the attended and unattended paths share one
// implementation and cannot drift. A commit-producing verb's worktree survives a
// successful run (it is what the developer inspects); every run retains its tree on
// failure or a Ctrl-C abort, and the read-only verbs remove a clean one. The run closes
// with a printed summary so the outcome is legible at a glance.
//
// Credentials come from the developer's already-authenticated `gh` and existing
// agent credentials, inherited through the ambient environment: this sequencer
// neither reads nor writes any secret material.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  worktreePath,
  retainWorktree,
  parseFinalizeMode,
  honoursFinalizeMode,
  interactiveEligible,
  interactiveVerbs,
  attendable,
  attendedVerbs,
  attendedRunShape,
  formatRunSummary,
  type FinalizeMode,
  type LocalOutcome,
} from "./plan.mts";
import { acquireLock, lockPath, releaseLock } from "./lock.mts";
import { resolveConfig } from "../shared/config.mts";
import { IN_PROGRESS_LABEL, resolveDefaultBranch, resolveRepoSlug } from "../shared/github.mts";
import { parseSequenceState, type SequenceState } from "./sequence-state.mts";

const verb = process.argv[2];
const issue = process.argv[3];
// `--force` overrules a guard refusal AND both concurrency mutexes (issue #56):
// the `agent:in-progress` label and the local lock. The single flag a developer
// uses to start a run they know is safe despite a preflight or a mutex saying no.
const force = process.argv.includes("--force");
// `--interactive` (issue #58) hands the composed prompt to a LIVE agent session in the
// terminal so the developer steers the work directly, rather than only watching a
// headless run. Accepted only for the commit-producing verbs (`implement`,
// `implement-pr`); the sequencer refuses it for the read-only verbs and `update-branch`.
// Every step after the agent run — the push, the replies, the tracker update — behaves
// exactly as it does for a headless run (issue #142).
const interactive = process.argv.includes("--interactive");
if (!verb || !issue) {
  console.error(
    "attended: usage: agent-workflows <verb> <issue-or-pr-number> [--force] " +
      "[--finalize=auto|ask|never] [--interactive]",
  );
  process.exit(2);
}
// Refuse `--interactive` on an ineligible verb BEFORE any worktree or bootstrap work
// (issue #58): a read-only verb's result is a structured extraction a free-form
// interactive session cannot produce, so the run could not report itself. This check
// precedes the attended-verb gate so the reason names interactivity, not availability.
if (interactive && !interactiveEligible(verb)) {
  console.error(
    `attended: --interactive is not available for "${verb}" — only ${interactiveVerbs.join(", ")} ` +
      `produce commits a live agent session can steer. "${verb}" depends on a structured extraction ` +
      `pass an interactive session cannot produce, so its result could not be reported.`,
  );
  process.exit(2);
}
if (!attendable(verb)) {
  console.error(
    `attended: "${verb}" is not available for local runs yet — only ${attendedVerbs.join(", ")}.`,
  );
  process.exit(2);
}

// The shape of this run (issue #140): which environment variables carry the number and the
// title, which `gh` subcommand reads the subject's title and labels — and so which object
// carries the `agent:in-progress` mutex — and what the worktree checks out. A pure
// derivation from the verb, read here rather than restated as per-verb branches: every
// difference between an attended issue run and an attended pull-request run follows from it.
const shape = attendedRunShape(verb);

// How this run finalizes (issues #57, #143, #144). Which verbs read the flag is the plan
// module's decision (`honoursFinalizeMode`), not a condition restated here: every attended
// verb but `explore` today — the two that produce commits the developer may want to look
// at before they are pushed, and the one that composes a review they may want to read
// before it is posted. `explore`'s read-only comment always posts and `update-branch`
// finalizes with full parity, so they run `auto` whatever the argv says. `auto` (the
// default) is full parity with the unattended path; `never` stops with the work composed
// locally; `ask` finalizes only on confirmation.
let finalizeMode: FinalizeMode = "auto";
if (honoursFinalizeMode(verb)) {
  try {
    finalizeMode = parseFinalizeMode(process.argv);
  } catch (err) {
    console.error(`attended: ${(err as Error).message}`);
    process.exit(2);
  }
}

// Which runs account for finalize in the end-of-run summary: `implement`, whose mode the
// developer chose, and every PR verb, whose finalize lands on the pull request the
// developer is watching. `explore` alone omits the line — its comment always posts, so
// there is nothing to report (issue #141).
const reportsFinalize = verb === "implement" || shape.subject === "pull-request";

// Run a command, streaming its output to the terminal. Returns the raw spawn
// result so the caller can read both the exit status and the terminating signal
// (a Ctrl-C abort surfaces as `signal`, not a status).
function run(file: string, args: readonly string[], cwd?: string) {
  return spawnSync(file, [...args], { stdio: "inherit", cwd, env: process.env });
}

// Capture a command's stdout, trimmed. Throws on a non-zero exit (a missing base
// ref or an unauthenticated `gh` should fail the run loudly, before the worktree).
function capture(file: string, args: readonly string[]): string {
  const child = spawnSync(file, [...args], { encoding: "utf8" });
  if (child.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} exited ${child.status ?? "with a signal"}`);
  }
  return child.stdout.trim();
}

// The root of the checkout the developer launched from — what a PR run's tracker hooks
// use as their tooling directory (issue #141). The toplevel rather than the raw cwd, so a
// command run from a subdirectory still resolves the repo's `.sandcastle/` overrides and
// its config file; the cwd is the honest fallback when git cannot answer.
function invokingCheckout(): string {
  try {
    return capture("git", ["rev-parse", "--show-toplevel"]) || process.cwd();
  } catch {
    return process.cwd();
  }
}

const config = resolveConfig();
// The repository default branch, as the reusable workflow's DEFAULT_BRANCH input carries
// it — a bare NAME. It fills the lowest-precedence slot of every base resolution
// (`resolveBaseBranch`: BASE_BRANCH → the config file → this), and an attended run has no
// workflow to fill it, so it is derived here (`resolveDefaultBranch`, shared with the spec
// loop). `config.baseBranch` already covers the two higher slots, so both being empty means
// nothing anywhere names a base: refuse now, by name, rather than letting `create-branch`
// cut from `origin/` and die inside git without mentioning the cause.
const defaultBranch = resolveDefaultBranch();
// Only a run that BUILDS on the base needs one. A PR run checks out the pull request's own
// head, so a checkout with no resolvable default branch is no obstacle to it (issue #141).
if (shape.checkout === "base" && !config.baseBranch && !defaultBranch) {
  console.error(
    "attended: cannot tell which branch to build on — this checkout's `origin/HEAD` is unset or " +
      "dangling (a remote added by hand, or a default branch renamed since the clone) and `gh repo " +
      "view` could not answer either. Point it at the default with `git remote set-head origin -a`, " +
      "or set `baseBranch` in .sandcastle/agent-workflows/config.json.",
  );
  process.exit(2);
}
// The committish the worktree checks out. A configured base wins; otherwise the repository
// default as its remote-tracking ref (the latest fetched tip). The worktree is created
// DETACHED at this commit, so basing on a branch the developer already has checked out never
// trips git's "already checked out" guard.
const base = config.baseBranch || `origin/${defaultBranch}`;
const root = config.worktreeRoot;
const tree = worktreePath(root, verb, issue);
// The local lock (mutex between two terminals) lives beside the worktree under the
// same root, keyed by the run identity so two different issues/specs never collide.
const lock = lockPath(root, `${verb}-${issue}`);

// Fetch the subject's title (the run's prompt needs it) and labels (the in-progress
// mutex check) up front, in one call, using the developer's own authenticated `gh`
// (no token is read from or written to disk here). Which subject — the issue or the pull
// request — is the run shape's call, not this shell's. `isCrossRepository` is a pull
// request's field alone, so it is asked for only when the subject IS one; `gh issue view`
// fails on a field it does not know rather than ignoring it.
const subjectFields =
  shape.subject === "pull-request"
    ? "title,labels,isCrossRepository,headRefName"
    : "title,labels";
const subjectInfo = JSON.parse(
  capture("gh", [shape.ghSubcommand, "view", issue, "--json", subjectFields]),
) as {
  title: string;
  labels: Array<{ name: string }>;
  isCrossRepository?: boolean;
  headRefName?: string;
};
const subjectTitle = subjectInfo.title;
const subjectLabels = subjectInfo.labels.map((l) => l.name);

// A cross-repository (fork) pull request is refused HERE — before the lock, the worktree,
// and the bootstrap — with the reason named (issue #141). Its head lives on another
// repository, so checking it out means a second remote, and finalizing against it means
// push rights an attended run must not assume silently. Every pull request the fleet
// itself opens is same-repo. Refusing late would leave a half-built tree and an
// unexplained git error in place of this sentence.
if (subjectInfo.isCrossRepository) {
  console.error(
    `attended: PR #${issue} comes from a fork (its head is on another repository), which an ` +
      `attended run does not support — it would need a second remote to check the head out and ` +
      `push rights on that fork to finalize. Nothing was created.`,
  );
  process.exit(1);
}

// Mutex 1 — `agent:in-progress` between entry points. If the run's subject (the issue,
// or the pull request for a PR verb) already carries it, the unattended workflow (or
// another attended run past its status step) is mid-run; refuse rather than trample it.
// `--force` overrules this. The reason prints to the terminal and nothing is posted to
// the tracker — a refusal on something the developer is watching is noise.
if (subjectLabels.includes(IN_PROGRESS_LABEL) && !force) {
  console.error(
    `attended: #${issue} already carries \`${IN_PROGRESS_LABEL}\` — another run is in progress. ` +
      `Re-run with --force to start anyway.`,
  );
  process.exit(1);
}

// The scratch files this run's hooks exchange — the local stand-in for the paths the
// reusable workflow resolved under $RUNNER_TEMP, keyed to this process so two runs never
// collide. An issue verb's hooks exchange the spec (fetch-spec writes it) and the comment
// finalize posts; `review-pr`'s exchange the review payload the run writes and finalize
// posts through the reviews API (issue #141), and `implement-pr`'s the per-comment replies
// the run writes and finalize posts as threaded replies (issue #142).
const specFile = join(tmpdir(), `agent-workflows-attended-${process.pid}-spec.md`);
const commentFile = join(tmpdir(), `agent-workflows-attended-${process.pid}-comment.md`);
// `review-pr`'s payload is the one scratch file that lives INSIDE the run's worktree
// rather than under the OS temp dir (issue #143): it is what a WITHHELD review run
// produces, and the retained worktree is where the developer reads what was not posted —
// the same place a withheld `implement` run's commits are. An `auto` run's tree is removed
// with the file in it, the review having reached the pull request.
const reviewFile = join(tree, "agent-workflows-review.json");
const repliesFile = join(tmpdir(), `agent-workflows-attended-${process.pid}-replies.json`);
// Where the first slice mirrors the branch/base it resolved, so an attended `ask`
// finalize can thread them into its confirmed tail-only slice (issue #57).
const stateFile = join(tmpdir(), `agent-workflows-attended-${process.pid}-state`);

// Ctrl-C: install a handler so this parent survives the signal (the child in the
// same process group still receives and dies from it), leaving us alive to run the
// retain-vs-remove cleanup. Without a handler a bare SIGINT would kill the parent
// before it could decide the worktree's fate.
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

mkdirSync(root, { recursive: true });

// Mutex 2 — the local lock between two terminals. The `agent:in-progress` label
// cannot cover this: two terminals started together would each only ever observe
// their own not-yet-written label. Acquisition is a single atomic directory create
// (never a check-then-create, which would race). A stale lock left by a killed
// process is cleared automatically; `--force` overrules a live holder.
const acquired = acquireLock(lock, process.pid, { force });
if (!acquired.acquired) {
  console.error(
    `attended: another local run holds the lock at ${lock}` +
      (acquired.heldBy ? ` (pid ${acquired.heldBy})` : "") +
      `. Re-run with --force to take it over.`,
  );
  process.exit(1);
}
if (acquired.clearedStale) {
  console.log(`attended: cleared a stale lock at ${lock} (its owner was gone).`);
}

// Create the worktree under the configured root — never the developer's checkout.
// A pre-existing tree (a retried command after a retained failure) is reused as-is.
// What it checks out is the run shape's call: an issue verb builds on the base, while a
// PR verb reads (and, for a later verb, edits) the code actually under review, so its
// tree is detached at the pull request's head. The head is fetched by its pull ref first
// — an attended run is launched from a checkout that has never seen it (issue #141).
if (existsSync(tree)) {
  console.log(`attended: reusing existing worktree at ${tree}`);
} else {
  let committish = base;
  let described = base;
  if (shape.checkout === "pr-head") {
    console.log(`attended: fetching the head of PR #${issue}`);
    const fetched = run("git", ["fetch", "--no-tags", "origin", `pull/${issue}/head`]);
    if (fetched.status !== 0) {
      console.error(
        `attended: could not fetch the head of PR #${issue} (git exited ${fetched.status}).`,
      );
      releaseLock(lock);
      process.exit(1);
    }
    // FETCH_HEAD rather than the head SHA `gh` reported: it is exactly what the fetch just
    // brought in, so a head force-pushed between the two calls cannot leave the worktree
    // pointing at a commit this checkout does not have.
    committish = "FETCH_HEAD";
    described = `the head of PR #${issue}`;
  }
  console.log(`attended: creating worktree at ${tree} (detached at ${described})`);
  const added = run("git", ["worktree", "add", "--detach", tree, committish]);
  if (added.status !== 0) {
    console.error(`attended: could not create the worktree (git exited ${added.status}).`);
    releaseLock(lock);
    process.exit(1);
  }
}

// Determine how the run ended so the cleanup policy (plan.mts) can decide the
// worktree's fate. A Ctrl-C abort trumps any exit code; otherwise a zero exit is a
// success (the sequencer folds a guard refusal to zero too) and anything else is a
// failure.
function outcomeOf(status: number | null, signal: NodeJS.Signals | null): LocalOutcome {
  if (interrupted || signal) return "aborted";
  return status === 0 ? "succeeded" : "failed";
}

// Settle the worktree and release the lock, returning whether the tree was kept so
// the run summary can report its fate. The policy (plan.mts) retains on failure or
// abort — and, for `implement`, on success too — so the developer can open exactly
// what the run produced; it retains a WITHHELD run's tree whatever the verb, that tree
// being where the developer reads what nothing published (issue #143); and it removes
// only a clean end with nothing to inspect. The lock is ALWAYS released — on success,
// failure, and abort alike — so a retained tree never wedges the key for the next run.
function cleanup(outcome: LocalOutcome, withheld: boolean): boolean {
  releaseLock(lock);
  if (retainWorktree(outcome, verb, withheld)) return true;
  const removed = run("git", ["worktree", "remove", "--force", tree]);
  if (removed.status !== 0) {
    console.error(`attended: worktree left at ${tree} (git worktree remove exited ${removed.status}).`);
    return true;
  }
  return false;
}

// Settle the worktree, print the end-of-run summary (issue #57) so the developer
// sees what happened without scrolling back through streamed output, and exit.
function finish(
  outcome: LocalOutcome,
  finalized: boolean,
  code: number,
  withheld = false,
): never {
  const retained = cleanup(outcome, withheld);
  console.log("");
  console.log(
    formatRunSummary({
      verb,
      issue,
      outcome,
      retained,
      tree,
      finalize: reportsFinalize ? finalizeMode : undefined,
      finalized,
    }),
  );
  process.exit(code);
}

// What the sequence reported back: its outcome (a refusal is invisible in the exit
// code) and the branch/base it resolved, which the confirmed finalize slice threads
// so a local finalize lands exactly as the unattended tail would. An absent or
// unreadable file is "nothing reported" — never a refusal, so a missing file can only
// leave behaviour as it was.
function readState(path: string): SequenceState {
  try {
    return parseSequenceState(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// A single-line yes/no prompt read from the terminal. `bash`'s `read` reads the
// developer's answer from the inherited stdin; a non-interactive stdin (or a bare
// Enter) reads empty and declines — the safe default, so `ask` does nothing unless
// the developer explicitly confirms.
function confirm(question: string): boolean {
  process.stdout.write(question);
  const res = spawnSync("bash", ["-c", 'read -r reply; printf "%s" "$reply"'], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  const answer = (res.stdout ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// Bootstrap the fresh worktree with the repo's own opaque command (e.g. `yarn
// install`). A non-zero exit fails the run BEFORE the agent starts; the tree is
// retained so the developer can see why bootstrap broke.
if (config.bootstrap) {
  console.log(`attended: bootstrapping worktree: ${config.bootstrap}`);
  const boot = run("bash", ["-eo", "pipefail", "-c", config.bootstrap], tree);
  if (boot.status !== 0 || interrupted || boot.signal) {
    const outcome = outcomeOf(boot.status, boot.signal);
    console.error(`attended: bootstrap did not succeed — not starting the agent.`);
    finish(outcome, false, outcome === "aborted" ? 130 : boot.status || 1);
  }
}

// Hand the whole verb sequence to the sequencer INSIDE the worktree — the exact
// command the reusable workflow runs — so the attended run does the same tracker
// work as the unattended path. The issue context and scratch-file paths are threaded
// through the environment the hooks read.
//
// Two attended-only signals ride along: `ANNOUNCE_REFUSALS=false` tells a guard
// refusal to print its reason to the terminal and post NOTHING to the tracker
// (state labels are still written normally); `FORCE` relaxes the guards step to
// tolerated so a refusal is overruled rather than halting the run.
//
// For the verbs that honour it (issues #57, #143, #144) the finalize mode rides along
// too: a non-`auto` mode drops the finalize tail (and the in-progress status write) so
// nothing reaches GitHub until finalize, and `ask` additionally asks the sequence to
// mirror its resolved branch/base to the state file for the confirmed finalize slice.
//
// `--interactive` (issue #58) rides along as `INTERACTIVE`: the verb's run hook reads
// it and hands the composed prompt to a live agent session instead of a headless run.
// It is set only for an eligible verb (ineligible verbs were refused above), and only
// the run step reads it — every later step (the boot check, push, and finalize) behaves
// exactly as it does for a headless run.
const runEnv: Record<string, string> = {
  [shape.numberEnv]: issue,
  [shape.titleEnv]: subjectTitle,
  ANNOUNCE_REFUSALS: "false",
};
if (shape.subject === "issue") {
  runEnv.SPEC_FILE = specFile;
  runEnv.COMMENT_FILE = commentFile;
} else {
  // The tooling directory a PR verb's tracker hooks (guards, status, finalize) run in —
  // the slot the reusable workflow fills with a detached default-branch worktree, because
  // a pull request's branch may predate the tooling. An attended run deliberately does the
  // opposite (issue #141) and points it at the checkout the developer launched from: the
  // tooling in front of them, so changing a PR verb's logic and running it needs no push
  // in between. The worktree stays the cwd of the agent run, which reads the code under
  // review.
  runEnv.TOOLING_DIR = invokingCheckout();
  // The branch the run's commits are pushed BACK to, in the slot the reusable workflow
  // fills from the pull-request event (issue #142). A property of the subject rather than
  // of the verb, so it rides along for every PR run; only a verb whose plan pushes reads
  // it. Pushing to the head ref BY NAME is what lets the worktree stay detached at the
  // fetched head — and the push is a plain one, so a head that advanced remotely during
  // the run self-reports blocked instead of being overwritten.
  if (subjectInfo.headRefName) runEnv.HEAD_REF = subjectInfo.headRefName;
}
// `review-pr`'s run writes the reviews-API payload here and its finalize posts it; in CI
// the workflow resolves the same file under $RUNNER_TEMP (issue #141). `implement-pr`'s
// replies file is the same slot: the run writes the summary and the per-comment replies,
// and the finalize the push-and-finalize step invokes posts them (issue #142).
if (verb === "review-pr") runEnv.REVIEW_FILE = reviewFile;
if (verb === "implement-pr") runEnv.REPLIES_FILE = repliesFile;
// The hooks require GH_REPO; in CI the workflow supplies `github.repository`, and an
// attended run has no workflow — so it is derived from the checkout's own origin
// remote. Without it the FIRST hook refuses with a missing-variable message, which
// reads as an unexplained guard refusal.
const repoSlug = resolveRepoSlug();
if (repoSlug) runEnv.GH_REPO = repoSlug;
// The repository default branch resolved above, in the same slot the reusable workflow fills.
// Absent it a standalone issue's base resolves EMPTY and `create-branch` cuts from `origin/`
// — fatal. Passed as the bare NAME the hooks expect (the git steps prefix `origin/`
// themselves), not the committish `base` carries for `git worktree add`.
if (defaultBranch) runEnv.DEFAULT_BRANCH = defaultBranch;
if (force) runEnv.FORCE = "true";
if (interactive) runEnv.INTERACTIVE = "true";
if (finalizeMode !== "auto") runEnv.FINALIZE_MODE = finalizeMode;
// Always ask the sequence to report its outcome back. A guard refusal exits 0 (a
// refusal must leave CI green), so without this an attended run cannot tell a
// refusal from a clean success — and `LocalOutcome`'s `refused` case, which the
// worktree policy already handles, was unreachable. The `ask` path reads the
// branch/base from the same file (issue #57).
runEnv.SEQUENCE_STATE_FILE = stateFile;
// How the sequence is launched — the one place the two run shapes reach the sequencer
// differently. An issue run hands it to the worktree's own `sandcastle:<verb>-sequence`
// script, whose tooling is the base branch's and so is the tooling the run builds on. A PR
// run instead launches THIS checkout's dispatcher against the worktree — the local answer
// to CI's `"$AGENT_WORKFLOWS_BIN" <verb>` from the tooling worktree: same split (tooling
// from one checkout, code under review as the cwd), but the tooling is the developer's own
// (issue #141), so a PR verb's logic can be changed and run without a push in between.
const launch =
  shape.subject === "pull-request"
    ? {
        file: process.execPath,
        args: [fileURLToPath(new URL("../../bin/agent-workflows.mjs", import.meta.url)), verb],
      }
    : { file: "yarn", args: [`sandcastle:${verb}-sequence`] };
// The worktree's head BEFORE the run, so an `ask` finalize can say how many commits it is
// about to push (issue #144). Recorded only for the run that will be asked — a PR run
// holding its push back — because it is the only one that reads it, and a detached tree
// that cannot answer simply leaves the count out.
let headBeforeRun = "";
if (finalizeMode === "ask" && shape.checkout === "pr-head") {
  try {
    headBeforeRun = capture("git", ["-C", tree, "rev-parse", "HEAD"]);
  } catch {
    headBeforeRun = "";
  }
}

const child = spawnSync(launch.file, launch.args, {
  stdio: "inherit",
  cwd: tree,
  env: { ...process.env, ...runEnv },
});
if (child.error) {
  console.error(`attended: failed to launch the ${verb} sequence:`, child.error);
  finish("failed", false, 1);
}

// A refusal exits 0, so the reported outcome — not the exit code — is what
// distinguishes it from a clean success. Only a zero exit can be a refusal; a
// non-zero exit or a signal keeps its own meaning (failed / aborted).
const reported = readState(stateFile);
const exitOutcome = outcomeOf(child.status, child.signal);
const outcome: LocalOutcome =
  exitOutcome === "succeeded" && reported.outcome === "refused" ? "refused" : exitOutcome;

// What the pending finalize would post, read back from the payload the `review-pr`
// finalize hook posts (`{ body, event, comments[] }`), so `ask` shows what it is about to
// do rather than asking blind (issue #143). An unreadable payload is described as such —
// the developer is deciding on it, and a guess would be worse than the truth.
function composedReview(): string {
  try {
    const payload = JSON.parse(readFileSync(reviewFile, "utf8")) as { comments?: unknown[] };
    const inline = payload.comments?.length ?? 0;
    return `a summary and ${inline} inline comment${inline === 1 ? "" : "s"}`;
  } catch {
    return "a review that could not be read back";
  }
}

// What the pending `implement-pr` finalize will post, read back from the payload its
// finalize hook posts (`{ summary, replies[] }`), so `ask` shows what it is about to do
// rather than asking blind (issue #144) — the same accounting `composedReview` does for the
// read-only verb.
function composedReplies(): string {
  try {
    const payload = JSON.parse(readFileSync(repliesFile, "utf8")) as { replies?: unknown[] };
    const n = payload.replies?.length ?? 0;
    return `${n} threaded repl${n === 1 ? "y" : "ies"} and a summary comment`;
  } catch {
    return "replies that could not be read back";
  }
}

// How many commits the run added to the worktree's head, counted against the head as it
// stood before the run (issue #144). What an `implement-pr` developer is confirming is a
// PUSH, so the number of commits it will push is the fact worth showing. `undefined` when
// it cannot be counted — a reused tree whose recorded head is missing, say — and the
// announcement then says "commits" rather than inventing a count.
function commitsSinceRunStart(): number | undefined {
  if (!headBeforeRun) return undefined;
  try {
    const range = `${headBeforeRun}..HEAD`;
    const count = Number(capture("git", ["-C", tree, "rev-list", "--count", range]));
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

// Print what the pending finalize will do, in the verb's own terms, and report whether
// there is one to run at all (issues #57, #143, #144). A `false` return is NOT a decline:
// the run left nothing to finalize with, so there is nothing to ask about.
function announceFinalize(): boolean {
  if (verb === "review-pr") {
    console.log(
      `attended: review-pr #${issue} composed ${composedReview()}, unposted, at ${reviewFile}.`,
    );
    console.log(
      `attended: finalize will post that review to PR #${issue} through the reviews API and ` +
        `mark the run done — exactly the unattended path.`,
    );
    return true;
  }
  if (verb === "implement-pr") {
    const made = commitsSinceRunStart();
    const commits = made === undefined ? "commits" : `${made} commit${made === 1 ? "" : "s"}`;
    console.log(
      `attended: implement-pr #${issue} produced ${commits} on the pull request's head in ${tree}.`,
    );
    console.log(
      `attended: finalize will push them to ${subjectInfo.headRefName ?? "the head ref"} — a plain ` +
        `push, so a head that advanced remotely self-reports blocked rather than being overwritten ` +
        `— then post ${composedReplies()} and mark the run done. Exactly the unattended path.`,
    );
    return true;
  }
  if (!reported.branch) {
    console.error("attended: could not read the agent branch — skipping finalize.");
    return false;
  }
  console.log(`attended: implement #${issue} produced commits on ${reported.branch}.`);
  console.log(
    `attended: finalize will push ${reported.branch}, open the pull request, and update the ` +
      `tracker on ${reported.base || "the default branch"} — exactly the unattended path.`,
  );
  return true;
}

// Run the confirmed finalize: the SAME launcher against the SAME worktree, with
// `FINALIZE_TAIL_ONLY` selecting the plan's tail alone — so a confirmed local finalize
// does exactly what an `auto` run's single sequence did, and no more — down to
// `implement-pr`'s non-fast-forward self-report, which lives inside that bundled tail.
// The first slice's whole environment rides along (the scratch files finalize reads back, the tooling
// directory, the repo slug), plus the branch/base an `implement` tail needs and has no
// fetch-spec of its own to resolve. Returns the tail's exit code.
function runFinalizeTail(): number {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...runEnv,
    // The confirmed slice IS the finalize: the mode that withheld the tail must not
    // withhold it a second time.
    FINALIZE_MODE: "auto",
    FINALIZE_TAIL_ONLY: "true",
  };
  if (reported.branch) {
    env.BRANCH = reported.branch;
    env.BASE = reported.base;
  }
  const tail = spawnSync(launch.file, launch.args, { stdio: "inherit", cwd: tree, env });
  return tail.error ? 1 : tail.status ?? 1;
}

// The finalize accounting. An `auto` run's single sequence already did the whole tail
// (full parity), so a clean success IS finalized. A `never` run never finalizes — its
// plan dropped the tail and the in-progress status write with it, so there is nothing to
// run here and nothing on GitHub to undo. An `ask` run shows what finalize will do and
// runs it only on the developer's confirmation — the tail-only slice, so a confirmed
// local finalize lands exactly as CI's does.
let finalized = false;
let code = outcome === "aborted" ? 130 : outcome === "failed" ? child.status || 1 : 0;

if (outcome === "succeeded") {
  if (finalizeMode === "auto") {
    // Full parity: the single sequence already did the whole tail — `implement` pushed and
    // opened the PR, `review-pr` posted the review, `implement-pr` pushed its commits to the
    // pull request's head and posted the replies. Only the runs that REPORT a finalize
    // record it; `explore`'s read-only comment always posts and needs no accounting.
    finalized = reportsFinalize;
  } else if (finalizeMode === "ask") {
    console.log("");
    if (announceFinalize()) {
      if (confirm("attended: finalize now? [y/N] ")) {
        const tailCode = runFinalizeTail();
        if (tailCode === 0) {
          finalized = true;
        } else {
          console.error(`attended: finalize did not succeed (exit ${tailCode}).`);
          code = tailCode;
        }
      } else {
        console.log(
          `attended: finalize declined — ${verb === "review-pr" ? "nothing posted" : "nothing pushed"}.`,
        );
      }
    }
  } else if (verb === "review-pr") {
    // `never` has nothing to run — only somewhere to point at, this verb's withheld work
    // being a file rather than commits on a branch the summary can name (issue #143).
    console.log("");
    console.log(`attended: finalize withheld — the composed review is unposted at ${reviewFile}.`);
  }
}

// Whether this run WITHHELD its finalize (issue #143): it succeeded and composed its work,
// and nothing reached GitHub — a `never` run, or an `ask` run the developer declined. The
// worktree policy retains such a tree whatever the verb, because the tree is where the
// developer reads what nothing published.
const withheld = outcome === "succeeded" && finalizeMode !== "auto" && !finalized;

finish(outcome, finalized, code, withheld);
