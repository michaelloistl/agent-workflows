// Configuration resolution (issue #53). The one place the sequencer reads its
// tunable, sequencer-actionable values from — split from the toolchain values that
// stay workflow inputs (ADR-0002): a value only GitHub Actions can act on (Ruby
// enablement, system packages, Node version, database URL) stays a `with:` input;
// a value the SEQUENCER acts on (the base branch, the agent model, the check-poll
// timings) is read here, from an optional committed file in the consuming repo.
//
// Every value resolves by the same precedence — **per-run override (env) beats the
// file beats the built-in default** — so a repo whose integration branch is
// `develop` sets `baseBranch` once and every verb targets it, while a repo with no
// file behaves exactly as before (the base falls back to the repository default
// branch the workflow passes as DEFAULT_BRANCH).
//
// Kept pure where it matters: the resolvers take an explicit `{ env, file }` so
// precedence is unit-testable without touching disk; only `loadConfigFile` does I/O.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// The committed config file's shape. Every field is optional — an absent file, or
// an absent field, falls through to the per-run override then the built-in default.
// Unknown keys are ignored, so a repo may list values ahead of their sequencer
// consumers landing without breaking resolution.
export interface ConfigFile {
  // Integration branch every verb bases on (agent branch, PR base, PR-verb tooling
  // ref, orchestrator branch resolution). Absent → the repository default branch.
  readonly baseBranch?: string;
  // Model the fleet's agents run on. Absent → the packaged default.
  readonly agentModel?: string;
  // CI check-poll timings for the two merge gates (issue #44), in seconds.
  readonly checks?: {
    readonly intervalSeconds?: number;
    readonly timeoutSeconds?: number;
    readonly graceSeconds?: number;
  };
  // Root directory under which the attended local sequencer creates each run's git
  // worktree (issue #55). Absent → the OS temp dir. Never the developer's checkout.
  readonly worktreeRoot?: string;
  // Command the attended local sequencer runs on a fresh worktree to make it
  // runnable (issue #55) — e.g. "yarn install". Treated as opaque; a non-zero exit
  // fails the run before the agent starts. Absent/empty → no bootstrap step.
  readonly bootstrap?: string;
  // Run ceiling for the attended spec loop (issue #61): the most a single run may
  // spend before a human sees it again — slices attempted, total wall-clock
  // (seconds), or both. A halted run resumes on re-run. An absent field (or absent
  // section) is no ceiling for that limit — today's unbounded behaviour.
  readonly runCeiling?: {
    readonly maxSlices?: number;
    readonly maxWallClockSeconds?: number;
  };
  // Whether the orchestrator labels the final spec→default PR for review when it
  // opens it (issue #114). Absent → on. A consuming repo that does not want to spend
  // the agent run sets this to `false`. The first boolean the resolver holds, so its
  // "off" rule is explicit (see `resolveFinalPrReview`): only a real `false` here
  // disables it — a non-boolean falls through to on.
  readonly finalPrReview?: boolean;
}

// The model default lives here (not agent.mts) so the file/override resolution and
// the agent factory cannot drift to two different defaults.
export const DEFAULT_AGENT_MODEL = "claude-opus-4-8";

// Default worktree root for attended local runs (issue #55): a subdirectory of the
// OS temp dir, so a run never touches the developer's checkout even with no config.
export const DEFAULT_WORKTREE_ROOT = join(tmpdir(), "agent-workflows-worktrees");

const DEFAULT_INTERVAL_SECONDS = 15;
const DEFAULT_TIMEOUT_SECONDS = 1200;
// Generous by default: neither `gh pr checks` nor the REST API can tell "no CI on
// this ref" from "CI not registered yet", so the grace window is the only thing
// stopping a proceed before a slow-to-queue check even appears.
const DEFAULT_GRACE_SECONDS = 180;

// Where the committed file lives in the consuming-repo checkout (cwd), alongside
// the `.sandcastle/agent-workflows/<verb-dir>/` hook overrides. `AGENT_WORKFLOWS_CONFIG`
// overrides the path (used by tests, and an escape hatch for a bespoke location).
export function configPath(cwd: string = process.cwd()): string {
  return (
    process.env.AGENT_WORKFLOWS_CONFIG ||
    resolve(cwd, ".sandcastle", "agent-workflows", "config.json")
  );
}

