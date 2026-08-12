// Attended spec loop (issue #59). The THIRD entry point: `agent-workflows
// implement-spec <spec-issue>` builds a WHOLE spec from the developer's terminal —
// its tracer-bullets one at a time, in topological order, on one shared worktree.
//
// Unlike the unattended orchestrator (which dispatches one slice per webhook and
// waits for the next), this loop drives itself off the pure `spec-step` brain:
// select the next slice, build it, gate it, merge it, CONFIRM the merge from
// GitHub, advance, repeat. Labelling-as-dispatch disappears — labels are still
// written as state, but they are no longer the transport. The whole sequence still
// runs through the SAME `implement` sequence CI runs and the SAME `spec-step` /
// `spec-advance` helpers, so a spec started locally lands with the same git history
// and tracker state as one run in CI.
//
// One worktree per spec, created on the spec branch and bootstrapped ONCE, with each
// slice branching inside it from the accumulated spec-branch HEAD — an eight-slice
// spec pays setup once, not eight times, and mirrors the stacked topology directly.
//
// Two safety properties this loop turns on, because it is the highest-blast-radius
// thing in the feature: a DRY RUN (the default) that runs the loop with every
// irreversible action suppressed and halts where it would first merge, and a merge
// CONFIRMATION read back from GitHub before the loop advances — a queued, blocked,
// or stale merge must not be mistaken for a landed slice. A PREVIEW of the whole
// plan is printed and accepted before the first agent runs.
//
// Credentials come from the developer's already-authenticated `gh` and existing
// agent credentials; this loop neither reads nor writes any secret material.
//
// Issue #60 makes a long run controllable, stoppable, and restartable. The loop
// PAUSES at a checkpoint between slices by default (inspect the accumulated spec
// branch before the next stacks); `--no-pause` runs straight through and
// `--interactive` steers each slice, the two being mutually exclusive. A GRACEFUL
// stop from a second terminal (`--stop`, delivered as SIGTERM) finishes the current
// slice and halts at the next checkpoint, distinct from Ctrl-C's immediate abort.
// RESUME derives entirely from the tracker and the branches — no local file: a slice
// whose PR is already open resumes at its gate rather than re-running the agent, and
// the worktree is removed only once the final spec PR opens (retained on every halt).
//
// Issue #61 puts a CEILING on a run — the most it may spend before a human sees it
// again: slices attempted, wall-clock, or both, configured in the same config file
// with the usual per-run env override. It is evaluated at each checkpoint, so a
// reached ceiling halts CLEANLY between slices (never mid-slice) — the same clean
// stop as a graceful stop, distinct from a failure, and resume picks it up. Absent
// configuration there is no ceiling; the run reports what it consumed on exit.
//
// Issue #62 makes a long run legible while it happens and after it ends, with two
// independent, optional pieces. An append-only RUN LOG under the worktree root
// records every transition (slice, action, outcome, timestamp); it is WRITTEN, never
// consulted — resume still derives entirely from the tracker and the branches, so it
// does not reintroduce local state. And when the loop runs inside a HERDR-managed
// pane it emits best-effort progress into the UI already on screen — renaming the
// pane to the slice being built and firing a notification on halt or completion.
// Both are strictly best-effort: outside a Herdr pane nothing is emitted, and no
// rename, notification, or log write ever fails or delays the run.
//
// A real run also holds the LOCAL-RUN MARKER (`agent:local`) on the spec issue for
// its whole length. Merging a slice PR into the spec branch is precisely the event
// unattended `advance` triggers on, so without the marker every local merge would
// start CI on the next tracer-bullet — the slice this loop is about to build itself.
// The marker makes that ownership explicit and CI advance stands down while it is
// held; it is claimed before the first merge, released with the lock on every exit,
// and reclaimed by the next run when a crash left it behind (`shared/spec-marker.mts`).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../shared/config.mts";
import { listIssues, remoteBranches, issueLabels, type RawIssue } from "../shared/spec-tracker.mts";
import { tracerBullets } from "../shared/spec-graph.mts";
import { DEPENDENCY_EDGES } from "../shared/spec-tree.mts";
import { specStep, type SpecAction } from "../shared/spec-step.mts";
import { renderProgress } from "../shared/spec-report.mts";
import { awaitChecks } from "../shared/poll-checks.mts";
import { addLabel, comment, ensureLabel, removeLabel, resolveRepoSlug } from "../shared/github.mts";
import {
  LOCAL_RUN_LABEL,
  LOCAL_RUN_LABEL_DESCRIPTION,
  markerPresent,
  markerAcquired,
  markerReleased,
  markerUnverified,
} from "../shared/spec-marker.mts";
import { slugify } from "../shared/text.mts";
import {
  closeTracerBullet,
  openFinalPr,
  fetchSpecChecks,
  fetchSlicePrChecks,
  mergeSlicePr,
  specBranchHaltMessage,
} from "../shared/spec-advance.mts";
import { acquireLock, lockPath, readLockOwner, releaseLock } from "./lock.mts";
import { runLogPath, appendRunLine } from "./run-log.mts";
import { parseSequenceState, type SequenceState } from "./sequence-state.mts";
import { createHerdrSurface } from "./herdr.mts";
import {
  resolveOrder,
  formatPreview,
  formatSliceHeader,
  formatSliceFooter,
  formatSpecSummary,
  parseMergeView,
  mergeConfirmed,
  mergeHaltReason,
  dryRunSuppressed,
  specBranchCutCommands,
  sliceRefusedHaltReason,
  specFlagConflict,
  sliceDisposition,
  formatCheckpoint,
  checkpointPrompt,
  gracefulStopAcknowledged,
  gracefulStopHaltReason,
  formatResumeGate,
  formatAlreadyMerged,
  ceilingReached,
  hasCeiling,
  type PrMergeView,
  type SpecPlan,
} from "./spec-loop.mts";

