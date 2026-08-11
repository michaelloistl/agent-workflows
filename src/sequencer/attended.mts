// Attended local sequencer (issue #55, extended for `implement` in #57). The SECOND
// entry point: `agent-workflows <verb> <issue-number>` runs a verb on the
// developer's own machine, streaming to the terminal. It began with the read-only
// `explore`; `implement` now builds an issue end to end — commits on an agent branch
// and, by default, a finalize with full parity to the unattended path (push, open
// the draft PR, update the tracker), because what provides inspection is the
// surviving worktree, not a withheld push. A `--finalize=ask|never` flag holds
// everything off GitHub for the runs where the developer wants to look first.
//
// It creates a git worktree UNDER the configured root — never the checkout the
// developer is sitting in — invokes the repo's own opaque bootstrap command to make
// that tree runnable, then hands the SAME sequence the reusable workflow runs to the
// sequencer inside the worktree (`yarn sandcastle:<verb>-sequence`), so the attended
// and unattended paths share one implementation and cannot drift. An `implement`
// worktree survives a successful run (it is what the developer inspects); every run
// retains its tree on failure or a Ctrl-C abort, and `explore` removes a clean one.
// The run closes with a printed summary so the outcome is legible at a glance.
//
// Credentials come from the developer's already-authenticated `gh` and existing
// agent credentials, inherited through the ambient environment: this sequencer
// neither reads nor writes any secret material.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  worktreePath,
  retainWorktree,
  parseFinalizeMode,
  interactiveEligible,
  interactiveVerbs,
  formatRunSummary,
  type FinalizeMode,
  type LocalOutcome,
} from "./plan.mts";
import { acquireLock, lockPath, releaseLock } from "./lock.mts";
import { resolveConfig } from "../shared/config.mts";
import { IN_PROGRESS_LABEL, resolveRepoSlug } from "../shared/github.mts";
import { parseSequenceState, type SequenceState } from "./sequence-state.mts";

