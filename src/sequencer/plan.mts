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

// How an attended `implement` run finalizes (issue #57). `auto` is full parity
// with the unattended path — the single sequence pushes, opens the PR, and updates
// the tracker. `never` stops with the commits on the agent branch (nothing reaches
// GitHub). `ask` produces the commits, then finalizes only on the developer's
// confirmation. Unattended runs never set this; they always finalize (`auto`).
export type FinalizeMode = "auto" | "ask" | "never";

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
  // How an attended `implement` run finalizes (issue #57). Absent/`auto` keeps the
  // push + finalize tail on the sequence (full parity); `ask`/`never` drop it so
  // the sequence stops with the commits on the agent branch. Ignored by every other
  // verb and by unattended runs (which never set it).
  readonly finalize?: FinalizeMode;
  // Run ONLY the finalize tail — push the branch, then open the PR / update the
  // tracker (issue #57). The attended `ask` path runs this as a second, confirmed
  // slice after its first slice produced the commits; `BRANCH`/`BASE` are threaded
  // in by the caller since there is no fetch-spec in this slice. `implement` only.
  readonly finalizeTailOnly?: boolean;
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
  // The finalize tail in isolation: push the agent branch, then open the PR and
  // update the tracker. An attended `ask` run (issue #57) runs this as a second,
  // confirmed slice after the first slice produced the commits — the SAME two steps
  // the unattended tail runs, so a confirmed local finalize lands on GitHub exactly
  // as CI's does. `BRANCH`/`BASE` are supplied by the caller (no fetch-spec here).
  if (context.finalizeTailOnly) {
    return [shell("push", PUSH, "failure"), hook("finalize", "failure")];
  }

  // An attended `ask` or `never` run keeps everything off GitHub until finalize
  // (issue #57): it drops the finalize tail AND the `in-progress` status step, so a
  // `never` run and a declined `ask` run touch the tracker not at all — nothing
  // reaches GitHub before the developer has looked. An `auto` run (and every
  // unattended run) keeps both, for full parity.
  const untilFinalize = context.finalize === "ask" || context.finalize === "never";
  const steps: Step[] = [hook("guards", "refusal")];
  if (!untilFinalize) steps.push(hook("status", "failure", ["in-progress"]));
  steps.push(hook("fetch-spec", "failure"));
  steps.push(shell("create-branch", CREATE_BRANCH, "failure"));
  steps.push(hook("run", "failure"));
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
  if (!untilFinalize) {
    steps.push(shell("push", PUSH, "failure"));
    steps.push(hook("finalize", "failure"));
  }
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
// never refuses — the separate guard job owns refusals for both modes; and advance exits
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

// The verbs whose clean success still leaves something to open: the two that produce
// COMMITS (issues #57, #142). Everything else the run did reached the tracker, so the
// tree holds nothing the pull request or the issue does not.
const COMMIT_PRODUCING_VERBS = ["implement", "implement-pr"];

// The worktree cleanup policy (issues #55, #57, #142). A failure or a Ctrl-C abort always
// RETAINS the tree — that half-finished tree is exactly what the developer wants to
// open. An attended `implement` or `implement-pr` run also retains on SUCCESS: what
// provides inspection is the surviving worktree the developer can open, diff, and re-run
// against — not a withheld push. The read-only verbs (`explore`, `review-pr`) REMOVE a
// clean success, and a guard refusal (which produced no work and posted its own
// explanation) removes for all verbs.
export function retainWorktree(outcome: LocalOutcome, verb?: string): boolean {
  if (outcome === "failed" || outcome === "aborted") return true;
  if (outcome === "succeeded" && verb !== undefined) {
    return COMMIT_PRODUCING_VERBS.includes(verb);
  }
  return false;
}

