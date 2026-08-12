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

// Every state at once, so the colour tests can compare them against each other.
const EVERY_STATE = {
  repo: "o/r",
  specs: [
    spec({
      number: 94,
      slices: [
        slice({ number: 1, state: "done" }),
        slice({ number: 2, state: "building" }),
        slice({ number: 3, state: "review" }),
        slice({ number: 4, state: "blocked" }),
        slice({ number: 5, state: "pending" }),
      ],
    }),
  ],
};

// Two copies on purpose: a `/g` regex carries `lastIndex` between calls, so the one the
// assertions use must not be the one `match`/`replace` advances.
const ESCAPES = /\x1b\[[0-9;]*m/g;
const ESCAPE = /\x1b\[[0-9;]*m/;
const strip = (text: string) => text.replace(ESCAPES, "");
const escapesOn = (line: string) => line.match(ESCAPES)?.join("") ?? "";
const rowFor = (out: string, issue: number) =>
  out.split("\n").find((l) => strip(l).includes(`#${issue} `))!;

// The SGR parameters a line sets, e.g. `\x1b[1;31m` → ["1", "31"]. Compared as parameters
// rather than by substring, because `\x1b[31m` contains "1" without being bold.
const sgrParams = (line: string) =>
  [...line.matchAll(/\x1b\[([0-9;]*)m/g)].flatMap((m) => m[1].split(";").filter(Boolean));
const BOLD = "1";

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

// Colour (issue #97). The renderer is told whether to paint; deciding that from the TTY
// is `options.mts`'s job, so both halves of the behaviour are testable without one.

test("no colour by default, so a piped or captured view is clean text", () => {
  assert.doesNotMatch(renderStatus(EVERY_STATE), ESCAPE);
  assert.doesNotMatch(renderStatus(EVERY_STATE, { colour: false }), ESCAPE);
  assert.doesNotMatch(renderStatus({ repo: "o/r", specs: [] }, { colour: false }), ESCAPE);
});

// The empty view returns before any row is built, so it is the one branch that could
// paint by accident without a test saying otherwise.
test("the empty view is plain prose on a terminal too", () => {
  assert.doesNotMatch(renderStatus({ repo: "o/r", specs: [] }, { colour: true }), ESCAPE);
});

test("each slice state is painted differently from every other", () => {
  const out = renderStatus(EVERY_STATE, { colour: true });
  const codes = [1, 2, 3, 4, 5].map((n) => escapesOn(rowFor(out, n)));
  assert.ok(
    codes.every(Boolean),
    "every slice row carries colour",
  );
  assert.equal(new Set(codes).size, codes.length, "no two states share a rendering");
});

test("blocked is the only bold row on screen, because it means stop and look", () => {
  const out = renderStatus(EVERY_STATE, { colour: true });
  assert.ok(sgrParams(rowFor(out, 4)).includes(BOLD), "blocked is bold");
  // Every other row, spec heading included: bold is what makes blocked stand out, so
  // nothing else may spend it.
  const others = out.split("\n").filter((line) => line !== rowFor(out, 4));
  for (const line of others) {
    assert.ok(!sgrParams(line).includes(BOLD), `not bold: ${JSON.stringify(line)}`);
  }
});

test("a cycled slice is painted like a blocked one", () => {
  const cycles = renderStatus(
    { repo: "o/r", specs: [spec({ number: 94, slices: [slice({ number: 1, cycle: true })] })] },
    { colour: true },
  );
  assert.equal(escapesOn(rowFor(cycles, 1)), escapesOn(rowFor(renderStatus(EVERY_STATE, { colour: true }), 4)));
});

// Colour has to be invisible to layout: the codes are zero-width on screen but not to
// `String.length`, so padding computed over painted text would misalign every column.
test("colour changes nothing but the escapes", () => {
  assert.equal(strip(renderStatus(EVERY_STATE, { colour: true })), renderStatus(EVERY_STATE));
  assert.equal(strip(renderStatus(VIEW, { colour: true })), renderStatus(VIEW));
});