// The verbs delivered for attended runs. `explore` (read-only) came first; issue
// #57 adds `implement`, which builds an issue end to end on the developer's machine
// — commits on an agent branch, then a finalize that (by default) pushes, opens the
// draft PR, and updates the tracker exactly as the unattended path does.
const ATTENDED_VERBS = new Set(["explore", "implement"]);

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
const interactive = process.argv.includes("--interactive");
if (!verb || !issue) {
  console.error(
    "attended: usage: agent-workflows <verb> <issue-number> [--force] [--finalize=auto|ask|never] [--interactive]",
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
if (!ATTENDED_VERBS.has(verb)) {
  console.error(
    `attended: "${verb}" is not available for local runs yet — only ${[...ATTENDED_VERBS].join(", ")}.`,
  );
  process.exit(2);
}

// How this run finalizes (issue #57). Only `implement` finalizes to GitHub, so the
// flag is read for it alone; `explore`'s read-only comment always posts. `auto`
// (the default) is full parity with the unattended path; `never` stops with the
// commits on the agent branch; `ask` finalizes only on confirmation.
let finalizeMode: FinalizeMode = "auto";
if (verb === "implement") {
  try {
    finalizeMode = parseFinalizeMode(process.argv);
  } catch (err) {
    console.error(`attended: ${(err as Error).message}`);
    process.exit(2);
  }
}

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

// The committish the worktree checks out. A configured base wins; otherwise the
// repository's default branch as `origin/HEAD` points at it (the latest fetched
// tip). The worktree is created DETACHED at this commit, so basing on a branch the
// developer already has checked out never trips git's "already checked out" guard.
function resolveBase(configured: string): string {
  if (configured) return configured;
  try {
    return capture("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  } catch {
    return "HEAD";
  }
}

const config = resolveConfig();
const base = resolveBase(config.baseBranch);
const root = config.worktreeRoot;
const tree = worktreePath(root, verb, issue);
// The local lock (mutex between two terminals) lives beside the worktree under the
// same root, keyed by the run identity so two different issues/specs never collide.
const lock = lockPath(root, `${verb}-${issue}`);

// Fetch the issue title (the run's prompt needs it) and labels (the in-progress
// mutex check) up front, in one call, using the developer's own authenticated `gh`
// (no token is read from or written to disk here).
const issueInfo = JSON.parse(
  capture("gh", ["issue", "view", issue, "--json", "title,labels"]),
) as { title: string; labels: Array<{ name: string }> };
const issueTitle = issueInfo.title;
const issueLabels = issueInfo.labels.map((l) => l.name);

// Mutex 1 — `agent:in-progress` between entry points. If the issue already carries
// it, the unattended workflow (or another attended run past its status step) is
// mid-run; refuse rather than trample it. `--force` overrules this. The reason
// prints to the terminal and nothing is posted to the tracker — a refusal on an
// issue the developer is watching is noise.
if (issueLabels.includes(IN_PROGRESS_LABEL) && !force) {
  console.error(
    `attended: #${issue} already carries \`${IN_PROGRESS_LABEL}\` — another run is in progress. ` +
      `Re-run with --force to start anyway.`,
  );
  process.exit(1);
}

// The two scratch files the explore sequence's hooks exchange (fetch-spec writes
// the spec, the run writes the comment finalize posts) — the local stand-in for the
// paths the reusable workflow resolved under $RUNNER_TEMP.
const specFile = join(tmpdir(), `agent-workflows-attended-${process.pid}-spec.md`);
const commentFile = join(tmpdir(), `agent-workflows-attended-${process.pid}-comment.md`);
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
if (existsSync(tree)) {
  console.log(`attended: reusing existing worktree at ${tree}`);
} else {
  console.log(`attended: creating worktree at ${tree} (detached at ${base})`);
  const added = run("git", ["worktree", "add", "--detach", tree, base]);
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
// what the run produced; it removes only a clean end with nothing to inspect. The
// lock is ALWAYS released — on success, failure, and abort alike — so a retained
// tree never wedges the key for the next run.
function cleanup(outcome: LocalOutcome): boolean {
  releaseLock(lock);
  if (retainWorktree(outcome, verb)) return true;
  const removed = run("git", ["worktree", "remove", "--force", tree]);
  if (removed.status !== 0) {
    console.error(`attended: worktree left at ${tree} (git worktree remove exited ${removed.status}).`);
    return true;
  }
  return false;
}

// Settle the worktree, print the end-of-run summary (issue #57) so the developer
// sees what happened without scrolling back through streamed output, and exit.
function finish(outcome: LocalOutcome, finalized: boolean, code: number): never {
  const retained = cleanup(outcome);
  console.log("");
  console.log(
    formatRunSummary({
      verb,
      issue,
      outcome,
      retained,
      tree,
      finalize: verb === "implement" ? finalizeMode : undefined,
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
// For `implement` (issue #57) the finalize mode rides along too: a non-`auto` mode
// drops the finalize tail (and the in-progress status write) so nothing reaches
// GitHub until finalize, and `ask` additionally asks the sequence to mirror its
// resolved branch/base to the state file for the confirmed finalize slice.
//
// `--interactive` (issue #58) rides along as `INTERACTIVE`: the verb's run hook reads
// it and hands the composed prompt to a live agent session instead of a headless run.
// It is set only for an eligible verb (ineligible verbs were refused above), and only
// the run step reads it — every later step (the boot check, push, and finalize) behaves
// exactly as it does for a headless run.
const runEnv: Record<string, string> = {
  ISSUE_NUMBER: issue,
  ISSUE_TITLE: issueTitle,
  SPEC_FILE: specFile,
  COMMENT_FILE: commentFile,
  ANNOUNCE_REFUSALS: "false",
};
// The hooks require GH_REPO; in CI the workflow supplies `github.repository`, and an
// attended run has no workflow — so it is derived from the checkout's own origin
// remote. Without it the FIRST hook refuses with a missing-variable message, which
// reads as an unexplained guard refusal.
const repoSlug = resolveRepoSlug();
if (repoSlug) runEnv.GH_REPO = repoSlug;
if (force) runEnv.FORCE = "true";
if (interactive) runEnv.INTERACTIVE = "true";
if (verb === "implement" && finalizeMode !== "auto") runEnv.FINALIZE_MODE = finalizeMode;
// Always ask the sequence to report its outcome back. A guard refusal exits 0 (a
// refusal must leave CI green), so without this an attended run cannot tell a
// refusal from a clean success — and `LocalOutcome`'s `refused` case, which the
// worktree policy already handles, was unreachable. The `ask` path reads the
// branch/base from the same file (issue #57).
runEnv.SEQUENCE_STATE_FILE = stateFile;
const child = spawnSync("yarn", [`sandcastle:${verb}-sequence`], {
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

// The finalize accounting. An `auto` run's single sequence already pushed and
// opened the PR (full parity), so a clean success IS finalized. A `never` run never
// finalizes. An `ask` run shows what finalize will do and runs it only on the
// developer's confirmation — the tail-only slice, threaded the branch/base the first
// slice resolved, so a confirmed local finalize lands on GitHub exactly as CI's does.
let finalized = false;
let code = outcome === "aborted" ? 130 : outcome === "failed" ? child.status || 1 : 0;

if (verb === "implement" && outcome === "succeeded") {
  if (finalizeMode === "auto") {
    finalized = true;
  } else if (finalizeMode === "ask") {
    if (!reported.branch) {
      console.error("attended: could not read the agent branch — skipping finalize.");
    } else {
      console.log("");
      console.log(`attended: implement #${issue} produced commits on ${reported.branch}.`);
      console.log(
        `attended: finalize will push ${reported.branch}, open the pull request, and update the ` +
          `tracker on ${reported.base || "the default branch"} — exactly the unattended path.`,
      );
      if (confirm("attended: finalize now? [y/N] ")) {
        const tail = spawnSync("yarn", ["sandcastle:implement-sequence"], {
          stdio: "inherit",
          cwd: tree,
          env: {
            ...process.env,
            ISSUE_NUMBER: issue,
            ISSUE_TITLE: issueTitle,
            SPEC_FILE: specFile,
            COMMENT_FILE: commentFile,
            FINALIZE_TAIL_ONLY: "true",
            BRANCH: reported.branch,
            BASE: reported.base,
          },
        });
        const tailCode = tail.error ? 1 : tail.status ?? 1;
        if (tailCode === 0) {
          finalized = true;
        } else {
          console.error(`attended: finalize did not succeed (exit ${tailCode}).`);
          code = tailCode;
        }
      } else {
        console.log("attended: finalize declined — nothing pushed.");
      }
    }
  }
}

finish(outcome, finalized, code);