// Read + parse the config file. Tolerant by design: a missing, empty, unparseable,
// or non-object file collapses to `{}` — the sequencer must never fail to run just
// because a consumer has no config or fat-fingered the JSON; it falls back cleanly.
export function loadConfigFile(path: string = configPath()): ConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  try {
    const data: unknown = JSON.parse(text);
    return data && typeof data === "object" ? (data as ConfigFile) : {};
  } catch {
    return {};
  }
}

// The inputs every resolver reads: the ambient environment (per-run overrides) and
// the parsed file. Explicit so precedence is testable without disk or `process.env`.
export interface ResolveInputs {
  readonly env: NodeJS.ProcessEnv;
  readonly file: ConfigFile;
}

// The base branch every verb targets: per-run override (BASE_BRANCH) → file
// (`baseBranch`) → repository default (DEFAULT_BRANCH). Empty only when a caller
// wired none of the three (a caller with no repo default surfaces that itself).
export function resolveBaseBranch({ env, file }: ResolveInputs): string {
  return firstNonEmpty(env.BASE_BRANCH, file.baseBranch, env.DEFAULT_BRANCH) ?? "";
}

// The base a produced branch/PR actually targets: a tracer-bullet under a spec
// (its fetch-spec emitted the live spec branch) bases on that spec branch,
// overriding the configured base; a standalone issue falls back to the configured
// base. The spec-branch-wins rule shared by every base consumer.
export function effectiveBase(specBase: string | undefined, configuredBase: string): string {
  return specBase && specBase.length > 0 ? specBase : configuredBase;
}

// The agent model: per-run override (AGENT_MODEL) → file (`agentModel`) → default.
export function resolveAgentModel({ env, file }: ResolveInputs): string {
  return firstNonEmpty(env.AGENT_MODEL, file.agentModel) ?? DEFAULT_AGENT_MODEL;
}

// The worktree root the attended local sequencer creates run worktrees under:
// per-run override (WORKTREE_ROOT) → file (`worktreeRoot`) → OS-temp default.
export function resolveWorktreeRoot({ env, file }: ResolveInputs): string {
  return firstNonEmpty(env.WORKTREE_ROOT, file.worktreeRoot) ?? DEFAULT_WORKTREE_ROOT;
}

// The bootstrap command that makes a fresh worktree runnable: per-run override
// (BOOTSTRAP) → file (`bootstrap`) → empty (skip the step). Empty is a valid value.
export function resolveBootstrap({ env, file }: ResolveInputs): string {
  return firstNonEmpty(env.BOOTSTRAP, file.bootstrap) ?? "";
}

// The resolved run ceiling (issue #61). Each limit is optional; an undefined limit
// never trips. Both undefined ({}) means no ceiling at all — today's behaviour.
export interface RunCeiling {
  readonly maxSlices?: number;
  readonly maxWallClockSeconds?: number;
}

// The run ceiling: per field, env override (RUN_CEILING_MAX_SLICES /
// RUN_CEILING_MAX_WALLCLOCK_SECONDS) → file (`runCeiling`) → unset. A limit must be
// a POSITIVE finite number; a non-positive, non-numeric, or absent value is ignored
// at each tier and falls through, so a fat-fingered ceiling collapses to "no ceiling"
// rather than halting the run before it makes any progress. Only the limits that
// resolve are carried, so an unset limit stays absent (never a spurious 0).
export function resolveRunCeiling({ env, file }: ResolveInputs): RunCeiling {
  const rc = file.runCeiling ?? {};
  const maxSlices = pickPositive(env.RUN_CEILING_MAX_SLICES, rc.maxSlices);
  const maxWallClockSeconds = pickPositive(env.RUN_CEILING_MAX_WALLCLOCK_SECONDS, rc.maxWallClockSeconds);
  const ceiling: { maxSlices?: number; maxWallClockSeconds?: number } = {};
  if (maxSlices !== null) ceiling.maxSlices = maxSlices;
  if (maxWallClockSeconds !== null) ceiling.maxWallClockSeconds = maxWallClockSeconds;
  return ceiling;
}

