// Sequencer plan module (issue #49). A **pure** function: given a verb and a run
// context, it returns the ordered list of steps that make up that verb — the
// single source of truth for the sequence that both entry points (the
// label-triggered reusable workflow and, later, the local sequencer) share so
// they cannot drift apart.
//
// This module performs ZERO I/O: it neither reads the environment nor spawns
// anything. It only describes what should run; the executor (executor.mts) runs
// it and the bin's whole-verb bridge (run.mts) wires the two together.

import { join } from "node:path";

// Where a step runs — the split the PR verbs need and the issue verbs do not.
// A PR verb runs the agent against the PR head while loading its tracker tooling
// from a detached worktree checked out at the default branch (the PR branch may
// predate the tooling):
//
// - `"tooling"` — the detached default-branch worktree ($TOOLING_DIR): guards,
//                 status, and finalize run their CURRENT packaged logic there.
// - `"work"`    — the PR head working tree: the agent run and the git push act on
//                 the PR's own code.
//
// Absent means the single checkout the issue verbs use — no split, so the
// executor runs the step in the ambient working directory.
export type Cwd = "tooling" | "work";

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
  // Which checkout the step runs in (see `Cwd`). Absent for the issue verbs,
  // which have no tooling/working-directory split.
  readonly cwd?: Cwd;
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
  // The `implement-spec` orchestrator's entry point — `"kickoff"` (label the spec
  // issue) or `"advance"` (a tracer-bullet PR merged). Selects which single-step
  // orchestrator plan to return; ignored by every other verb (issue #52).
  readonly specMode?: string;
  // A forced run (issue #56): overrule a guard refusal. The guards step still
  // runs (its reason prints), but its non-zero exit is `tolerated` so the sequence
  // continues. Set only by the attended entry point's `--force`; unattended never
  // forces, so its guards stay a `refusal`.
  readonly force?: boolean;
}

function hook(
  name: string,
  onNonZero: Disposition,
  args: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
  cwd?: Cwd,
): HookStep {
  return { kind: "hook", hook: name, args, env, onNonZero, cwd };
}

