// The pure brain + rendering for the attended spec loop (issue #59): the THIRD
// entry point drives a whole spec from the terminal — `agent-workflows
// implement-spec <spec-issue>` — building its tracer-bullets one at a time, in
// topological order, on one shared worktree. This module is to that loop what
// `spec-step.mts` is to the unattended orchestrator: PURE decisions and text, no
// `gh`, no git, no spawning. The driver (spec-loop-run.mts) owns the I/O; the loop
// SEQUENCING itself still delegates to the shared `spec-step` brain, so the local
// and CI paths cannot drift.
//
// Three properties this feature turns on live here as testable functions: the
// PREVIEW printed before anything starts (the blast radius, visible before it is
// incurred), the merge-CONFIRMATION read back from GitHub before the loop advances
// (a queued or blocked merge must not be mistaken for a landed slice), and the
// DRY-RUN reporting of every action a real run would take irreversibly.

import { topologicalOrder, type TracerBullet } from "../shared/spec-graph.mts";
import type { RunCeiling } from "../shared/config.mts";

// The resolved, immutable shape of a spec run the loop is about to drive. Computed
// once for the preview; the loop itself recomputes the live slice set each
// iteration (a late-added slice is picked up), exactly as the unattended path does.
export interface SpecPlan {
  readonly spec: number;
  readonly specBranch: string;
  readonly base: string;
  // The strict topological build order — the slices, one at a time, that the loop
  // will build and merge.
  readonly order: readonly number[];
  // Slices excluded from `order` because they sit in a dependency cycle — surfaced
  // in the preview rather than silently dropped.
  readonly deadlocked: readonly number[];
  // A dry run suppresses every irreversible action (merge, close, final PR) and
  // halts where it would first merge. The safer default (issue #59).
  readonly dryRun: boolean;
}

// Split the tracer-bullets into the strict build order and the cycle remainder.
// `topologicalOrder` stops at a deadlock, so anything it leaves out is in a cycle.
export function resolveOrder(bullets: TracerBullet[]): {
  order: number[];
  deadlocked: number[];
} {
  const order = topologicalOrder(bullets);
  const inOrder = new Set(order);
  const deadlocked = bullets.filter((b) => !inOrder.has(b.number)).map((b) => b.number);
  return { order, deadlocked };
}

// The preview block printed before the first agent runs (issue #59): the resolved
// slice list in topological order, the spec branch, the base branch, and whether
// this is a dry run — the whole blast radius, visible before it is incurred. The
// driver prints this and does not begin until it is accepted.
export function formatPreview(plan: SpecPlan): string {
  const mode = plan.dryRun ? "DRY RUN" : "EXECUTE";
  const lines = [
    `════ implement-spec #${plan.spec} — ${mode} ════`,
    `spec branch : ${plan.specBranch}`,
    `base branch : ${plan.base || "(default)"}`,
    plan.order.length
      ? "slices (topological order):"
      : "slices: (none — nothing to build)",
  ];
  plan.order.forEach((n, i) => lines.push(`  ${i + 1}. #${n}`));
  if (plan.deadlocked.length) {
    lines.push("deadlocked (dependency cycle — not built):");
    for (const n of plan.deadlocked) lines.push(`  - #${n}`);
  }
  lines.push(
    plan.dryRun
      ? "mode : DRY RUN — merges, issue closes, and the final PR are suppressed; the loop halts where it would first merge."
      : "mode : EXECUTE — each slice is merged into the spec branch for real, and the final PR opens when the last one lands.",
  );
  return lines.join("\n");
}

// A slice PR's merged state as read back from GitHub (`gh pr list --json
// number,state,mergedAt,baseRefName`). The loop reads this AFTER the slice's
// implement run merged its PR, to prove the slice actually landed before advancing
// — the step the unattended path gets from a merge webhook and this loop newly owns.
export interface PrMergeView {
  readonly number: number;
  readonly state?: string; // OPEN | CLOSED | MERGED
  readonly mergedAt?: string | null;
  readonly baseRefName?: string;
}

// Parse `gh pr list … --json …`'s array, preferring a merged PR when several share
// the head branch (a superseded closed PR must not shadow the real merge). Null on
// a blank, non-array, empty, or unparseable payload — tolerant like `parseChecks`.
export function parseMergeView(json: string): PrMergeView | null {
  const text = json.trim();
  if (!text) return null;
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) return null;
    const rows = data as PrMergeView[];
    return rows.find((p) => p.state === "MERGED") ?? rows[0];
  } catch {
    return null;
  }
}