// Whether the orchestrator labels the final spec→default PR for review when it
// opens it (issue #114): per-run override (FINAL_PR_REVIEW) → file (`finalPrReview`)
// → the built-in default of ON. The FIRST boolean the resolver holds, so the rule
// for what counts as OFF is explicit and cannot lean on the seconds/ceiling helpers:
// only a real `false` in the file and only the exact string `"false"` in the env
// disable it. Anything else — a mistyped env string, a non-boolean in the file — is
// NOT off and falls through to on, because a typo must never silently remove a review
// the repo was relying on. An empty env value is treated as unset, so it falls through
// to the file then the default rather than reading as "not false → on" and shadowing
// the file — parity with the other resolvers (this switch is repo-level policy with no
// workflow input, so nothing sets the variable empty today, but the guard costs nothing
// and keeps the "off" rule identical across every reader).
export function resolveFinalPrReview({ env, file }: ResolveInputs): boolean {
  const raw = env.FINAL_PR_REVIEW;
  if (raw !== undefined && raw !== "") return raw !== "false";
  return file.finalPrReview !== false;
}

export interface CheckTimings {
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly graceSeconds: number;
}

// The check-poll timings: per field, env override → file → default. Invalid values
// (non-numeric, negative, non-finite) are ignored at each tier, exactly as the
// env-only reader did before, so a fat-fingered value falls back rather than
// poisoning the poll loop.
export function resolveCheckTimings({ env, file }: ResolveInputs): CheckTimings {
  const c = file.checks ?? {};
  return {
    intervalSeconds: pickSeconds(env.CHECKS_INTERVAL_SECONDS, c.intervalSeconds, DEFAULT_INTERVAL_SECONDS),
    timeoutSeconds: pickSeconds(env.CHECKS_TIMEOUT_SECONDS, c.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
    graceSeconds: pickSeconds(env.CHECKS_GRACE_SECONDS, c.graceSeconds, DEFAULT_GRACE_SECONDS),
  };
}

export interface ResolvedConfig {
  readonly baseBranch: string;
  readonly agentModel: string;
  readonly checks: CheckTimings;
  readonly worktreeRoot: string;
  readonly bootstrap: string;
  readonly runCeiling: RunCeiling;
  readonly finalPrReview: boolean;
}

// The whole resolved config in one call — what the entrypoints use. Reads the file
// from disk and the ambient env by default; both are injectable for tests.
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  file: ConfigFile = loadConfigFile(),
): ResolvedConfig {
  return {
    baseBranch: resolveBaseBranch({ env, file }),
    agentModel: resolveAgentModel({ env, file }),
    checks: resolveCheckTimings({ env, file }),
    worktreeRoot: resolveWorktreeRoot({ env, file }),
    bootstrap: resolveBootstrap({ env, file }),
    runCeiling: resolveRunCeiling({ env, file }),
    finalPrReview: resolveFinalPrReview({ env, file }),
  };
}

// The first argument that is a non-empty string, or undefined when none is. Treats
// "" as unset so an env var the workflow always sets (`AGENT_MODEL: ${{ inputs… }}`,
// empty when the input is unset) doesn't shadow the file/default.
function firstNonEmpty(...values: ReadonlyArray<string | undefined>): string | undefined {
  for (const v of values) {
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

// A non-negative finite seconds value from the env raw string, or null when unset
// or invalid — so the next tier applies.
function envSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// A non-negative finite file value, or null when absent or invalid.
function fileSeconds(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function pickSeconds(envRaw: string | undefined, fileVal: number | undefined, fallback: number): number {
  return envSeconds(envRaw) ?? fileSeconds(fileVal) ?? fallback;
}

// A POSITIVE finite value from the env raw string, or null when unset or invalid.
// Positive-only: a ceiling of 0 (or negative) would halt the run before it makes any
// progress, which is never what a config author means — so it falls through instead.
function envPositive(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A positive finite file value, or null when absent or invalid.
function filePositive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function pickPositive(envRaw: string | undefined, fileVal: number | undefined): number | null {
  return envPositive(envRaw) ?? filePositive(fileVal);
}