function shell(
  name: string,
  run: string,
  onNonZero: Disposition,
  env: Readonly<Record<string, string>> = {},
  cwd?: Cwd,
): ShellStep {
  return { kind: "shell", name, run, env, onNonZero, cwd };
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

// The three PR verbs share a prefix: guard the PR, report in-progress, then run
// the agent. The tracker hooks load their CURRENT logic from the tooling worktree
// (`"tooling"`); the agent run acts on the PR head (`"work"`). There is NO
// fetch-spec — a PR verb gathers its own PR context inside the run. The agent run
// is a `failure` step, so a no-op (nothing to commit) reports blocked.
function prPrefix(): Step[] {
  return [
    hook("guards", "refusal", [], {}, "tooling"),
    hook("status", "failure", ["in-progress"], {}, "tooling"),
    hook("run", "failure", [], {}, "work"),
  ];
}

// `implement-pr` and `update-branch` end with a work-tree shell step that pushes
// and finalizes. The push never force-pushes: a non-fast-forward means the branch
// advanced remotely during the run, so it self-reports blocked (a specific
// message, not a failure) rather than overwrite it. finalize runs only after a
// successful push, so it is bundled here rather than being a separate hook step;
// the hooks it calls still run from the tooling worktree via `--cwd`.
const IMPLEMENT_PR_PUSH_AND_FINALIZE = `if git push origin "HEAD:$HEAD_REF"; then
  yarn --cwd "$TOOLING_DIR" sandcastle:implement-pr-finalize
  yarn --cwd "$TOOLING_DIR" sandcastle:implement-pr-status done
else
  yarn --cwd "$TOOLING_DIR" sandcastle:implement-pr-status blocked "aborted — the branch could not be fast-forwarded onto its remote (it likely advanced during the run). Not force-pushing."
fi`;

// `update-branch` reads $STATUS_FILE (a plain file the run wrote): `up-to-date`
// pushes nothing but still finalizes the "already up to date" comment; `merged`
// pushes without force. Same non-fast-forward self-report as implement-pr.
const UPDATE_BRANCH_PUSH_AND_FINALIZE = `status=$(cat "$STATUS_FILE" 2>/dev/null || echo "")
if [ "$status" = "up-to-date" ]; then
  yarn --cwd "$TOOLING_DIR" sandcastle:update-branch-finalize
  yarn --cwd "$TOOLING_DIR" sandcastle:update-branch-status done
  exit 0
fi
if git push origin "HEAD:$HEAD_REF"; then
  yarn --cwd "$TOOLING_DIR" sandcastle:update-branch-finalize
  yarn --cwd "$TOOLING_DIR" sandcastle:update-branch-status done
else
  yarn --cwd "$TOOLING_DIR" sandcastle:update-branch-status blocked "aborted — the branch could not be fast-forwarded onto its remote (it likely advanced during the run). Not force-pushing."
fi`;

// `review-pr`: read-only, so it never pushes. After the run it posts the review
// (inline comments + summary) and reports done — both tracker hooks from the
// tooling worktree, exactly as explore's tail but split across the two checkouts.
function reviewPrPlan(): readonly Step[] {
  return [
    ...prPrefix(),
    hook("finalize", "failure", [], {}, "tooling"),
    hook("status", "failure", ["done"], {}, "tooling"),
  ];
}

// `implement-pr`: the agent commits onto the PR head, then push-and-finalize.
function implementPrPlan(): readonly Step[] {
  return [
    ...prPrefix(),
    shell("push-and-finalize", IMPLEMENT_PR_PUSH_AND_FINALIZE, "failure", {}, "work"),
  ];
}

// `update-branch`: the agent merges the base into the PR head, then push-and-finalize.
function updateBranchPlan(): readonly Step[] {
  return [
    ...prPrefix(),
    shell("push-and-finalize", UPDATE_BRANCH_PUSH_AND_FINALIZE, "failure", {}, "work"),
  ];
}

// `implement-spec`: the spec ORCHESTRATOR (CONTEXT.md) — it runs NO agent, so its
// plan is a single tracker/`gh`-only step: the `kickoff` or `advance` hook, chosen
// by `context.specMode`. Both entry points delegate their whole sequence here so
// they share one pinned shape. A non-zero exit is a genuine `failure` (the hook
// never refuses — the separate kickoff guard job owns refusals; and advance exits
// non-zero to halt on a red spec branch, which must fail the job). No `cwd` split
// and no fetch-spec: the orchestrator works the issue graph from one checkout.
function implementSpecPlan(context: RunContext): readonly Step[] {
  const mode = context.specMode;
  if (mode !== "kickoff" && mode !== "advance") {
    throw new Error(`sequencer: implement-spec unknown mode "${mode}"`);
  }
  return [hook(mode, "failure")];
}

function fullPlan(verb: string, context: RunContext): readonly Step[] {
  switch (verb) {
    case "explore":
      return explorePlan();
    case "implement":
      return implementPlan(context);
    case "review-pr":
      return reviewPrPlan();
    case "implement-pr":
      return implementPrPlan();
    case "update-branch":
      return updateBranchPlan();
    case "implement-spec":
      return implementSpecPlan(context);
    default:
      throw new Error(`sequencer: no plan for verb "${verb}"`);
  }
}

// How an attended local run (issue #55) ended, for the worktree cleanup policy.
// The first three mirror the executor's `Outcome`; `aborted` is the extra case the
// executor cannot see — a Ctrl-C signal killed the run mid-step.
export type LocalOutcome = "succeeded" | "refused" | "failed" | "aborted";

// Where an attended local run's git worktree lives (issue #55). Each run gets its
// OWN directory under the configured `root` — never the developer's own checkout —
// named for the verb and issue so concurrent runs of different verbs/issues never
// collide and a retained tree is self-identifying. Deterministic in its inputs, so
// re-running the same command lands on the same tree. Pure — a string derivation,
// no I/O; the entry point (attended.mts) creates and removes the directory.
export function worktreePath(root: string, verb: string, issue: string | number): string {
  return join(root, `${verb}-${issue}`);
}

// The worktree cleanup policy (issue #55). The tree is REMOVED only on a clean end
// with nothing to inspect — a success, or a guard refusal that produced no work and
// posted its own explanation. A failure or a Ctrl-C abort RETAINS the tree, because
// that half-finished tree is exactly what the developer wants to open.
export function retainWorktree(outcome: LocalOutcome): boolean {
  return outcome === "failed" || outcome === "aborted";
}

// The guards step of a plan, with its non-zero disposition relaxed to `tolerated`
// so a refusal no longer stops the sequence — how a forced run overrules a guard
// refusal (issue #56). Every other step is returned unchanged.
function tolerateGuards(plan: readonly Step[]): readonly Step[] {
  return plan.map((step) =>
    step.kind === "hook" && step.hook === "guards"
      ? { ...step, onNonZero: "tolerated" as const }
      : step,
  );
}

// Return the ordered step list for `verb` under `context`. Pure — no I/O. A forced
// run relaxes the guard step to `tolerated` (a refusal is overruled). In guards-only
// mode only the guard step is returned, so the light guard job pays nothing for the
// rest of the sequence.
export function planVerb(verb: string, context: RunContext): readonly Step[] {
  let plan = fullPlan(verb, context);
  if (context.force) plan = tolerateGuards(plan);
  if (context.guardsOnly) {
    return plan.filter((s) => s.kind === "hook" && s.hook === "guards");
  }
  return plan;
}