const specArg = process.argv[2];
if (!specArg || !/^\d+$/.test(specArg)) {
  console.error(
    "spec-loop: usage: agent-workflows implement-spec <spec-issue> " +
      "[--execute] [--force] [--no-pause] [--interactive] [--stop]",
  );
  process.exit(2);
}
const specNum = Number(specArg);
// The safer default is DRY (issue #59): the loop reports what a real run would do
// and halts where it would first merge. `--execute` opts into real merges into the
// spec branch; `--dry-run` is accepted for explicitness but is already the default.
const execute = process.argv.includes("--execute");
const dryRun = !execute;
// `--force` overrules the local lock (the mutex between two terminals) and is
// threaded to each slice's guards so a preflight refusal is overruled too.
const force = process.argv.includes("--force");
// Checkpoints (issue #60): the loop pauses between slices by DEFAULT — the
// checkpoint where the developer inspects the accumulated spec branch before the
// next slice stacks on it. `--no-pause` runs the whole spec straight through.
const runThrough = process.argv.includes("--no-pause");
// `--interactive` hands each slice's implement run to a LIVE agent session (issue
// #58, per-slice here) so the developer steers every slice. It is mutually exclusive
// with `--no-pause` — one stops at every slice, the other never stops.
const interactive = process.argv.includes("--interactive");
// `--stop` is the graceful-stop CONTROL command, run from a SECOND terminal (the
// running one is occupied): it signals the live loop to finish its current slice and
// halt at the next checkpoint, rather than starting a run of its own.
const stop = process.argv.includes("--stop");

const flagConflict = specFlagConflict({ interactive, runThrough });
if (flagConflict) {
  console.error(flagConflict);
  process.exit(2);
}

function run(file: string, args: readonly string[], cwd?: string, env?: Record<string, string>) {
  return spawnSync(file, [...args], { stdio: "inherit", cwd, env: { ...process.env, ...env } });
}

