import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatus } from "./render.mts";
import type { FinalPrNode, SliceNode, SpecNode } from "../shared/spec-tree.mts";

function slice(over: Partial<SliceNode> & { number: number }): SliceNode {
  return {
    title: `slice ${over.number}`,
    url: `https://github.com/o/r/issues/${over.number}`,
    state: "pending",
    cycle: false,
    foreignBlockers: [],
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

// A native blocker in another repository is left out of the ordering, because its number
// means nothing in this repo (issue #99). The row has to say so: a slice waiting on
// another repo is waiting on something no local close will ever clear, and unstated it
// looks merely pending.
test("a blocker in another repository is named on the row it holds up", () => {
  const out = renderStatus({
    repo: "o/r",
    specs: [
      spec({
        number: 94,
        slices: [slice({ number: 95, foreignBlockers: ["other/repo#12"] })],
      }),
    ],
  });
  const row = rowFor(out, 95);
  assert.match(row, /pending/);
  assert.match(row, /other\/repo#12/);
});

test("a slice with no foreign blockers says nothing about them", () => {
  assert.doesNotMatch(renderStatus(VIEW), /waits on/);
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

// Hyperlinks (issue #105). The renderer is told whether to link, the same way it is told
// whether to paint; `options.mts` decides it from the TTY. An OSC 8 hyperlink wraps the
// text between an opening `\x1b]8;;URL\x1b\` and a closing `\x1b]8;;\x1b\`. As with the
// colour escapes above, a `/g` copy carries `lastIndex` and a plain copy is what the
// assertions use.
const OSC8 = /\x1b\]8;;[^\x1b]*\x1b\\/g;
const OSC8_ONE = /\x1b\]8;;[^\x1b]*\x1b\\/;
const unlink = (text: string) => text.replace(OSC8, "");
// The text a hyperlink to `url` wraps, or null if that url is linked nowhere in `out`.
const linkedText = (out: string, url: string) => {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\x1b\\]8;;${escaped}\\x1b\\\\([^\\x1b]*)\\x1b\\]8;;\\x1b\\\\`).exec(out);
  return m ? m[1] : null;
};
// `rowFor` matches on a trailing space after the reference, which the closing hyperlink
// escape displaces — so unlink first, then find the row.
const linkedRowFor = (out: string, issue: number) => rowFor(unlink(out), issue);

test("the issue reference is a hyperlink to the issue on every row", () => {
  const out = renderStatus(VIEW, { hyperlinks: true });
  for (const n of [94, 95, 96, 97]) {
    assert.equal(
      linkedText(out, `https://github.com/o/r/issues/${n}`),
      `#${n}`,
      `#${n} is the click target`,
    );
  }
});

test("the state marker sits outside the link, so only the reference is clickable", () => {
  const out = renderStatus(VIEW, { hyperlinks: true });
  // The building slice's marker precedes the opening hyperlink escape, with no ▸ inside it.
  assert.match(out, /▸ \x1b\]8;;[^\x1b]*\x1b\\#96\x1b\]8;;\x1b\\/, "▸ before the link, #96 inside");
});

