// Sequencer executor (issue #49). A **thin** runner: it walks the ordered steps
// a plan (plan.mts) describes, invokes each hook via an injected `runStep`, and
// classifies the outcome so a refusal stays distinguishable from a failure.
//
// It holds no knowledge of *how* a hook runs — `runStep` does the spawning (see
// run.mts). That keeps this module pure orchestration and trivially testable.

import type { Step } from "./plan.mts";

// How the whole plan ended:
// - `succeeded` — every step exited 0 (or a tolerated step's non-zero was ignored).
// - `refused`   — a `refusal` step exited non-zero; the run stopped, NOT a failure.
// - `failed`    — a `failure` step exited non-zero; the run is blocked.
export type Outcome = "succeeded" | "refused" | "failed";

export interface PlanResult {
  readonly outcome: Outcome;
  // The exit code to propagate: the offending step's code, or 0 on success.
  readonly code: number;
  // The step that refused or failed (absent on success).
  readonly step?: Step;
}

// Runs a single step's hook and returns its process exit code. Injected so the
// executor can be tested without spawning and so the same executor drives both
// the CI bridge and (later) the local sequencer.
export type RunStep = (step: Step) => number;

// Run the plan in order, stopping at the first step whose non-zero exit its
// disposition does not tolerate. Propagates that step's exit code so the caller
// can tell a refusal (exit code preserved, but not a failure) from a failure.
export function runPlan(plan: readonly Step[], runStep: RunStep): PlanResult {
  for (const step of plan) {
    const code = runStep(step);
    if (code === 0) continue;
    switch (step.onNonZero) {
      case "tolerated":
        continue;
      case "refusal":
        return { outcome: "refused", code, step };
      case "failure":
        return { outcome: "failed", code, step };
    }
  }
  return { outcome: "succeeded", code: 0 };
}