// `cwd` is explicit for every git command that WRITES: a write issued in the ambient
// cwd lands in the developer's own checkout, which is the one place this loop
// promises never to touch. Reads (`git rev-parse origin/HEAD`) and the worktree
// removal must run in the main checkout, so the parameter is optional, not forced.
function capture(file: string, args: readonly string[], cwd?: string): string {
  const child = spawnSync(file, [...args], { encoding: "utf8", cwd });
  if (child.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} exited ${child.status ?? "with a signal"}`);
  }
  return child.stdout.trim();
}

// A single-line yes/no prompt read from the terminal — the same shape the attended
// entry point uses. A non-interactive stdin or a bare Enter declines (the safe
// default), so the preview is never bypassed silently.
function confirm(question: string): boolean {
  process.stdout.write(question);
  const res = spawnSync("bash", ["-c", 'read -r reply; printf "%s" "$reply"'], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  const answer = (res.stdout ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// The outcome the slice's sequence just reported. An unreadable or absent file means
// "nothing reported" — an empty state, never a refusal, so a missing file can only
// make the loop proceed as it did before, not invent a halt.
function readSliceState(): SequenceState {
  try {
    return parseSequenceState(readFileSync(sliceStateFile, "utf8"));
  } catch {
    return {};
  }
}

function closedSet(issues: RawIssue[]): Set<number> {
  return new Set(issues.filter((i) => i.state === "CLOSED").map((i) => i.number));
}

// The base the spec branch is cut from: a configured base wins; otherwise the
// repository default (`origin/HEAD`). Mirrors the attended entry point's resolver.
function resolveBase(configured: string): string {
  if (configured) return configured;
  try {
    return capture("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    return "";
  }
}

const config = resolveConfig();
// `owner/name` for the hooks each slice runs (GH_REPO). Resolved once, from the env
// or the checkout's origin remote.
const repoSlug = resolveRepoSlug();
// The run ceiling (issue #61): the most this run may spend before a human sees it
// again — slices attempted, wall-clock, or both. Resolved by the standard precedence
// (env override → config file → unset); absent all, it is empty ({}) and the loop is
// unbounded exactly as before. Evaluated at each checkpoint, so a reached ceiling
// halts cleanly between slices, never mid-slice.
const ceiling = config.runCeiling;
const base = resolveBase(config.baseBranch);
const root = config.worktreeRoot;
const tree = join(root, `spec-${specNum}`);
const lock = lockPath(root, `implement-spec-${specNum}`);
// The scratch file the slice's implement sequence writes its spec body to (its
// fetch-spec requires it) — the local stand-in for the path the reusable workflow
// resolves under $RUNNER_TEMP. Reused across slices; each slice overwrites it.
const specFile = join(tmpdir(), `agent-workflows-spec-loop-${process.pid}-spec.md`);
// Where each slice's sequence reports its outcome back to this loop. Reused across
// slices; each slice overwrites it, and it is read immediately after that slice's
// sequence exits.
const sliceStateFile = join(tmpdir(), `agent-workflows-spec-loop-${process.pid}-state`);

// The append-only run log (issue #62): every transition the loop makes is appended
// here — slice, action, outcome, timestamp — so a run that halts at 2am leaves
// something to read in the morning. It lives under the worktree ROOT (not inside the
// per-spec worktree, which is removed on completion), so it survives both a halt and
// a completed run's cleanup. It is WRITTEN, never consulted: nothing reads it to
// decide what happens next, so it does not reintroduce local state.
const runLog = runLogPath(root, specNum);
function record(slice: number | null, action: string, outcome: string): void {
  appendRunLine(runLog, { timestamp: new Date().toISOString(), slice, action, outcome });
}

// The optional Herdr progress surface (issue #62): when the loop runs inside a
// Herdr-managed pane, it renames the pane to the slice being built and fires a
// notification on halt or completion. Strictly best-effort — outside a pane it is a
// silent no-op, and every emit swallows all errors (including the `herdr` CLI being
// absent), so no rename or notification can ever fail or delay the run. No new
// required dependency: detection is a plain env read and emission only shells out
// when the environment says a pane is present.
const herdr = createHerdrSurface(process.env, (file, args) =>
  spawnSync(file, [...args], { stdio: "ignore" }),
);

// `--stop` (issue #60): the graceful-stop control command. Run from a SECOND
// terminal, it finds the live loop through the pid the lock records and delivers a
// SIGTERM — the running loop finishes its current slice and halts at the next
// checkpoint. It starts no run of its own, so it returns before any worktree, lock,
// or tracker work. (Ctrl-C in the running terminal is the immediate abort instead.)
if (stop) {
  const owner = readLockOwner(lock);
  if (owner === null) {
    console.error(
      `spec-loop: no running spec loop found for #${specNum} (no lock at ${lock}). ` +
        `Nothing to stop.`,
    );
    process.exit(1);
  }
  try {
    process.kill(owner, "SIGTERM");
    console.log(
      `spec-loop: graceful stop requested for #${specNum} (pid ${owner}) — it will finish ` +
        `the current slice and halt at the next checkpoint.`,
    );
    process.exit(0);
  } catch (err) {
    console.error(
      `spec-loop: could not signal the running loop (pid ${owner}): ${(err as Error).message}`,
    );
    process.exit(1);
  }
}

// Ctrl-C: survive the signal so the loop can print its summary and leave the
// worktree on disk (the child in the same process group still dies). This is the
// IMMEDIATE abort — mid-slice it abandons a half-built tracer-bullet for resume to
// untangle.
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

// SIGTERM is the GRACEFUL stop (issue #60), delivered by a second terminal's
// `--stop`. It is signalled at THIS process only (not the child's process group), so
// the current slice's build runs to completion; the loop reads the flag at its next
// checkpoint and halts there cleanly, leaving a resumable between-slices boundary.
let gracefulStop = false;
process.on("SIGTERM", () => {
  if (!gracefulStop) {
    gracefulStop = true;
    console.log(gracefulStopAcknowledged());
  }
});

// The spec's title (for the spec-branch name) and its tracer-bullets, resolved from
// the tracker up front — the whole plan the preview shows.
const specTitle = JSON.parse(
  capture("gh", ["issue", "view", specArg, "--json", "title"]),
).title as string;
const specBranch = `agent/spec-${specNum}-${slugify(specTitle)}`;
const issues0 = listIssues();
// The same edge rules as the unattended orchestrator (#99).
const bullets0 = tracerBullets(specNum, issues0, DEPENDENCY_EDGES);
const { order, deadlocked } = resolveOrder(bullets0);

