// Attended local sequencer (issue #55). The SECOND entry point: `agent-workflows
// <verb> <issue-number>` runs a verb on the developer's own machine, streaming to
// the terminal, delivered first for the read-only `explore` verb so nothing can be
// pushed while the entry point is new.
//
// It creates a git worktree UNDER the configured root — never the checkout the
// developer is sitting in — invokes the repo's own opaque bootstrap command to make
// that tree runnable, then hands the SAME sequence the reusable workflow runs to the
// sequencer inside the worktree (`yarn sandcastle:<verb>-sequence`), so the attended
// and unattended paths share one implementation and cannot drift. On success the
// worktree is removed; on failure or a Ctrl-C abort it is retained, because the
// failed tree is exactly what the developer wants to inspect.
//
// Credentials come from the developer's already-authenticated `gh` and existing
// agent credentials, inherited through the ambient environment: this sequencer
// neither reads nor writes any secret material.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreePath, retainWorktree, type LocalOutcome } from "./plan.mts";
import { acquireLock, lockPath, releaseLock } from "./lock.mts";
import { resolveConfig } from "../shared/config.mts";
import { IN_PROGRESS_LABEL } from "../shared/github.mts";

// Only the read-only `explore` verb is delivered for attended runs so far (the
// entry point cannot push anything). The other verbs collapse onto this path once
// it has proven out.
const ATTENDED_VERBS = new Set(["explore"]);

const verb = process.argv[2];
const issue = process.argv[3];
// `--force` overrules a guard refusal AND both concurrency mutexes (issue #56):
// the `agent:in-progress` label and the local lock. The single flag a developer
// uses to start a run they know is safe despite a preflight or a mutex saying no.
const force = process.argv.includes("--force");
if (!verb || !issue) {
  console.error("attended: usage: agent-workflows <verb> <issue-number> [--force]");
  process.exit(2);
}
if (!ATTENDED_VERBS.has(verb)) {
  console.error(
    `attended: "${verb}" is not available for local runs yet — only ${[...ATTENDED_VERBS].join(", ")}.`,
  );
  process.exit(2);
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

// Remove the worktree on a clean end; retain it on failure or abort so the
// developer can open exactly what the run produced. The lock is ALWAYS released —
// on success, failure, and abort alike — so a retained failure tree never wedges
// the key for the next run.
function cleanup(outcome: LocalOutcome): void {
  releaseLock(lock);
  if (retainWorktree(outcome)) {
    console.log(`attended: ${verb} #${issue} ${outcome} — worktree retained at ${tree}`);
    return;
  }
  const removed = run("git", ["worktree", "remove", "--force", tree]);
  if (removed.status !== 0) {
    console.error(`attended: worktree left at ${tree} (git worktree remove exited ${removed.status}).`);
  }
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
    cleanup(outcome);
    process.exit(outcome === "aborted" ? 130 : boot.status || 1);
  }
}

// Hand the whole verb sequence to the sequencer INSIDE the worktree — the exact
// command the reusable workflow runs — so the attended run posts the same
// exploration comment as the unattended path. The issue context and scratch-file
// paths are threaded through the environment the hooks read.
//
// Two attended-only signals ride along: `ANNOUNCE_REFUSALS=false` tells a guard
// refusal to print its reason to the terminal and post NOTHING to the tracker
// (state labels are still written normally); `FORCE` relaxes the guards step to
// tolerated so a refusal is overruled rather than halting the run.
const runEnv: Record<string, string> = {
  ISSUE_NUMBER: issue,
  ISSUE_TITLE: issueTitle,
  SPEC_FILE: specFile,
  COMMENT_FILE: commentFile,
  ANNOUNCE_REFUSALS: "false",
};
if (force) runEnv.FORCE = "true";
const child = spawnSync("yarn", [`sandcastle:${verb}-sequence`], {
  stdio: "inherit",
  cwd: tree,
  env: { ...process.env, ...runEnv },
});
if (child.error) {
  console.error(`attended: failed to launch the ${verb} sequence:`, child.error);
  cleanup("failed");
  process.exit(1);
}

const outcome = outcomeOf(child.status, child.signal);
cleanup(outcome);

switch (outcome) {
  case "succeeded":
    console.log(`attended: ${verb} #${issue} completed.`);
    process.exit(0);
  case "aborted":
    console.log(`attended: ${verb} #${issue} aborted.`);
    process.exit(130);
  case "failed":
    process.exit(child.status || 1);
}
