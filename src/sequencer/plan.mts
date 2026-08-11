// Sequencer plan module (issue #49). A **pure** function: given a verb and a run
// context, it returns the ordered list of hook steps that make up that verb —
// the single source of truth for the hook order that both entry points (the
// label-triggered reusable workflow and, later, the local sequencer) share so
// they cannot drift apart.
//
// This module performs ZERO I/O: it neither reads the environment nor spawns
// anything. It only describes what should run; the executor (executor.mts) runs
// it and the bin's whole-verb bridge (run.mts) wires the two together.

// What a non-zero exit from a step's hook means to the sequencer:
//
// - `refusal`  — a guard declined to run. It has already posted its own
//                explanation and cleared the trigger label; the sequencer stops
//                but this is NOT a failure (never `agent:blocked`).
// - `failure`  — the step genuinely failed; the run is blocked.
// - `tolerated`— a non-zero exit is expected/ignored; the sequencer continues.
export type Disposition = "refusal" | "failure" | "tolerated";

// One step of a verb's sequence: the hook to invoke, the positional args and
// extra environment to supply it, and how to read a non-zero exit.
export interface Step {
  // Hook name as the dispatcher bin understands it (`guards`, `fetch-spec`,
  // `status`, `run`, `finalize`, …).
  readonly hook: string;
  // Positional args passed after the hook, e.g. `["in-progress"]` for `status`.
  readonly args: readonly string[];
  // Extra environment for this step, merged over the ambient env by the executor.
  readonly env: Readonly<Record<string, string>>;
  // How the executor interprets a non-zero exit from this hook.
  readonly onNonZero: Disposition;
}

// Per-run inputs shared by every verb's plan. `explore` reads none of these
// today; the field is the seam later verbs hang their inputs on (the base branch
// a produced PR targets is the motivating example — see issue #48).
export interface RunContext {
  readonly baseBranch?: string;
}

function step(
  hook: string,
  onNonZero: Disposition,
  args: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): Step {
  return { hook, args, env, onNonZero };
}

// `explore`: the narrowest verb that still exercises guards, fetch-spec, status,
// run, and finalize — read-only, so it never pushes. This list mirrors the steps
// the reusable `explore` workflow performed as separate YAML steps.
function explorePlan(): readonly Step[] {
  return [
    step("guards", "refusal"),
    step("status", "failure", ["in-progress"]),
    step("fetch-spec", "failure"),
    step("run", "failure"),
    step("finalize", "failure"),
    step("status", "failure", ["done"]),
  ];
}

// Return the ordered step list for `verb` under `context`. Pure — no I/O.
export function planVerb(verb: string, _context: RunContext): readonly Step[] {
  switch (verb) {
    case "explore":
      return explorePlan();
    default:
      throw new Error(`sequencer: no plan for verb "${verb}"`);
  }
}
