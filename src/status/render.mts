// The status view's terminal renderer: a spec tree in, a string out. Pure — no `gh`,
// no writes, no colour yet (issue #97 adds it, TTY-detected).
//
// Deliberately NOT shared with `spec-report.mts`, which renders the progress comment.
// One function serving both a GitHub comment body and an aligned terminal table makes
// both worse; the DATA is shared (`spec-tree.mts`), the rendering is not (ADR-0007).

import type { SpecNode, SliceNode, SliceState } from "../shared/spec-tree.mts";

export interface StatusView {
  readonly repo: string;
  readonly specs: readonly SpecNode[];
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

interface Row {
  readonly prefix: string;
  readonly title: string;
  readonly state: string;
  readonly url: string;
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
  };
}

function sliceRow(slice: SliceNode): Row {
  // A cycled slice is one the orchestrator will never dispatch, so the cycle is what
  // the row reports — UNLESS the slice is already closed. `topologicalOrder` reasons
  // about the edges alone and knows nothing about what has landed, so two mutually
  // blocking slices stay "cycled" long after both are done; reporting a finished slice
  // as blocked is a false alarm on exactly the spec that needs no attention at all.
  const cycled = slice.cycle && slice.state !== "done";
  return {
    prefix: `  ${cycled ? "⚠" : MARKER[slice.state]} #${slice.number}`,
    title: truncate(slice.title),
    state: cycled ? "blocked (dependency cycle)" : STATE_TEXT[slice.state],
    url: slice.url,
  };
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

export function renderStatus({ repo, specs }: StatusView): string {
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

  const render = (r: Row) =>
    `${pad(r.prefix, prefixWidth)}  ${pad(r.title, titleWidth)}  ${pad(r.state, stateWidth)}  ${r.url}`;

  return [
    `${repo} — ${specs.length} spec${specs.length === 1 ? "" : "s"} in flight`,
    "",
    ...blocks.flatMap((block) => [...block.map(render), ""]),
  ]
    .join("\n")
    .trimEnd();
}
