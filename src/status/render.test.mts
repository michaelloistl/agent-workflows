import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatus } from "./render.mts";
import type { SliceNode, SpecNode } from "../shared/spec-tree.mts";

function slice(over: Partial<SliceNode> & { number: number }): SliceNode {
  return {
    title: `slice ${over.number}`,
    url: `https://github.com/o/r/issues/${over.number}`,
    state: "pending",
    cycle: false,
    ...over,
  };
}

function spec(over: Partial<SpecNode> & { number: number }): SpecNode {
  const slices = over.slices ?? [];
  return {
    title: `spec ${over.number}`,
    url: `https://github.com/o/r/issues/${over.number}`,
    branch: `agent/spec-${over.number}-x`,
    state: "building",
    closed: slices.filter((s) => s.state === "done").length,
    total: slices.length,
    ...over,
    slices,
  };
}

const VIEW = {
  repo: "o/r",
  specs: [
    spec({
      number: 94,
      title: "Status view",
      slices: [
        slice({ number: 95, title: "Walking skeleton", state: "done" }),
        slice({ number: 96, title: "Native parents", state: "building" }),
        slice({ number: 97, title: "Colour" }),
      ],
    }),
  ],
};

test("renders slices nested under their spec, in the order given", () => {
  const lines = renderStatus(VIEW).split("\n");
  const rows = lines.filter((l) => /#\d+/.test(l));
  assert.match(rows[0], /^#94\b/);
  assert.deepEqual(
    rows.slice(1).map((l) => /#(\d+)/.exec(l)![1]),
    ["95", "96", "97"],
  );
  assert.ok(
    rows.slice(1).every((l) => l.startsWith("  ")),
    "slice rows are indented beneath the spec",
  );
});

test("marks the building slice and states every other one", () => {
  const out = renderStatus(VIEW);
  assert.match(out, /^ *✓ #95 .*\bdone\b/m);
  assert.match(out, /^ *▸ #96 .*\bbuilding\b/m);
  assert.match(out, /^ *#97 .*\bpending\b/m);
});

test("a spec row carries its progress count", () => {
  assert.match(renderStatus(VIEW), /^#94 .*\b1\/3\b/m);
});

test("a spec whose slices have all closed is shown awaiting its final PR", () => {
  const out = renderStatus({
    repo: "o/r",
    specs: [
      spec({
        number: 94,
        state: "awaiting-final-pr",
        slices: [slice({ number: 95, state: "done" })],
      }),
    ],
  });
  assert.match(out, /^#94 .*awaiting final PR/m);
});

test("blocked and cycled slices are called out", () => {
  const out = renderStatus({
    repo: "o/r",
    specs: [
      spec({
        number: 94,
        slices: [
          slice({ number: 95, state: "blocked" }),
          slice({ number: 96, cycle: true }),
        ],
      }),
    ],
  });
  assert.match(out, /^ *⚠ #95 .*\bblocked\b/m);
  assert.match(out, /#96 .*dependency cycle/);
});

// The cycle is computed from the dependency edges alone, which know nothing about what
// has landed — so a pair of mutually blocking slices stays "cycled" after both close.
// Reporting a finished slice as blocked is a false alarm on a spec that is fine.
test("a closed slice is done even when it sits in a cycle", () => {
  const out = renderStatus({
    repo: "o/r",
    specs: [
      spec({
        number: 94,
        state: "awaiting-final-pr",
        slices: [slice({ number: 95, state: "done", cycle: true })],
      }),
    ],
  });
  assert.match(out, /^ *✓ #95 .*\bdone\b/m);
  assert.doesNotMatch(out, /dependency cycle/);
});

test("every row carries its issue URL so the terminal can linkify it", () => {
  const out = renderStatus(VIEW);
  for (const n of [94, 95, 96, 97]) {
    assert.match(out, new RegExp(`https://github\\.com/o/r/issues/${n}\\b`));
  }
});

test("the empty view says nothing is building rather than looking broken", () => {
  const out = renderStatus({ repo: "o/r", specs: [] });
  assert.match(out, /o\/r/);
  assert.match(out, /nothing is currently building/i);
  assert.doesNotMatch(out, /#\d+/);
});

test("the header counts the specs in flight", () => {
  assert.match(renderStatus(VIEW), /^o\/r — 1 spec in flight$/m);
  assert.match(
    renderStatus({ repo: "o/r", specs: [spec({ number: 1 }), spec({ number: 2 })] }),
    /^o\/r — 2 specs in flight$/m,
  );
});

test("a long title is truncated so the columns stay readable", () => {
  const out = renderStatus({
    repo: "o/r",
    specs: [spec({ number: 94, title: "x".repeat(200) })],
  });
  assert.ok(!out.includes("x".repeat(200)), "the full title is not printed");
  assert.match(out, /x…/);
});
