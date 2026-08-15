// The status view's frame: a rendered body in, the whole printed view out. The one seam
// both output modes compose through — a one-shot run and a `--watch` redraw — so their
// footer wording, spacing and version identity cannot drift apart (issue #121).
//
// Pure, like `render.mts` next door: it reads no tracker, no terminal, no clock, no
// arguments and no manifest. The RUNNING PACKAGE VERSION — the version declared by the
// exact package copy executing the command — is resolved once by the dispatch half
// (`run.mts`) and handed in, so a watch left open for hours keeps the version it started
// with rather than one a `yarn install` changed underneath it.

export interface WatchMeta {
  // What the redraw loop was given, restated so a still screen says how often it moves.
  readonly intervalMs: number;
  // When this frame was composed. Injected rather than read, so the frame stays pure and
  // the tests get a fixed clock.
  readonly at: Date;
}

// The version, normalised from the executing package's own manifest, or `null` for every
// way that can fail to produce one. `null` is not an error state here: an unreadable
// manifest must never be a reason to withhold the view.
export type RunningVersion = string | null;

// The product name rides beside the number because a bare `1.6.0` in a pane that also holds
// node, yarn and `gh` output belongs to none of them in particular.
const PRODUCT = "agent-workflows";

// `version unknown` rather than `vunknown`: the `v` prefixes a version, and there is none.
function label(version: RunningVersion): string {
  return version === null ? `${PRODUCT} version unknown` : `${PRODUCT} v${version}`;
}

// Deliberately unpainted, unlinked and undimmed, whatever the terminal can do: this line is
// read off a screenshot, out of a pipe and out of a redirected file as often as off a
// screen, and the one thing it has to do is say the same thing in all of them.
export function statusFrame(body: string, version: RunningVersion, watch?: WatchMeta): string {
  if (watch === undefined) return `${body}\n\n${label(version)}`;
  const clock = watch.at.toTimeString().slice(0, 8);
  const seconds = Math.round(watch.intervalMs / 1000);
  return `${body}\n\n${label(version)} · watching every ${seconds}s · updated ${clock} · ctrl-c to stop`;
}

// A parsed manifest in, the running package version out. The read itself belongs to the
// dispatch half; what is decided here is what counts as a version at all — absent, non-string,
// empty and whitespace-only all resolve to unknown, because optional metadata cannot be
// allowed to suppress the view it decorates.
export function packageVersion(manifest: unknown): RunningVersion {
  if (typeof manifest !== "object" || manifest === null) return null;
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  return trimmed === "" ? null : trimmed;
}
