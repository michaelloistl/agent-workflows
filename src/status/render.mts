// The status view's terminal renderer: a spec tree in, a string out. Pure — no `gh`,
// no writes, and no idea what it is printing to: whether to paint is passed in
// (`options.mts` decides it from the TTY), so both painted and plain output are testable.
//
// Deliberately NOT shared with `spec-report.mts`, which renders the progress comment.
// One function serving both a GitHub comment body and an aligned terminal table makes
// both worse; the DATA is shared (`spec-tree.mts`), the rendering is not (ADR-0007).

import type { SpecNode, SliceNode, SliceState } from "../shared/spec-tree.mts";

export interface StatusView {
  readonly repo: string;
  readonly specs: readonly SpecNode[];
}

export interface RenderOptions {
  // Off by default: a caller that has not thought about the output device is more likely
  // to be piping or capturing than driving a terminal.
  readonly colour?: boolean;
}

// Long enough for a real issue title, short enough that the state and URL columns stay
// on one line in a normal terminal.
const TITLE_WIDTH = 56;

const MARKER: Record<SliceState, string> = {
  done: "✓",
  building: "▸",
  review: "●",
  blocked: "⚠",
  pending: " ",
};

const STATE_TEXT: Record<SliceState, string> = {
  done: "done",
  building: "building",
  review: "in review",
  blocked: "blocked",
  pending: "pending",
};

// What a row IS, not how it looks: a row carries a tone and the palette turns that into
// escapes, so no row ever holds a colour of its own.
type Tone = SliceState | "spec";

type Paint = (text: string) => string;

const PLAIN: Paint = (text) => text;

const ansi =
  (...codes: number[]): Paint =>
  (text) =>
    `\x1b[${codes.join(";")}m${text}\x1b[0m`;

// Bold is spent on exactly one thing: `agent:blocked`, the one state that means stop and
// look. The rest are told apart by hue alone, `pending` is dimmed because "not started
// yet" is what nobody needs to scan for, and the spec heading is left unpainted —
// bolding it as well would cost the blocked row the prominence it is bold FOR.
const PAINT: Record<Tone, Paint> = {
  done: ansi(32),
  building: ansi(36),
  review: ansi(33),
  blocked: ansi(1, 31),
  pending: ansi(2),
  spec: PLAIN,
};

interface Row {
  readonly prefix: string;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly tone: Tone;
}

function truncate(title: string): string {
  return title.length <= TITLE_WIDTH ? title : `${title.slice(0, TITLE_WIDTH - 1)}…`;
}

function specRow(spec: SpecNode): Row {
  const progress = `${spec.closed}/${spec.total}`;
  const state = spec.state === "awaiting-final-pr" ? "awaiting final PR" : "building";
  return {
    prefix: `#${spec.number}`,
    title: truncate(spec.title),
    state: `${progress} · ${state}`,
    url: spec.url,
    tone: "spec",
  };
}

function sliceRow(slice: SliceNode): Row {
  // A cycled slice is one the orchestrator will never dispatch, so the cycle is what
  // the row reports — UNLESS the slice is already closed. `topologicalOrder` reasons
  // about the edges alone and knows nothing about what has landed, so two mutually
  // blocking slices stay "cycled" long after both are done; reporting a finished slice
  // as blocked is a false alarm on exactly the spec that needs no attention at all.
  const cycled = slice.cycle && slice.state !== "done";
  // A cycle IS blocked as far as the row is concerned — same marker, same colour — so it
  // becomes that state once, here, and only the state TEXT names the cause.
  const state: SliceState = cycled ? "blocked" : slice.state;
  // A blocker in another repository is not in this build order at all — nothing here will
  // ever close it — so the row names it rather than reading as plain `pending`. Qualified
  // with its repo, since a bare `#12` would be read as this repo's.
  const foreign = slice.foreignBlockers.length
    ? ` · waits on ${slice.foreignBlockers.join(", ")}`
    : "";
  return {
    prefix: `  ${MARKER[state]} #${slice.number}`,
    title: truncate(slice.title),
    state: `${cycled ? "blocked (dependency cycle)" : STATE_TEXT[state]}${foreign}`,
    url: slice.url,
    tone: state,
  };
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

export function renderStatus({ repo, specs }: StatusView, { colour = false }: RenderOptions = {}): string {
  if (specs.length === 0) {
    return [
      `${repo} — nothing is currently building.`,
      "",
      "No open spec issue has a live agent/spec-* branch.",
    ].join("\n");
  }

  const blocks = specs.map((spec) => [specRow(spec), ...spec.slices.map(sliceRow)]);
  const rows = blocks.flat();
  const prefixWidth = Math.max(...rows.map((r) => r.prefix.length));
  const titleWidth = Math.max(...rows.map((r) => r.title.length));
  const stateWidth = Math.max(...rows.map((r) => r.state.length));

  // Painted AFTER padding, never before: an escape sequence is zero-width on screen and
  // several characters to `String.length`, so widths measured over painted text would
  // misalign every column that follows.
  const render = (r: Row) => {
    const paint = colour ? PAINT[r.tone] : PLAIN;
    return `${paint(pad(r.prefix, prefixWidth))}  ${pad(r.title, titleWidth)}  ${paint(pad(r.state, stateWidth))}  ${r.url}`;
  };

  return [
    `${repo} — ${specs.length} spec${specs.length === 1 ? "" : "s"} in flight`,
    "",
    ...blocks.flatMap((block) => [...block.map(render), ""]),
  ]
    .join("\n")
    .trimEnd();
}