// Parse the attended `--finalize=<mode>` flag (issue #57). Absent → `auto` (full
// parity). An unrecognised value throws rather than silently defaulting to `auto`,
// because defaulting a typo to the pushing path is exactly the surprise the flag
// exists to prevent.
export function parseFinalizeMode(argv: readonly string[]): FinalizeMode {
  const flag = "--finalize=";
  for (const arg of argv) {
    if (!arg.startsWith(flag)) continue;
    const mode = arg.slice(flag.length);
    if (mode === "auto" || mode === "ask" || mode === "never") return mode;
    throw new Error(`unknown finalize mode "${mode}" — expected auto, ask, or never`);
  }
  return "auto";
}

// The verbs an interactive run may drive (issue #58). An interactive run hands the
// composed prompt to a LIVE agent session in the terminal so the developer can steer
// the work in progress — which suits only the verbs whose result is COMMITS the
// finalize tail reads back from git (`implement`, `implement-pr`). The read-only verbs
// (`explore`, `review-pr`) and `update-branch` instead depend on a structured
// extraction pass a free-form interactive session cannot produce, so the sequencer
// refuses the combination outright rather than degrade into a run that cannot report
// its result.
const INTERACTIVE_VERBS = ["implement", "implement-pr"] as const;

// Whether `verb` may run interactively (issue #58). Pure — the single source of truth
// both entry points consult before handing a composed prompt to a live agent session,
// so the attended path and the sequencer bridge refuse the same combinations. The
// eligible verbs are named in the refusal message via `INTERACTIVE_VERBS`.
export function interactiveEligible(verb: string): boolean {
  return (INTERACTIVE_VERBS as readonly string[]).includes(verb);
}

// The eligible verbs, for a refusal message that lists them. Kept beside the predicate
// so the two never drift (issue #58).
export const interactiveVerbs: readonly string[] = INTERACTIVE_VERBS;

// The verbs an attended run may drive (issues #140, #141, #142). An attended run happens on
// the developer's own machine, in a worktree under the configured root, streamed to the
// terminal — the two issue-numbered verbs the local sequencer began with, plus the two
// PR-numbered ones that read and address a pull request. Extending it to `update-branch`,
// the remaining PR verb, is this list plus its test, not a change to the entry point.
const ATTENDED_VERBS = ["explore", "implement", "review-pr", "implement-pr"] as const;

// Whether `verb` may be run as an attended run (issue #140). Pure — the single source of
// truth the attended entry point consults, so the set of attendable verbs is a tested
// decision here rather than a constant inside the shell. Mirrors `interactiveEligible`.
export function attendable(verb: string): boolean {
  return (ATTENDED_VERBS as readonly string[]).includes(verb);
}

// The attendable verbs, for a refusal message that lists them. Kept beside the predicate
// so the two never drift (issue #140).
export const attendedVerbs: readonly string[] = ATTENDED_VERBS;

// Which kind of thing an attended run's number names (issue #140) — the ONE fact every
// difference between an attended issue run and an attended pull-request run follows from.
export type AttendedSubject = "issue" | "pull-request";

// The shape of an attended run, derived from its verb (issue #140). Returned as DATA the
// entry point applies rather than as the per-verb branches it would otherwise accumulate
// once a PR-numbered verb becomes attendable. Both attendable verbs are issue-numbered
// today, so nothing branches on it yet; it is the fact every later slice branches on.
export interface AttendedRunShape {
  // What the run's number names — and so which object carries the `agent:in-progress`
  // mutex the entry point checks before it starts: the issue for an issue-numbered verb,
  // the pull request for a PR-numbered one.
  readonly subject: AttendedSubject;
  // The environment variable that carries the number to the verb's hooks.
  readonly numberEnv: string;
  // The environment variable that carries the subject's title to the verb's hooks. The
  // run hook `required()`s it by name, so the wrong one is a run that dies at its agent
  // step rather than a title that reads oddly.
  readonly titleEnv: string;
  // The `gh` subcommand that reads the subject's title and labels (`gh <sub> view <n>`).
  readonly ghSubcommand: string;
  // What the run's worktree checks out: the base branch (an issue-numbered verb builds on
  // it) or the pull request's own head (a PR-numbered verb reads and edits the code under
  // review).
  readonly checkout: "base" | "pr-head";
}

