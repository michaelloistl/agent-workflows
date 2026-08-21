// The status view's terminal renderer: a spec tree in, a string out. Pure — no `gh`,
// no writes, and no idea what it is printing to: whether to paint is passed in
// (`options.mts` decides it from the TTY), so both painted and plain output are testable.
//
// Deliberately NOT shared with `spec-report.mts`, which renders the progress comment.
// One function serving both a GitHub comment body and an aligned terminal table makes
// both worse; the DATA is shared (`spec-tree.mts`), the rendering is not (ADR-0007).

import type {
  FinalPrNode,
  FinalPrState,
  SpecNode,
  SliceNode,
  SliceState,
} from "../shared/spec-tree.mts";

export interface StatusView {
  readonly repo: string;
  readonly specs: readonly SpecNode[];
}

export interface RenderOptions {
  // Off by default: a caller that has not thought about the output device is more likely
  // to be piping or capturing than driving a terminal.
  readonly colour?: boolean;
  // Also off by default, and for the same reason. When on, the issue reference is an OSC 8
  // hyperlink to the issue and the trailing URL column is dropped; when off, the URL column
  // is the fallback click target so a reference is never left unreachable. Independent of
  // `colour`: they are separate terminal capabilities (`options.mts` decides each).
  readonly hyperlinks?: boolean;
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

// An OSC 8 hyperlink: the terminal is told the URL through the escape rather than a column
// of visible text. Zero-width on screen, so — like colour — it is applied AFTER padding.
const link = (url: string, text: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

interface Row {
  // The reference (`#N`) is split from what leads it (the state marker, indentation) so the
  // link can wrap the reference alone with the marker left outside it.
  readonly lead: string;
  readonly ref: string;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly tone: Tone;
}

function truncate(title: string): string {
  return title.length <= TITLE_WIDTH ? title : `${title.slice(0, TITLE_WIDTH - 1)}…`;
}

const SPEC_STATE_TEXT: Record<SpecNode["state"], string> = {
  building: "building",
  // Not "waiting for review": the PR does not exist yet, and the party that has not acted
  // is the orchestrator (or a failed advance), never the reader.
  "awaiting-final-pr": "awaiting final PR",
  "final-pr-open": "final PR open",
};

// A final PR reuses the slice glyphs and tones rather than earning its own: the row is a
// third KIND of row, not a third vocabulary, and a reader who has learnt ✓/●/⚠ once should
// not have to learn them again three rows down. `approved` is done-shaped, and every state
// still in the review loop takes the ● the review rows already use — the TEXT is what says
// which of the three it is.
//
// `changes-requested` deliberately does NOT take the loud `blocked` tone, even though it is
// the state that most looks like a problem. Bold red is spent on exactly one thing (see
// `PAINT`): `agent:blocked`, where the fleet has stopped and a human must look. A PR with
// changes requested is the opposite — the human has already looked and ruled, and the ball
// is back with whoever addresses it. Painting it like a halted spec would cost the halted
// spec the prominence the colour exists for.
const FINAL_PR_TONE: Record<FinalPrState, SliceState> = {
  draft: "review",
  ready: "review",
  approved: "done",
  "changes-requested": "review",
};

const FINAL_PR_TEXT: Record<FinalPrState, string> = {
  draft: "draft",
  ready: "ready for review",
  approved: "approved",
  "changes-requested": "changes requested",
};

function specRow(spec: SpecNode): Row {
  const progress = `${spec.closed}/${spec.total}`;
  const state = SPEC_STATE_TEXT[spec.state];
  return {
    lead: "",
    ref: `#${spec.number}`,
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
    lead: `  ${MARKER[state]} `,
    ref: `#${slice.number}`,
    title: truncate(slice.title),
    state: `${cycled ? "blocked (dependency cycle)" : STATE_TEXT[state]}${foreign}`,
    url: slice.url,
    tone: state,
  };
}

// The final PR's row, last under the slices it collects. `PR` leads the reference the way
// a marker does — outside it, so the click target stays exactly the number — because a
// bare `#134` among issue references would read as issue 134.
function finalPrRow(pr: FinalPrNode): Row {
  const tone = FINAL_PR_TONE[pr.state];
  return {
    lead: `  ${MARKER[tone]} PR `,
    ref: `#${pr.number}`,
    title: truncate(pr.title),
    state: FINAL_PR_TEXT[pr.state],
    url: pr.url,
    tone,
  };
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

export function renderStatus(
  { repo, specs }: StatusView,
  { colour = false, hyperlinks = false }: RenderOptions = {},
): string {
  if (specs.length === 0) {
    return [
      `${repo} — nothing is currently building.`,
      "",
      "No open spec issue has a live agent/spec-* branch.",
    ].join("\n");
  }

  const blocks = specs.map((spec) => [
    specRow(spec),
    ...spec.slices.map(sliceRow),
    ...(spec.finalPr ? [finalPrRow(spec.finalPr)] : []),
  ]);
  const rows = blocks.flat();
  const prefixWidth = Math.max(...rows.map((r) => r.lead.length + r.ref.length));
  const titleWidth = Math.max(...rows.map((r) => r.title.length));
  const stateWidth = Math.max(...rows.map((r) => r.state.length));

  // The prefix, padded to width. When hyperlinks are on the reference becomes a link to the
  // issue — done AFTER padding, for the same reason painting is: an OSC 8 escape is
  // zero-width on screen and many characters to `String.length`, so a width measured over
  // it would misalign every column that follows. The marker (in `lead`) stays outside the
  // link, so the click target is exactly the reference.
  const prefix = (r: Row) => {
    const padding = " ".repeat(Math.max(0, prefixWidth - r.lead.length - r.ref.length));
    return `${r.lead}${hyperlinks ? link(r.url, r.ref) : r.ref}${padding}`;
  };

  // Painted AFTER padding and linking, never before, for the same zero-width reason. The
  // URL column is a fallback click target: printed when hyperlinks are off (so a reference
  // is never unreachable), dropped when they are on (the URL rides the escape instead).
  const render = (r: Row) => {
    const paint = colour ? PAINT[r.tone] : PLAIN;
    // With hyperlinks on the state is the last column, so padding it would only trail
    // whitespace; with them off the URL follows, so it is padded to keep that column aligned.
    const state = hyperlinks ? r.state : pad(r.state, stateWidth);
    const url = hyperlinks ? "" : `  ${r.url}`;
    return `${paint(prefix(r))}  ${pad(r.title, titleWidth)}  ${paint(state)}${url}`;
  };

  return [
    `${repo} — ${specs.length} spec${specs.length === 1 ? "" : "s"} in flight`,
    "",
    ...blocks.flatMap((block) => [...block.map(render), ""]),
  ]
    .join("\n")
    .trimEnd();
}
