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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../shared/config.mts";
import { listIssues, remoteBranches, type RawIssue } from "../shared/spec-tracker.mts";
import { tracerBullets } from "../shared/spec-graph.mts";
import { specStep, type SpecAction } from "../shared/spec-step.mts";
import { renderProgress } from "../shared/spec-report.mts";
import { awaitChecks } from "../shared/poll-checks.mts";
import { comment } from "../shared/github.mts";
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

function capture(file: string, args: readonly string[]): string {
  const child = spawnSync(file, [...args], { encoding: "utf8" });
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
const bullets0 = tracerBullets(specNum, issues0);
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

// Settle the run: release the lock, print the summary, and exit. The worktree is
// REMOVED only once the final spec PR opens — the run is complete and the spec
// branch lives on the remote (issue #60). On every halt (a failure, an abort, a
// graceful stop, a checkpoint decline, a dry run) it is RETAINED: it holds the
// accumulated spec branch and is exactly what the developer inspects, and resume
// reuses it as-is.
function finish(code: number, opts: { removeWorktree?: boolean } = {}): never {
  releaseLock(lock);
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

// Cut and push the spec branch off the base if it does not exist yet — the same cut
// the unattended kickoff does, so each slice's fetch-spec resolves it as the base to
// stack on. A DRY RUN never touches the remote: it reports the suppressed cut and
// builds the first slice on the base (identical to a freshly-cut, empty spec branch)
// before halting at the merge.
if (!remoteBranches().includes(specBranch)) {
  if (dryRun) {
    console.log(dryRunSuppressed(`cut and push the spec branch ${specBranch} off ${base || "the default branch"}`));
  } else if (base) {
    capture("git", ["fetch", "origin", base]);
    capture("git", ["checkout", "-B", specBranch, `origin/${base}`]);
    capture("git", ["push", "-u", "origin", specBranch]);
  } else {
    capture("git", ["checkout", "-B", specBranch]);
    capture("git", ["push", "-u", "origin", specBranch]);
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
    const bulletsN = tracerBullets(specNum, issuesN);
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

    // Resume disposition (issue #60): read the slice's PR state back from GitHub
    // BEFORE running the agent. An already-merged slice is pure catch-up on resume —
    // advance without work, and without a checkpoint (there is nothing new to
    // inspect). A dry run never inspects or merges; it always builds.
    const existing = dryRun ? null : readSlicePr(sliceBranch);
    const disposition = dryRun ? "build" : sliceDisposition(existing, specBranch);
    if (disposition === "already-merged" && existing) {
      console.log(formatAlreadyMerged({ slice, pr: existing.number, specBranch }));
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
    if (force) buildEnv.FORCE = "true";
    if (dryRun) buildEnv.FINALIZE_MODE = "never";
    // `--interactive` (issue #60): each slice's implement run hands over a live agent
    // session so the developer steers it. Per-slice by design — and mutually
    // exclusive with --no-pause, rejected up front.
    if (interactive) buildEnv.INTERACTIVE = "true";
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