// Confirmed ONLY when the PR reports itself merged into the exact spec branch. A
// queued merge (still OPEN), a merge blocked by branch protection (CLOSED, not
// merged), or a stale view (no PR found) all read as unconfirmed — the loop must
// halt rather than advance on any of them (issue #59). The tracer-bullet's own
// closed state is deliberately NOT consulted here: closing is failure-tolerant on
// the existing path, so a genuinely-merged slice can have its issue still open.
export function mergeConfirmed(pr: PrMergeView | null, specBranch: string): boolean {
  return (
    pr !== null &&
    pr.state === "MERGED" &&
    Boolean(pr.mergedAt) &&
    pr.baseRefName === specBranch
  );
}

// Why an unconfirmed merge halts the run — names the actual state read back so a
// queued/blocked/stale merge is distinguishable from a landed one.
export function mergeHaltReason(
  pr: PrMergeView | null,
  slice: number,
  specBranch: string,
): string {
  if (pr === null) {
    return (
      `⛔ slice #${slice}: no PR into \`${specBranch}\` was found merged after the run — ` +
      `the merge did not land (queued, blocked by branch protection, or a stale view). ` +
      `Halting; the next slice is NOT built.`
    );
  }
  const where = pr.baseRefName ? `\`${pr.baseRefName}\`` : "an unknown base";
  return (
    `⛔ slice #${slice}: PR #${pr.number} reads ${pr.state ?? "unknown"} into ${where}, ` +
    `not merged into \`${specBranch}\` (a queued or blocked merge is not a landed slice). ` +
    `Halting; the next slice is NOT built.`
  );
}

// One line reporting an action a real run would take but a dry run suppresses
// (issue #59): "reporting each suppressed action". The driver supplies the specific
// action text (e.g. "merge PR #12 into agent/spec-3-…").
export function dryRunSuppressed(action: string): string {
  return `  ⟂ [dry-run] would ${action}`;
}

// The header framing one slice in a long multi-slice run so the streamed output
// stays readable.
export function formatSliceHeader(o: {
  position: number;
  total: number;
  slice: number;
  specBranch: string;
}): string {
  return `\n━━━ slice ${o.position}/${o.total}: #${o.slice} → ${o.specBranch} ━━━`;
}

// How one slice ended, for its footer: it landed, it built but the merge was
// suppressed (dry run), or it only built (a halt before the merge).
export type SliceOutcome = "merged" | "would-merge" | "built";

// The footer closing a slice's frame.
export function formatSliceFooter(o: { slice: number; outcome: SliceOutcome }): string {
  const tail =
    o.outcome === "merged"
      ? "merged into the spec branch"
      : o.outcome === "would-merge"
        ? "built — merge suppressed (dry run)"
        : "built (not merged)";
  return `└─ slice #${o.slice}: ${tail}`;
}

// ── Checkpoints, resume, and graceful stop (issue #60) ──────────────────────────
//
// A long spec run is made controllable, stoppable, and restartable. The loop pauses
// between slices by DEFAULT — the checkpoint where the developer inspects the
// accumulated spec branch before the next slice stacks on it, which is what makes a
// parity finalize acceptable rather than a loss of control. `--no-pause` runs
// straight through; interactive mode steers every slice and is therefore mutually
// exclusive with running straight through. Resume derives ENTIRELY from the tracker
// and the branches — no local file — so a spec interrupted under one entry point
// resumes under the other.

// Interactive per-slice mode and run-straight-through are mutually exclusive: one
// stops to steer every slice, the other never stops at all — asking for both is a
// contradiction. Returns the refusal message when both are set, null otherwise.
export function specFlagConflict(o: { interactive: boolean; runThrough: boolean }): string | null {
  if (o.interactive && o.runThrough) {
    return (
      "spec-loop: --interactive and --no-pause are mutually exclusive — interactive mode " +
      "hands over a live session per slice, while --no-pause runs the whole spec straight " +
      "through without pausing. Pick one."
    );
  }
  return null;
}

