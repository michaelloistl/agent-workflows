// The spec orchestrator's step function: given the live state of a spec, return
// the single next action. PURE — no `gh`, no GitHub, no polling. It is the brain
// the kickoff and advance hooks call to *decide* what happens next; the hooks own
// the *dispatch* (closing the merged tracer-bullet, recomputing the slice set,
// labelling the chosen slice, posting the progress comment, running the checks).
//
// Slice selection is NOT reimplemented here — topological order, deterministic
// tie-breaking, and completion all delegate to the pure spec-graph brain
// (`nextSlice`/`isComplete`). This module only sequences those decisions with the
// two CI gates the unattended path already runs, so the whole spec lifecycle reads
// as one testable state machine rather than logic embedded in webhook handlers.

import { nextSlice, isComplete, type TracerBullet } from "./spec-graph.mts";

// The live state at a decision point. The caller recomputes `bullets`/`closed`
// from the tracker on every step, so a late-added tracer-bullet is picked up
// (CONTEXT.md: the live recompute). `phase` is the point in the per-slice cycle
// the step resumes from; a gated phase carries `checksPassed` once the caller has
// run the CI it was told to await (undefined until then).
export type SpecState = KickoffState | AdvanceState | SliceMergeState;

// Kickoff: the spec branch was just cut off the base, so no CI gate — just
// dispatch the topologically-first ready slice.
export interface KickoffState {
  phase: "kickoff";
  bullets: TracerBullet[];
  closed: Set<number>;
}

// Advance: a tracer-bullet merged into the spec branch. Gate the *spec branch's*
// own CI (issue #44, fix 2) before dispatching the next slice; when every slice
// is closed, open the final spec→base PR.
export interface AdvanceState {
  phase: "advance";
  bullets: TracerBullet[];
  closed: Set<number>;
  checksPassed?: boolean;
}

// Slice merge: a finished slice's PR is open against the spec branch. Gate the
// *slice PR's* own CI (issue #44, fix 1) before merging it in.
export interface SliceMergeState {
  phase: "slice-merge";
  checksPassed?: boolean;
}

// The one thing to do next. `await-checks` hands control back to the caller to run
// the named CI gate and re-invoke with the verdict; the two gates are the same
// action at different points, distinguished by `gate`.
export type SpecAction =
  | { type: "run-slice"; slice: number }
  | { type: "await-checks"; gate: Gate }
  | { type: "merge" }
  | { type: "open-final-pr" }
  | { type: "halt"; blocked: number | null }
  | { type: "done" };

// Which CI a `await-checks` action refers to: the spec branch's tip (gate 2, the
// advance gate) or a finished slice's own PR (gate 1, the slice-merge gate).
export type Gate = "spec-branch" | "slice-pr";

export function specStep(state: SpecState): SpecAction {
  switch (state.phase) {
    case "kickoff": {
      const next = nextSlice(state.bullets, state.closed);
      return next === null ? { type: "done" } : { type: "run-slice", slice: next };
    }
    case "advance": {
      const next = nextSlice(state.bullets, state.closed);
      if (next === null) {
        // No ready slice: either every slice is closed (open the final PR) or the
        // remainder deadlocked on a dependency cycle (nothing to dispatch — done,
        // not a failure; the progress comment surfaces the cycle).
        return isComplete(state.bullets, state.closed)
          ? { type: "open-final-pr" }
          : { type: "done" };
      }
      // A slice is ready — but a tracer just merged into the spec branch, so gate
      // its tip's CI before stacking the next slice on top (issue #44, fix 2).
      if (state.checksPassed === undefined) return { type: "await-checks", gate: "spec-branch" };
      return state.checksPassed ? { type: "run-slice", slice: next } : { type: "halt", blocked: next };
    }
    case "slice-merge": {
      // Gate the slice PR's own CI before merging it into the spec branch (issue
      // #44, fix 1); a red slice must not land and beget the next one.
      if (state.checksPassed === undefined) return { type: "await-checks", gate: "slice-pr" };
      return state.checksPassed ? { type: "merge" } : { type: "halt", blocked: null };
    }
  }
}