const plan: SpecPlan = { spec: specNum, specBranch, base, order, deadlocked, dryRun };

// The preview — the blast radius, visible before it is incurred. The run does not
// begin until it is accepted.
console.log(formatPreview(plan));
if (order.length === 0) {
  console.log("spec-loop: no ready tracer-bullets to build — nothing to do.");
  process.exit(0);
}
if (!confirm(`spec-loop: proceed with ${dryRun ? "this DRY RUN" : "REAL merges"}? [y/N] `)) {
  console.log("spec-loop: declined — nothing done.");
  process.exit(0);
}

mkdirSync(root, { recursive: true });

// The local lock (the mutex between two terminals) keyed by the spec, so two specs
// never collide. `--force` takes over a live holder; a stale lock is cleared.
const acquired = acquireLock(lock, process.pid, { force });
if (!acquired.acquired) {
  console.error(
    `spec-loop: another local run holds the lock at ${lock}` +
      (acquired.heldBy ? ` (pid ${acquired.heldBy})` : "") +
      `. Re-run with --force to take it over.`,
  );
  process.exit(1);
}
if (acquired.clearedStale) {
  console.log(`spec-loop: cleared a stale lock at ${lock} (its owner was gone).`);
}

// The end-of-run accounting the summary reports.
const built: number[] = [];
let halted: { slice: number; reason: string } | null = null;
let finalPrOpened = false;
// Run-ceiling accounting (issue #61). `runStart` clocks the run's wall-clock from
// here — after the preview is accepted and the lock is held, so human think-time at
// the prompt does not count against the ceiling but every slice, the bootstrap, and
// the worktree setup do. `slicesAttempted` counts only slices this run genuinely
// built or gated (not an already-merged catch-up on resume), so resume makes progress
// rather than re-halting on a ceiling it already reached.
const runStart = Date.now();
let slicesAttempted = 0;
function elapsedSeconds(): number {
  return Math.round((Date.now() - runStart) / 1000);
}

// ── The local-run marker ────────────────────────────────────────────────────────
//
// The THIRD mutex, and the only one that reaches across to CI. The lock arbitrates
// between two local terminals and `agent:in-progress` between entry points on one
// issue; neither covers what this loop newly does — MERGE slice PRs into the spec
// branch. That merge is exactly the event unattended `advance` triggers on, and
// advance responds by labelling the next tracer-bullet `agent:implement`, so without
// a marker CI starts building slice two while this loop is about to build it.
//
// The marker is held for the length of a real run and released with the lock, so a
// crashed loop cannot silently disable CI advance for a spec forever: the next run
// holds the lock (proving no live local run owns the marker) and RECLAIMS it. A DRY
// RUN never merges, so it never fires advance and never takes the marker.
let markerHeld = false;

// The spec's labels, or null when they cannot be read (a `gh` hiccup) — the caller
// treats null as "unknown", never as "absent".
function readSpecLabels(): string[] | null {
  try {
    return issueLabels(specNum);
  } catch {
    return null;
  }
}

// Claim the marker before the first merge. A marker already there is stale by
// construction (this run holds the lock), so it is reclaimed rather than refused.
// The claim is VERIFIED, unlike every other label edit in the fleet: an unapplied
// marker means CI races every merge this run makes, so it halts before the first one.
function acquireMarker(): void {
  if (dryRun) return;
  ensureLabel(LOCAL_RUN_LABEL, LOCAL_RUN_LABEL_DESCRIPTION);
  const before = readSpecLabels();
  const reclaimed = before !== null && markerPresent(before);
  if (!reclaimed) addLabel("issue", specArg, LOCAL_RUN_LABEL);
  const after = readSpecLabels();
  if (after !== null && !markerPresent(after)) {
    const reason = markerUnverified(specNum);
    console.error(reason);
    halted = {
      slice: specNum,
      reason: `\`${LOCAL_RUN_LABEL}\` could not be applied to the spec issue`,
    };
    finish(1);
  }
  markerHeld = true;
  console.log(markerAcquired({ spec: specNum, reclaimed }));
  record(null, "marker", reclaimed ? "reclaimed a stale marker" : "claimed");
}

// Release the marker — on completion, on every halt, and on abort, from the single
// exit that already releases the lock. Idempotent and best-effort: a marker left by a
// kill -9 is reclaimed by the next run instead.
function releaseMarker(): void {
  if (!markerHeld) return;
  markerHeld = false;
  removeLabel("issue", specArg, LOCAL_RUN_LABEL);
  console.log(markerReleased(specNum));
  record(null, "marker", "released");
}