// What to do with a slice at the top of its turn, decided from the PR state read
// back from GitHub — the ONLY source, so resume is identical under either entry
// point and needs no local file. A slice whose PR is already merged into the spec
// branch is treated as landed (advance without work); one whose PR is open resumes
// at its GATE — await checks, then merge — rather than re-running the agent, which
// would be the most expensive mistake the loop could make; anything else is built.
export type SliceDisposition = "build" | "resume-gate" | "already-merged";

export function sliceDisposition(pr: PrMergeView | null, specBranch: string): SliceDisposition {
  if (mergeConfirmed(pr, specBranch)) return "already-merged";
  if (pr !== null && pr.state === "OPEN" && pr.baseRefName === specBranch) return "resume-gate";
  return "build";
}

// The checkpoint framing printed between slices (issue #60): the slice that just
// landed, the spec branch to inspect, and the next slice that will stack on it. The
// driver follows it with a confirmation prompt (unless `--no-pause` is set).
export function formatCheckpoint(o: { lastMerged: number; next: number; specBranch: string }): string {
  return (
    `\n⏸ checkpoint: slice #${o.lastMerged} is merged into \`${o.specBranch}\`. ` +
    `Inspect the spec branch before the next slice (#${o.next}) stacks on it.`
  );
}

// The single-line prompt read back at a checkpoint. Declining halts the run cleanly
// at a between-slices boundary, so re-running the command resumes it.
export function checkpointPrompt(next: number): string {
  return `spec-loop: continue to slice #${next}? [y/N] `;
}

// The note printed when a graceful stop is acknowledged (issue #60): the loop
// finishes the slice it is on and halts at the next checkpoint — unlike Ctrl-C,
// which aborts immediately. Requested from a SECOND terminal (the running one is
// occupied) via `implement-spec <spec> --stop`.
export function gracefulStopAcknowledged(): string {
  return (
    "\n◼ graceful stop requested — finishing the current slice, then halting at the next " +
    "checkpoint. (Ctrl-C in the running terminal still aborts immediately.)"
  );
}

// The halt reason recorded when a graceful stop lands at a checkpoint. The spec is
// left exactly at a between-slices boundary, so resume picks it up cleanly.
export function gracefulStopHaltReason(lastMerged: number | null): string {
  return lastMerged === null
    ? "graceful stop before any slice merged — re-run to resume"
    : `graceful stop after slice #${lastMerged} merged — re-run to resume`;
}

// The note printed when a slice resumes at its gate (issue #60): an open PR from a
// prior run is merged here rather than re-running the agent.
export function formatResumeGate(o: { slice: number; pr: number; specBranch: string }): string {
  return (
    `↻ slice #${o.slice}: PR #${o.pr} into \`${o.specBranch}\` is already open — resuming at ` +
    `its gate (await checks, then merge); NOT re-running the agent.`
  );
}

// The note printed when a slice's PR is already merged on resume (issue #60): the
// slice landed under a prior run (or the unattended orchestrator); advance without
// rebuilding.
export function formatAlreadyMerged(o: { slice: number; pr: number; specBranch: string }): string {
  return `✔ slice #${o.slice}: PR #${o.pr} is already merged into \`${o.specBranch}\` — advancing without rebuilding.`;
}

// ── Run ceiling (issue #61) ──────────────────────────────────────────────────────
//
// A ceiling bounds what one spec run may spend before a human sees it again — slices
// attempted, total wall-clock, or both. It is evaluated as a decision in the loop's
// step: at each checkpoint (a between-slices boundary), before the next slice is
// built, the loop asks whether the ceiling is reached and, if so, halts CLEANLY there
// — the same clean stop as a graceful stop, distinct from a failure, and resume picks
// it up. Absent configuration there is no ceiling and today's unbounded behaviour is
// unchanged.

// What the run has consumed so far, read at a checkpoint. `slicesAttempted` counts
// only slices this run genuinely built or gated — an already-merged slice caught up
// on resume spends nothing and is not counted, so resume always makes progress rather
// than immediately re-halting on a ceiling it already reached.
export interface RunConsumption {
  readonly slicesAttempted: number;
  readonly elapsedSeconds: number;
}