const ISSUE_RUN_SHAPE: AttendedRunShape = {
  subject: "issue",
  numberEnv: "ISSUE_NUMBER",
  titleEnv: "ISSUE_TITLE",
  ghSubcommand: "issue",
  checkout: "base",
};

const PR_RUN_SHAPE: AttendedRunShape = {
  subject: "pull-request",
  numberEnv: "PR_NUMBER",
  titleEnv: "PR_TITLE",
  ghSubcommand: "pr",
  checkout: "pr-head",
};

const ISSUE_NUMBERED_VERBS = ["explore", "implement"];
const PR_NUMBERED_VERBS = ["review-pr", "implement-pr", "update-branch"];

// The attended run shape for `verb` (issue #140). Pure — a derivation from the verb alone,
// total over the attendable verbs. `implement-spec` is an orchestrator rather than a verb
// numbered by a subject, so it has no shape; nor does an unknown verb, and both throw
// rather than defaulting to the issue shape and reading the wrong object.
export function attendedRunShape(verb: string): AttendedRunShape {
  if (ISSUE_NUMBERED_VERBS.includes(verb)) return ISSUE_RUN_SHAPE;
  if (PR_NUMBERED_VERBS.includes(verb)) return PR_RUN_SHAPE;
  throw new Error(`sequencer: no attended run shape for verb "${verb}"`);
}

// The end-of-run summary an attended run prints on exit (issue #57), so the
// developer sees what happened without scrolling back through streamed output.
export interface RunSummary {
  readonly verb: string;
  readonly issue: string;
  readonly outcome: LocalOutcome;
  readonly retained: boolean;
  readonly tree: string;
  // The finalize mode — only an `implement` run carries one; absent for `explore`,
  // whose read-only "finalize" (a posted comment) needs no accounting here.
  readonly finalize?: FinalizeMode;
  // Whether the finalize tail actually ran and succeeded (pushed + opened the PR).
  readonly finalized?: boolean;
}

// Render the summary as a compact block. Pure — a string derivation the entry point
// prints; kept here beside the other attended helpers so it is unit-testable.
export function formatRunSummary(s: RunSummary): string {
  const lines = [
    `── ${s.verb} #${s.issue}: ${s.outcome} ──`,
    `worktree: ${s.retained ? "retained" : "removed"} at ${s.tree}`,
  ];
  if (s.finalize) {
    lines.push(`finalize: ${finalizeSummaryLine(s.verb, s.finalize, s.finalized ?? false)}`);
  }
  return lines.join("\n");
}

// What a finalize that RAN did, in the verb's own terms: an issue verb's finalize pushes
// the agent branch and opens the pull request, the read-only `review-pr`'s posts the
// review it composed, and `implement-pr`'s pushes onto a pull request that already exists
// and replies to its comments. Reporting a push for a verb that never pushes — or an
// opened pull request for one that only ever pushes onto an existing one — would be the
// summary's one chance to mislead (issues #141, #142).
function finalizedWork(verb: string): string {
  switch (verb) {
    case "review-pr":
      return "posted the review to the pull request";
    case "implement-pr":
      return "pushed the commits to the pull request's head, posted the replies";
    default:
      return "pushed the branch, opened the PR, updated the tracker";
  }
}

function finalizeSummaryLine(verb: string, mode: FinalizeMode, finalized: boolean): string {
  if (finalized) return `${mode} — ${finalizedWork(verb)}`;
  switch (mode) {
    case "never":
      return "never — nothing pushed; the commits are on the agent branch in the worktree";
    case "ask":
      return "ask — not finalized; the commits are on the agent branch in the worktree";
    case "auto":
      return "auto — not finalized (the run did not succeed)";
  }
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