// Settle the run: release the lock, print the summary, and exit. The worktree is
// REMOVED only once the final spec PR opens — the run is complete and the spec
// branch lives on the remote (issue #60). On every halt (a failure, an abort, a
// graceful stop, a checkpoint decline, a dry run) it is RETAINED: it holds the
// accumulated spec branch and is exactly what the developer inspects, and resume
// reuses it as-is.
function finish(code: number, opts: { removeWorktree?: boolean } = {}): never {
  // The marker goes back with the lock — one lifecycle, so success, failure, a
  // graceful stop, a checkpoint decline, and a Ctrl-C abort all hand the spec back
  // to CI. (A completed run releases it after the final PR is open, so an advance
  // fired by the last merge that lands here late finds that PR already open —
  // `openFinalPr` is idempotent.)
  releaseMarker();
  releaseLock(lock);
  // Record the terminal transition (issue #62) and, best-effort, fire the Herdr
  // notification for it. This is the single exit, so every halt and every completion
  // is captured here once. A dry run's halt-before-merge and the deadlocked "done"
  // exit are captured too; only a completion (final PR opened) notifies success.
  if (halted) {
    record(halted.slice, "halt", halted.reason);
    herdr.notifyHalt({ spec: specNum, reason: halted.reason });
  } else if (finalPrOpened) {
    record(null, "complete", "final PR opened");
    herdr.notifyComplete({ spec: specNum });
  }
  console.log("");
  console.log(
    formatSpecSummary({
      spec: specNum,
      specBranch,
      dryRun,
      merged: built,
      halted,
      finalPrOpened,
      // Report what was consumed against the ceiling on exit (issue #61) — only when
      // a ceiling was configured, so an unbounded run's summary is unchanged.
      ceiling: hasCeiling(ceiling)
        ? {
            slicesAttempted,
            maxSlices: ceiling.maxSlices,
            elapsedSeconds: elapsedSeconds(),
            maxWallClockSeconds: ceiling.maxWallClockSeconds,
          }
        : null,
      // Surface the run log so it is discoverable from the summary (issue #62).
      runLog,
    }),
  );
  if (opts.removeWorktree && existsSync(tree)) {
    try {
      capture("git", ["worktree", "remove", "--force", tree]);
      console.log(`worktree: removed ${tree} (the final spec PR is open).`);
    } catch {
      console.log(`worktree: retained at ${tree} (could not remove it automatically).`);
    }
  } else if (existsSync(tree)) {
    console.log(`worktree: retained at ${tree}`);
  }
  process.exit(code);
}

// Create the one worktree for the whole spec, detached at the base, and bootstrap
// it ONCE. A pre-existing tree (a re-run) is reused as-is.
if (existsSync(tree)) {
  console.log(`spec-loop: reusing existing worktree at ${tree}`);
  record(null, "worktree", `reused ${tree}`);
} else {
  console.log(`spec-loop: creating worktree at ${tree} (detached at ${base || "HEAD"})`);
  if (base) {
    try {
      capture("git", ["fetch", "origin", base]);
    } catch {
      /* a fetch failure surfaces at worktree add / the slice run */
    }
  }
  const added = run("git", ["worktree", "add", "--detach", tree, base ? `origin/${base}` : "HEAD"]);
  if (added.status !== 0) {
    console.error(`spec-loop: could not create the worktree (git exited ${added.status}).`);
    halted = { slice: specNum, reason: "the worktree could not be created" };
    finish(1);
  }
  record(null, "worktree", `created ${tree}`);
}

if (config.bootstrap) {
  console.log(`spec-loop: bootstrapping worktree: ${config.bootstrap}`);
  const boot = run("bash", ["-eo", "pipefail", "-c", config.bootstrap], tree);
  if (boot.status !== 0 || interrupted || boot.signal) {
    console.error("spec-loop: bootstrap did not succeed — not starting the loop.");
    halted = { slice: specNum, reason: "bootstrap did not succeed" };
    finish(interrupted || boot.signal ? 130 : boot.status || 1);
  }
}

// Claim the local-run marker before ANYTHING reaches the remote — well before the
// first merge, which is the event that would otherwise start CI on the next slice.
// A dry run skips this: it never merges, so it never fires advance.
acquireMarker();

// Cut and push the spec branch off the base if it does not exist yet — the same cut
// the unattended kickoff does, so each slice's fetch-spec resolves it as the base to
// stack on. A DRY RUN never touches the remote: it reports the suppressed cut and
// builds the first slice on the base (identical to a freshly-cut, empty spec branch)
// before halting at the merge.
if (!remoteBranches().includes(specBranch)) {
  if (dryRun) {
    console.log(dryRunSuppressed(`cut and push the spec branch ${specBranch} off ${base || "the default branch"}`));
    record(null, "spec-branch", "cut suppressed (dry run)");
  } else {
    // Every command runs IN THE WORKTREE (see `specBranchCutCommands`): issued in the
    // ambient cwd they would move the developer's own checkout onto the spec branch,
    // and git would then refuse to check that branch out here, where the slices build.
    for (const cmd of specBranchCutCommands({ specBranch, base, tree })) {
      capture(cmd.file, cmd.args, cmd.cwd);
    }
    record(null, "spec-branch", `cut off ${base || "the default branch"}`);
  }
}