// Evaluate the ceiling: the halt reason when the run has reached a configured limit
// at this checkpoint, or null when it may continue. Each limit is optional and an
// absent limit never trips; with neither set (no ceiling) it is always null — today's
// behaviour. Slices are checked before wall-clock so the reported reason names the
// simpler, likelier-deliberate limit when both trip at once.
export function ceilingReached(ceiling: RunCeiling, consumed: RunConsumption): string | null {
  if (ceiling.maxSlices !== undefined && consumed.slicesAttempted >= ceiling.maxSlices) {
    return (
      `run ceiling reached: ${consumed.slicesAttempted}/${ceiling.maxSlices} slices attempted this run. ` +
      `Halting cleanly at this checkpoint — re-run to resume.`
    );
  }
  if (
    ceiling.maxWallClockSeconds !== undefined &&
    consumed.elapsedSeconds >= ceiling.maxWallClockSeconds
  ) {
    return (
      `run ceiling reached: ${consumed.elapsedSeconds}s/${ceiling.maxWallClockSeconds}s wall-clock this run. ` +
      `Halting cleanly at this checkpoint — re-run to resume.`
    );
  }
  return null;
}

// Whether any ceiling limit is configured. When false the run is unbounded and the
// summary omits the consumption line, preserving today's output exactly.
export function hasCeiling(ceiling: RunCeiling): boolean {
  return ceiling.maxSlices !== undefined || ceiling.maxWallClockSeconds !== undefined;
}

// What a run consumed against its ceiling, reported on exit (issue #61).
export interface CeilingReport {
  readonly slicesAttempted: number;
  readonly maxSlices?: number;
  readonly elapsedSeconds: number;
  readonly maxWallClockSeconds?: number;
}

// The one-line consumption report: each limit shown as consumed/limit when set, or as
// a bare consumed figure when that limit is unconfigured.
export function formatCeilingConsumption(r: CeilingReport): string {
  const slices =
    r.maxSlices !== undefined
      ? `${r.slicesAttempted}/${r.maxSlices} slices`
      : `${r.slicesAttempted} slices`;
  const wall =
    r.maxWallClockSeconds !== undefined
      ? `${r.elapsedSeconds}s/${r.maxWallClockSeconds}s wall-clock`
      : `${r.elapsedSeconds}s wall-clock`;
  return `consumed : ${slices}, ${wall}`;
}

// The end-of-run summary the loop prints on exit, so the outcome is legible without
// scrolling back through a long multi-slice run.
export interface SpecRunSummary {
  readonly spec: number;
  readonly specBranch: string;
  readonly dryRun: boolean;
  // The slices that landed (a real run) or that a dry run previewed before halting.
  readonly merged: readonly number[];
  // Where the run stopped short, if it did — a failed slice, an unconfirmed merge,
  // a red spec branch, or a dry run's halt-before-merge.
  readonly halted: { slice: number; reason: string } | null;
  // Whether the final spec→base PR was opened (only a completed real run does this).
  readonly finalPrOpened: boolean;
  // What the run consumed against its ceiling (issue #61), or null/absent when no
  // ceiling was configured — then the summary omits the line, preserving today's
  // output exactly.
  readonly ceiling?: CeilingReport | null;
  // The append-only run log's path (issue #62), so the record of every transition is
  // discoverable from the summary and survives a halt. Absent → the line is omitted.
  readonly runLog?: string;
}

// Render the summary as a compact block. Pure — the driver prints it.
export function formatSpecSummary(s: SpecRunSummary): string {
  const state = s.halted ? "halted" : "complete";
  const kind = s.dryRun ? "dry run" : "run";
  const slices = s.merged.length ? s.merged.map((n) => `#${n}`).join(", ") : "(none)";
  const lines = [
    `══ implement-spec #${s.spec}: ${kind} ${state} ══`,
    `spec branch : ${s.specBranch}`,
    `slices ${s.dryRun ? "previewed" : "merged"} : ${slices}`,
  ];
  if (s.halted) lines.push(`halted at #${s.halted.slice}: ${s.halted.reason}`);
  if (s.ceiling) lines.push(formatCeilingConsumption(s.ceiling));
  if (s.finalPrOpened) lines.push(`final PR : opened for ${s.specBranch}`);
  else if (!s.dryRun && !s.halted) lines.push("final PR : (none opened)");
  if (s.runLog) lines.push(`run log : ${s.runLog}`);
  return lines.join("\n");
}
