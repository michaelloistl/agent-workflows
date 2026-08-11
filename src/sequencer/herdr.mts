// The optional terminal-multiplexer surface for the attended spec loop (issue #62).
// When the loop runs inside a Herdr-managed pane, it emits best-effort progress into
// the UI already on screen — it renames the pane/agent to the slice being built, and
// fires a notification when the run halts or completes. A two-hour run stops being
// invisible and becomes a live status board, at almost no cost because the UI exists.
//
// Three hard rules make this safe to add without a new dependency:
//   1. STRICTLY best-effort — detect the environment; if Herdr is absent, do nothing
//      and say nothing (no warning). Outside a pane the surface is a silent no-op.
//   2. NEVER fail or delay a run — every emit swallows all errors, including the
//      `herdr` CLI being absent (ENOENT). The sequencer must still run in CI and in a
//      bare terminal, which is the whole reason it owns its worktree rather than
//      delegating to a multiplexer.
//   3. No required dependency — detection is a plain env-var read; emission shells out
//      to the `herdr` CLI only if the environment says a pane is present, and a missing
//      binary is swallowed like any other failure.
//
// Kept pure where it matters: detection, the pane title, and the command each emit
// runs are unit-testable functions; only the injected `spawn` touches the process.

// The environment variable Herdr sets inside every pane it manages: the pane id the
// CLI addresses (e.g. `wR:p2`). Its presence is the whole detection — absent, we are
// not in a Herdr pane. Verified against a live Herdr session (it also injects
// HERDR_ENV, HERDR_TAB_ID, HERDR_WORKSPACE_ID, HERDR_SOCKET_PATH); the name was
// previously guessed as `HERDR_PANE`, which silently disabled the whole surface —
// best-effort emission means a wrong name looks exactly like "not in Herdr".
const HERDR_PANE_ENV = "HERDR_PANE_ID";

// The resolved Herdr context: the pane the CLI addresses. Null when not in a pane.
export interface HerdrContext {
  readonly pane: string;
}

// Detect a Herdr pane from the environment. Returns the context when the pane id is
// present and non-empty, else null — the single point that decides whether anything
// is emitted at all.
export function detectHerdr(env: NodeJS.ProcessEnv): HerdrContext | null {
  const pane = env[HERDR_PANE_ENV];
  return pane ? { pane } : null;
}

// The pane title while a slice is building: compact enough for a tab, and it names the
// spec and the slice's position so a glance reads the whole run's progress.
export function sliceTitle(o: { spec: number; slice: number; position: number; total: number }): string {
  return `spec #${o.spec} · ${o.position}/${o.total} · #${o.slice}`;
}

// The notification fired when the run halts (a failure, an abort, a graceful stop, a
// checkpoint decline, a dry run's halt, a reached ceiling) — the reason travels with it.
export function haltNotice(o: { spec: number; reason: string }): string {
  return `spec #${o.spec} halted: ${o.reason}`;
}

// The notification fired when the run completes — the last slice landed and the final
// spec→base PR opened.
export function completeNotice(o: { spec: number }): string {
  return `spec #${o.spec} complete — final PR opened`;
}

// The `herdr` CLI invocation that renames the pane: `herdr pane rename <pane_id>
// <label>` — the pane id is POSITIONAL and the command lives under the `pane` group.
// Pure so the argv is testable; the surface runs it best-effort.
export function renameCommand(ctx: HerdrContext, title: string): { file: string; args: string[] } {
  return { file: "herdr", args: ["pane", "rename", ctx.pane, title] };
}

// The `herdr` CLI invocation that fires a notification: `herdr notification show
// <title> [--body TEXT]`. Session-scoped, NOT pane-addressed — the CLI has no per-pane
// notify — so it takes no context and the message carries the spec number itself.
export function notifyCommand(message: string): { file: string; args: string[] } {
  return { file: "herdr", args: ["notification", "show", message] };
}

// The injected process runner. Returns void; its result is ignored — the surface never
// acts on a rename or notify outcome, so even a non-zero exit is a no-op.
export type Spawn = (file: string, args: readonly string[]) => unknown;

// The progress surface the loop drives. Outside a Herdr pane every method is a silent
// no-op — nothing is emitted and no warning is printed. Inside one, each method builds
// its command and runs it through the injected spawn, swallowing every error so a
// rename or notification can never fail or delay the run.
export interface HerdrSurface {
  readonly active: boolean;
  renameToSlice(o: { spec: number; slice: number; position: number; total: number }): void;
  notifyHalt(o: { spec: number; reason: string }): void;
  notifyComplete(o: { spec: number }): void;
}

// Build the surface from the environment and a spawn. When not in a Herdr pane the
// spawn is never called; when in one, every call is wrapped so a throw (e.g. the CLI
// binary is absent) is swallowed.
export function createHerdrSurface(env: NodeJS.ProcessEnv, spawn: Spawn): HerdrSurface {
  const ctx = detectHerdr(env);
  const emit = (cmd: { file: string; args: string[] }): void => {
    if (!ctx) return;
    try {
      spawn(cmd.file, cmd.args);
    } catch {
      /* best-effort: never fail or delay a run because a Herdr emit failed */
    }
  };
  return {
    active: ctx !== null,
    renameToSlice(o) {
      if (ctx) emit(renameCommand(ctx, sliceTitle(o)));
    },
    notifyHalt(o) {
      if (ctx) emit(notifyCommand(haltNotice(o)));
    },
    notifyComplete(o) {
      if (ctx) emit(notifyCommand(completeNotice(o)));
    },
  };
}