// The loop. Each iteration recomputes the live slice set (a late-added slice is
// picked up) and asks the SAME `spec-step` brain the unattended path uses what
// happens next — kickoff for the first slice, advance (with the spec-branch CI
// gate) thereafter. `lastMerged` is folded into `closed` to guard against issue-list
// lag right after a merge.
let phase: "kickoff" | "advance" = "kickoff";
let lastMerged: number | null = null;

// Read the slice PR's merged/open state back from GitHub — the SOLE resume signal
// (issue #60), preferring a merged PR when several share the head. No local file is
// consulted, so a spec interrupted under either entry point resumes identically.
function readSlicePr(sliceBranch: string): PrMergeView | null {
  return parseMergeView(
    capture("gh", [
      "pr",
      "list",
      "--head",
      sliceBranch,
      "--base",
      specBranch,
      "--state",
      "all",
      "--json",
      "number,state,mergedAt,baseRefName",
    ]),
  );
}

// CONFIRM the slice's merge from GitHub, then close the tracer-bullet and advance —
// the shared tail of building a slice, resuming its gate, and picking up an
// already-merged one. The PR's own merged state into the spec branch is the signal
// (closing is failure-tolerant); a queued, blocked, or stale merge halts the run.
function landSlice(slice: number, sliceBranch: string): void {
  const pr = readSlicePr(sliceBranch);
  if (!mergeConfirmed(pr, specBranch)) {
    const reason = mergeHaltReason(pr, slice, specBranch);
    comment("issue", specArg, reason);
    console.error(reason);
    halted = { slice, reason: "the merge was not confirmed on GitHub" };
    console.log(formatSliceFooter({ slice, outcome: "built" }));
    finish(1);
  }
  // The merge into a non-default base did not auto-close the tracer-bullet.
  closeTracerBullet(slice, specBranch);
  built.push(slice);
  console.log(formatSliceFooter({ slice, outcome: "merged" }));
  record(slice, "merge", `merged into ${specBranch}`);
  lastMerged = slice;
  phase = "advance";
}

