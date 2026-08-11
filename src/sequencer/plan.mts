// Sequencer plan module (issue #49). A **pure** function: given a verb and a run
// context, it returns the ordered list of steps that make up that verb — the
// single source of truth for the sequence that both entry points (the
// label-triggered reusable workflow and, later, the local sequencer) share so
// they cannot drift apart.
//
// This module performs ZERO I/O: it neither reads the environment nor spawns
// anything. It only describes what should run; the executor (executor.mts) runs
// it and the bin's whole-verb bridge (run.mts) wires the two together.

// What a non-zero exit from a step means to the sequencer:
//
// - `refusal`  — a guard declined to run. It has already posted its own
//                explanation and cleared the trigger label; the sequencer stops
//                but this is NOT a failure (never `agent:blocked`).
// - `failure`  — the step genuinely failed; the run is blocked.
// - `tolerated`— a non-zero exit is expected/ignored; the sequencer continues.
export type Disposition = "refusal" | "failure" | "tolerated";

// A step is either a **hook** — dispatched through the per-hook path so override
// resolution still applies (the tracker-aware work: guards, status, fetch-spec,
// the agent run, finalize) — or a **shell** command GitHub Actions used to run
// inline (branch creation, the fresh-DB boot check, the push). Both carry how a
// non-zero exit is read and any extra environment to supply.
interface StepBase {
  // Extra environment for this step, merged over the ambient env by the executor.
  readonly env: Readonly<Record<string, string>>;
  // How the executor interprets a non-zero exit from this step.
  readonly onNonZero: Disposition;
}

export interface HookStep extends StepBase {
  readonly kind: "hook";
  // Hook name as the dispatcher bin understands it (`guards`, `fetch-spec`,
  // `status`, `run`, `finalize`, …).
  readonly hook: string;
  // Positional args passed after the hook, e.g. `["in-progress"]` for `status`.
  readonly args: readonly string[];
}

export interface ShellStep extends StepBase {
  readonly kind: "shell";
  // Human-readable label — the pinned identity of the step in the sequence.
  readonly name: string;
  // The command to run (via `bash`), reading threaded env like `$BRANCH`/`$BASE`.
  readonly run: string;
}

export type Step = HookStep | ShellStep;

// Per-run inputs shared by every verb's plan.
export interface RunContext {
  // The branch a produced PR falls back to targeting when the issue is not a
  // spec tracer-bullet (the repository default branch in CI). Threaded to the
  // git steps as `BASE` when fetch-spec emits no spec base.
  readonly baseBranch?: string;
  // Whether the Ruby toolchain is enabled — gates the Rails fresh-DB boot check,
  // exactly as the workflow gated its step on `inputs.enable-ruby`.
  readonly enableRuby?: boolean;
  // Guards-only mode: return just the guard step. The light guard job runs the
  // plan in this mode so a refusal is caught before Ruby and Postgres are paid
  // for; the main job runs the full plan (issue #50, spec #48 story 26).
  readonly guardsOnly?: boolean;
}

function hook(
  name: string,
  onNonZero: Disposition,
  args: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): HookStep {
  return { kind: "hook", hook: name, args, env, onNonZero };
}

function shell(
  name: string,
  run: string,
  onNonZero: Disposition,
  env: Readonly<Record<string, string>> = {},
): ShellStep {
  return { kind: "shell", name, run, env, onNonZero };
}

// `explore`: the narrowest verb that still exercises guards, fetch-spec, status,
// run, and finalize — read-only, so it never pushes. This list mirrors the steps
// the reusable `explore` workflow performed as separate YAML steps.
function explorePlan(): readonly Step[] {
  return [
    hook("guards", "refusal"),
    hook("status", "failure", ["in-progress"]),
    hook("fetch-spec", "failure"),
    hook("run", "failure"),
    hook("finalize", "failure"),
    hook("status", "failure", ["done"]),
  ];
}

// The three shell steps `implement` performed inline in YAML. `BRANCH`/`BASE`
// come from fetch-spec's outputs, threaded in by the bridge (run.mts).
const CREATE_BRANCH = `git fetch origin "$BASE"
git checkout -B "$BRANCH" "origin/$BASE"`;

// Verify the app boots against a fresh empty DB AFTER the agent's changes, so a
// class-load-time DB query the agent introduced is caught in this run rather
// than slipping onto the next tracer-bullet (issue #44). Drops the DB out of
// band via psql so an app env-load isn't required to reset the very state under
// test.
const BOOT_CHECK = `psql -d postgres -c 'DROP DATABASE IF EXISTS test'
psql -d postgres -c 'CREATE DATABASE test'
bundle exec rails db:prepare`;

const PUSH = `git push -u origin "$BRANCH"`;

// `implement`: the full issue sequence. Guards → report in-progress → fetch the
// spec → cut the agent branch → the agent run → (Ruby only) the fresh-DB boot
// check → push the branch → finalize (open the PR and apply the terminal label).
// finalize owns the terminal state, so there is no trailing `status done`.
function implementPlan(context: RunContext): readonly Step[] {
  const steps: Step[] = [
    hook("guards", "refusal"),
    hook("status", "failure", ["in-progress"]),
    hook("fetch-spec", "failure"),
    shell("create-branch", CREATE_BRANCH, "failure"),
    hook("run", "failure"),
  ];
  if (context.enableRuby) {
    steps.push(
      shell("boot-check", BOOT_CHECK, "failure", {
        RAILS_ENV: "test",
        PGHOST: "localhost",
        PGPORT: "5432",
        PGUSER: "postgres",
        PGPASSWORD: "postgres",
      }),
    );
  }
  steps.push(shell("push", PUSH, "failure"));
  steps.push(hook("finalize", "failure"));
  return steps;
}

function fullPlan(verb: string, context: RunContext): readonly Step[] {
  switch (verb) {
    case "explore":
      return explorePlan();
    case "implement":
      return implementPlan(context);
    default:
      throw new Error(`sequencer: no plan for verb "${verb}"`);
  }
}

// Return the ordered step list for `verb` under `context`. Pure — no I/O. In
// guards-only mode only the guard step is returned, so the light guard job pays
// nothing for the rest of the sequence.
export function planVerb(verb: string, context: RunContext): readonly Step[] {
  const plan = fullPlan(verb, context);
  if (context.guardsOnly) {
    return plan.filter((s) => s.kind === "hook" && s.hook === "guards");
  }
  return plan;
}