test("the trailing URL column is gone when hyperlinks are on", () => {
  const out = renderStatus(VIEW, { hyperlinks: true });
  // The URL rides the escape now, not a visible column: it never appears as plain text.
  assert.doesNotMatch(unlink(out), /https:\/\//);
});

test("the URL column is printed with no escapes when hyperlinks are off", () => {
  const out = renderStatus(VIEW, { hyperlinks: false });
  assert.doesNotMatch(out, OSC8_ONE);
  for (const n of [94, 95, 96, 97]) {
    assert.match(out, new RegExp(`https://github\\.com/o/r/issues/${n}\\b`));
  }
});

test("hyperlinks default off, so a piped view carries no OSC 8 escapes", () => {
  assert.doesNotMatch(renderStatus(VIEW), OSC8_ONE);
});

// The single most likely regression: an OSC 8 sequence is zero-width on screen but many
// characters to `String.length`, so linking must happen AFTER padding. To catch a
// pad-over-link bug the rows must need DIFFERENT amounts of prefix padding — a `#94`
// heading (ref 3), a `#1` slice (prefix 6) and a `#2000` slice (the widest, prefix 8) all
// pad out to the same width, so their title columns must line up. Measured over the escape
// that padding collapses, pulling the shorter refs' titles left; rows of equal prefix width
// would align either way and prove nothing.
test("columns stay aligned with hyperlinks on, across differing prefix widths", () => {
  const out = renderStatus(
    {
      repo: "o/r",
      specs: [
        spec({
          number: 94,
          title: "Status view",
          slices: [
            slice({ number: 1, title: "short", state: "building" }),
            slice({ number: 2000, title: "y".repeat(40), state: "pending" }),
          ],
        }),
      ],
    },
    { hyperlinks: true },
  );
  const titleOffset = (issue: number, title: string) =>
    unlink(linkedRowFor(out, issue)).indexOf(title);
  // The heading needs the most padding and the widest slice needs none; if any of the three
  // disagrees, padding was measured over the link.
  assert.equal(titleOffset(94, "Status view"), titleOffset(1, "short"));
  assert.equal(titleOffset(1, "short"), titleOffset(2000, "y".repeat(40)));
});

// The empty view returns before any row is built, so — like the colour case above — it is
// the one branch that could emit an escape by accident without a test saying otherwise.
test("the empty view carries no hyperlinks on a terminal either", () => {
  assert.doesNotMatch(renderStatus({ repo: "o/r", specs: [] }, { hyperlinks: true }), OSC8_ONE);
});

// A row can be both painted and linked: the colour wraps the whole prefix, the link wraps
// only the reference inside it, and neither eats the other.
test("a row is painted and linked at once", () => {
  const out = renderStatus(VIEW, { colour: true, hyperlinks: true });
  assert.equal(linkedText(out, "https://github.com/o/r/issues/96"), "#96", "still linked");
  assert.ok(escapesOn(linkedRowFor(out, 96)).length > 0, "still painted");
});

// The FINAL PR row (ADR-0007, amended). Without it, `awaiting final PR` blamed the
// orchestrator for a PR that had been sitting open waiting for a human for days.

function withFinalPr(finalPr: Partial<FinalPrNode> = {}) {
  return {
    repo: "o/r",
    specs: [
      spec({
        number: 94,
        title: "Status view",
        state: "final-pr-open" as const,
        slices: [slice({ number: 95, state: "done" })],
        finalPr: {
          number: 134,
          title: "Show the final PR",
          url: "https://github.com/o/r/pull/134",
          state: "draft" as const,
          ...finalPr,
        },
      }),
    ],
  };
}

test("the final PR is a row of its own, last, beneath the slices", () => {
  const rows = renderStatus(withFinalPr())
    .split("\n")
    .filter((l) => /#\d+/.test(l));
  assert.match(rows[0], /^#94\b/);
  assert.match(rows[1], /^ +✓ #95\b/);
  assert.match(rows[2], /^ +● PR #134 +Show the final PR/);
});

// Its OWN title, not the spec's. `openFinalPr` copies the spec title into the PR, so the
// two usually read alike — and the one case they diverge, someone retitled the PR, is
// exactly the case a copy of the spec title would hide.
test("the PR row carries the PR's own title", () => {
  const out = renderStatus(withFinalPr({ title: "Retitled by a human" }));
  assert.match(rowFor(out, 134), /Retitled by a human/);
});

test("the spec row says its final PR is open rather than awaited", () => {
  const out = renderStatus(withFinalPr());
  assert.match(out, /^#94 .*1\/1 · final PR open/m);
  assert.doesNotMatch(out, /awaiting final PR/);
});

// The question the row exists to answer is "is a human the gate, or am I".
test("each PR state names who is holding it up", () => {
  const stateOf = (state: FinalPrNode["state"]) => rowFor(renderStatus(withFinalPr({ state })), 134);
  assert.match(stateOf("draft"), /\bdraft\b/);
  assert.match(stateOf("ready"), /ready for review/);
  assert.match(stateOf("approved"), /\bapproved\b/);
  assert.match(stateOf("changes-requested"), /changes requested/);
});

// The markers are the slice ones reused: an approved PR is done-shaped, one with changes
// requested is the same ⚠ that means stop and look, and the two waiting states are the ●
// the review rows already use.
test("the PR row is marked with the same glyphs the slices use", () => {
  const marked = (state: FinalPrNode["state"], marker: string) =>
    assert.match(rowFor(renderStatus(withFinalPr({ state })), 134), new RegExp(`^ +${marker} PR`));
  marked("approved", "✓");
  marked("changes-requested", "⚠");
  marked("draft", "●");
  marked("ready", "●");
});

test("the PR row carries its URL, and links the reference when asked", () => {
  assert.match(renderStatus(withFinalPr()), /https:\/\/github\.com\/o\/r\/pull\/134\b/);
  const linked = renderStatus(withFinalPr(), { hyperlinks: true });
  assert.equal(linkedText(linked, "https://github.com/o/r/pull/134"), "#134");
  // `PR` leads the reference the way a marker does, outside the link.
  assert.match(linked, /PR \x1b\]8;;[^\x1b]*\x1b\\#134\x1b\]8;;\x1b\\/);
});

// Same rule as every other row: the escapes are zero-width on screen, so a `PR #134`
// prefix must be padded before it is painted or linked, never after.
test("the PR row leaves the columns aligned", () => {
  const out = renderStatus(withFinalPr(), { hyperlinks: true });
  const titleOffset = (issue: number, title: string) =>
    unlink(linkedRowFor(out, issue)).indexOf(title);
  assert.equal(titleOffset(94, "Status view"), titleOffset(134, "Show the final PR"));
  assert.equal(strip(renderStatus(withFinalPr(), { colour: true })), renderStatus(withFinalPr()));
});