async function drive(): Promise<never> {
  for (;;) {
    if (interrupted) {
      halted = { slice: lastMerged ?? specNum, reason: "interrupted (Ctrl-C)" };
      finish(130);
    }

    const issuesN = listIssues();
    const bulletsN = tracerBullets(specNum, issuesN, DEPENDENCY_EDGES);
    const closedN = closedSet(issuesN);
    if (lastMerged !== null) closedN.add(lastMerged);

    // Decide the next action. On advance, gate the spec-branch tip's CI (fix 2)
    // before begetting the next slice — exactly as the unattended advance does.
    let action: SpecAction;
    if (phase === "kickoff") {
      action = specStep({ phase: "kickoff", bullets: bulletsN, closed: closedN });
    } else {
      action = specStep({ phase: "advance", bullets: bulletsN, closed: closedN });
      if (action.type === "await-checks") {
        if (dryRun) {
          console.log(dryRunSuppressed(`gate the ${specBranch} tip CI before the next slice`));
          finish(0);
        }
        const passed = await awaitChecks(() => fetchSpecChecks(specBranch));
        action = specStep({ phase: "advance", bullets: bulletsN, closed: closedN, checksPassed: passed });
      }
    }

    if (action.type === "halt") {
      const reason = specBranchHaltMessage(specBranch, action.blocked);
      comment("issue", specArg, reason);
      console.error(reason);
      halted = { slice: action.blocked ?? (lastMerged ?? specNum), reason: "the spec-branch tip CI did not pass" };
      finish(1);
    }
    if (action.type === "open-final-pr") {
      if (dryRun) {
        console.log(dryRunSuppressed(`open the final ${specBranch} → ${base || "default"} PR`));
        finish(0);
      }
      openFinalPr(specNum, specBranch);
      finalPrOpened = true;
      comment(
        "issue",
        specArg,
        renderProgress({ branch: specBranch, bullets: bulletsN, closed: closedN, dispatched: null }),
      );
      console.log(`spec-loop: all slices merged — opened the final PR for ${specBranch}.`);
      // The run is complete and the spec branch lives on the remote, so the worktree
      // is removed here (issue #60) — the only exit that removes it; every halt
      // retains it for inspection and resume.
      finish(0, { removeWorktree: true });
    }
    if (action.type === "done") {
      // No ready slice and not complete — the remainder deadlocked on a cycle. Not a
      // failure; the preview already surfaced the deadlocked slices.
      console.log("spec-loop: no ready slice (the remainder is deadlocked on a dependency cycle).");
      finish(0);
    }

    if (action.type !== "run-slice") {
      // `await-checks` was already resolved above; `merge` never arises on the
      // kickoff/advance phases. Anything else is a contract break — halt loudly.
      console.error(`spec-loop: unexpected action "${action.type}" — halting.`);
      halted = { slice: lastMerged ?? specNum, reason: `unexpected action "${action.type}"` };
      finish(1);
    }

    // action.type === "run-slice": build (or resume) this slice.
    const slice = action.slice;
    const position = built.length + 1;
    console.log(formatSliceHeader({ position, total: order.length, slice, specBranch }));

    const sliceTitle = JSON.parse(
      capture("gh", ["issue", "view", String(slice), "--json", "title"]),
    ).title as string;
    const sliceBranch = `agent/issue-${slice}-${slugify(sliceTitle)}`;

    // Rename the Herdr pane to the slice now in hand (issue #62) — best-effort, a
    // silent no-op outside a Herdr pane. Done before the disposition branches so the
    // pane reflects the current slice whether it is built, resumed, or caught up.
    herdr.renameToSlice({ spec: specNum, slice, position, total: order.length });

    // Resume disposition (issue #60): read the slice's PR state back from GitHub
    // BEFORE running the agent. An already-merged slice is pure catch-up on resume —
    // advance without work, and without a checkpoint (there is nothing new to
    // inspect). A dry run never inspects or merges; it always builds.
    const existing = dryRun ? null : readSlicePr(sliceBranch);
    const disposition = dryRun ? "build" : sliceDisposition(existing, specBranch);
    if (disposition === "already-merged" && existing) {
      console.log(formatAlreadyMerged({ slice, pr: existing.number, specBranch }));
      record(slice, "resume", "already merged — advancing without rebuilding");
      landSlice(slice, sliceBranch);
      continue;
    }

    // Checkpoint before genuinely NEW work stacks on the spec branch (issue #60) — a
    // build or a resumed gate merge, not an already-merged catch-up. The developer
    // inspects the accumulated branch here before the next slice stacks — the control
    // that makes a parity finalize acceptable. The first slice never pauses (the
    // preview already gated the start). A graceful stop halts here even under
    // --no-pause; --no-pause otherwise runs straight through. A dry run halts at the
    // first merge, so it never reaches a between-slices checkpoint.
    if (built.length > 0) {
      console.log(formatCheckpoint({ lastMerged: lastMerged ?? slice, next: slice, specBranch }));
      // Run ceiling (issue #61): a reached ceiling halts here CLEANLY — the same
      // clean stop as a graceful stop, distinct from a failure (exit 0), and
      // resume picks it up. Checked at the checkpoint so the halt is between
      // slices, never mid-slice, and BEFORE the graceful-stop / --no-pause gates so
      // that even a straight-through run cannot spend past its ceiling.
      const ceilingReason = ceilingReached(ceiling, {
        slicesAttempted,
        elapsedSeconds: elapsedSeconds(),
      });
      if (ceilingReason) {
        console.log(ceilingReason);
        halted = { slice: lastMerged ?? slice, reason: ceilingReason };
        finish(0);
      }
      if (gracefulStop) {
        halted = { slice: lastMerged ?? slice, reason: gracefulStopHaltReason(lastMerged) };
        finish(0);
      }
      if (!runThrough && !confirm(checkpointPrompt(slice))) {
        halted = { slice, reason: "paused at a checkpoint — re-run to resume" };
        finish(0);
      }
    }

    // Resume at the gate (issue #60): a slice whose PR is already open is merged here
    // — await its checks, then merge — rather than re-running the agent, which would
    // be the most expensive mistake the loop could make.
    if (disposition === "resume-gate" && existing) {
      console.log(formatResumeGate({ slice, pr: existing.number, specBranch }));
      record(slice, "resume-gate", `awaiting checks on the already-open PR #${existing.number}`);
      const passed = await awaitChecks(() => fetchSlicePrChecks(existing.number));
      if (!passed) {
        const reason =
          `⛔ slice #${slice}: the resumed PR #${existing.number} CI did not pass — not merged ` +
          `into \`${specBranch}\`. Halting; the next slice is NOT built.`;
        comment("issue", specArg, reason);
        console.error(reason);
        halted = { slice, reason: "the resumed slice PR CI did not pass" };
        console.log(formatSliceFooter({ slice, outcome: "built" }));
        finish(1);
      }
      mergeSlicePr(existing.number);
      landSlice(slice, sliceBranch);
      // A resumed gate merge is genuine work this run — it counts against the ceiling
      // (issue #61), unlike an already-merged catch-up above.
      slicesAttempted++;
      continue;
    }

    // The progress comment, posted each iteration so the spec does not read as
    // abandoned. A DRY RUN reports it as suppressed rather than posting.
    if (dryRun) {
      console.log(dryRunSuppressed(`post the progress comment on spec #${specNum} (building #${slice})`));
    } else {
      comment(
        "issue",
        specArg,
        renderProgress({ branch: specBranch, bullets: bulletsN, closed: closedN, dispatched: slice }),
      );
    }

    // Build the slice with the SAME implement sequence CI runs. A real run's
    // finalize opens the slice PR, gates its own CI (fix 1), and merges it into the
    // spec branch. A dry run passes FINALIZE_MODE=never, so the sequence stops with
    // the commits on the slice branch — nothing reaches GitHub.
    const buildEnv: Record<string, string> = {
      ISSUE_NUMBER: String(slice),
      ISSUE_TITLE: sliceTitle,
      SPEC_FILE: specFile,
      ANNOUNCE_REFUSALS: "false",
    };
    // The hooks require GH_REPO; in CI the workflow supplies `github.repository`,
    // and an attended run has no workflow — so it is derived from the checkout's
    // own origin remote. Without it the slice's FIRST hook refuses, which surfaces
    // here as an unconfirmed merge rather than as the missing variable it is.
    if (repoSlug) buildEnv.GH_REPO = repoSlug;
    if (force) buildEnv.FORCE = "true";
    if (dryRun) buildEnv.FINALIZE_MODE = "never";
    // `--interactive` (issue #60): each slice's implement run hands over a live agent
    // session so the developer steers it. Per-slice by design — and mutually
    // exclusive with --no-pause, rejected up front.
    if (interactive) buildEnv.INTERACTIVE = "true";
    // Ask the sequence to report its OUTCOME back here. A guard refusal exits 0 (a
    // refusal must leave CI green), so the exit code alone cannot distinguish
    // "refused, built nothing" from "ran and succeeded" — and the loop would then
    // blame the merge for a decision taken at the sequence's first step.
    buildEnv.SEQUENCE_STATE_FILE = sliceStateFile;
    // Clear it first: the file is reused across slices, and a sequence that exits 0
    // WITHOUT writing one — a worktree whose packaged sequencer predates this seam is
    // the realistic case, since the worktree runs the checked-out commit's code, not
    // this one — would otherwise leave the loop reading the PREVIOUS slice's outcome.
    rmSync(sliceStateFile, { force: true });
    record(slice, "build", "running the implement sequence");
    const build = run("yarn", ["sandcastle:implement-sequence"], tree, buildEnv);

    // Rely on the existing zero-commit exit-code check (implement.mts exits non-zero
    // when the agent produced no commits) rather than reimplementing it. A failed
    // slice halts the whole run — no skip, no retry — since every later slice
    // assumes the earlier ones landed.
    if (build.status !== 0 || interrupted || build.signal) {
      halted = {
        slice,
        reason: `the implement run did not succeed (exit ${build.status ?? "signal"})`,
      };
      console.log(formatSliceFooter({ slice, outcome: "built" }));
      finish(interrupted || build.signal ? 130 : build.status || 1);
    }

    // A REFUSED sequence exited 0 having built nothing. Halt on the refusal itself,
    // naming the step that declined — not on the merge that could never have happened.
    const sliceState = readSliceState();
    if (sliceState.outcome === "refused") {
      const reason = sliceRefusedHaltReason({ slice, step: sliceState.step ?? "" });
      console.error(reason);
      halted = { slice, reason: `the implement sequence refused at \`${sliceState.step ?? "?"}\`` };
      record(slice, "refused", `the sequence refused at ${sliceState.step ?? "?"}`);
      console.log(formatSliceFooter({ slice, outcome: "refused" }));
      finish(1);
    }

    if (dryRun) {
      // Report every irreversible action a real run would take here, then halt where
      // it would first merge — a stacked slice cannot proceed without landing.
      console.log(dryRunSuppressed(`open a PR for ${sliceBranch} → ${specBranch}`));
      console.log(dryRunSuppressed(`merge that PR into ${specBranch} once its CI is green`));
      console.log(dryRunSuppressed(`close tracer-bullet #${slice}`));
      if (position === order.length) {
        console.log(dryRunSuppressed(`open the final ${specBranch} → ${base || "default"} PR`));
      }
      console.log(formatSliceFooter({ slice, outcome: "would-merge" }));
      record(slice, "build", "built (dry run — merge suppressed)");
      built.push(slice);
      halted = { slice, reason: "dry run — stopped before the first real merge" };
      finish(0);
    }

    // Real run: the finalize opened the slice PR, gated its own CI, and merged it —
    // now CONFIRM that merge from GitHub, close the tracer-bullet, and advance.
    landSlice(slice, sliceBranch);
    // The slice was built and landed this run — it counts against the ceiling (issue
    // #61), evaluated at the next slice's checkpoint.
    slicesAttempted++;
  }
}

await drive();
