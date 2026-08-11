import { test } from "node:test";
import assert from "node:assert/strict";
import { specStep } from "./spec-step.mts";
import type { TracerBullet } from "./spec-graph.mts";

// The same three-slice chain the spec-graph tests use: 4 ready, 5 blocked by 4,
// 6 ready. `nextSlice` picks the lowest ready one — so slice selection is driven
// entirely by the spec-graph brain, not re-derived here.
const CHAIN: TracerBullet[] = [
  { number: 4, blockedBy: [] },
  { number: 5, blockedBy: [4] },
  { number: 6, blockedBy: [] },
];

// — Slice selection (delegated to the spec-graph brain) —

test("kickoff dispatches the topologically-first ready slice", () => {
  assert.deepEqual(specStep({ phase: "kickoff", bullets: CHAIN, closed: new Set() }), {
    type: "run-slice",
    slice: 4,
  });
});

test("kickoff is done when no slice is ready (nothing to dispatch)", () => {
  assert.deepEqual(
    specStep({ phase: "kickoff", bullets: CHAIN, closed: new Set([4, 5, 6]) }),
    { type: "done" },
  );
});

test("advance dispatches the next slice once its spec-branch CI passed", () => {
  assert.deepEqual(
    specStep({ phase: "advance", bullets: CHAIN, closed: new Set([4]), checksPassed: true }),
    { type: "run-slice", slice: 5 },
  );
});

// — Gate 2: the spec branch's own CI, before dispatching the next slice (advance) —

test("advance awaits the spec-branch gate before dispatching the next slice", () => {
  assert.deepEqual(specStep({ phase: "advance", bullets: CHAIN, closed: new Set([4]) }), {
    type: "await-checks",
    gate: "spec-branch",
  });
});

test("advance halts (naming the blocked slice) when the spec-branch CI failed", () => {
  assert.deepEqual(
    specStep({ phase: "advance", bullets: CHAIN, closed: new Set([4]), checksPassed: false }),
    { type: "halt", blocked: 5 },
  );
});

// — Gate 1: a finished slice's own PR CI, before merging it into the spec branch —

test("slice-merge awaits the slice-PR gate before merging", () => {
  assert.deepEqual(specStep({ phase: "slice-merge" }), {
    type: "await-checks",
    gate: "slice-pr",
  });
});

test("slice-merge merges once the slice-PR CI passed", () => {
  assert.deepEqual(specStep({ phase: "slice-merge", checksPassed: true }), { type: "merge" });
});

test("slice-merge halts when the slice-PR CI failed", () => {
  assert.deepEqual(specStep({ phase: "slice-merge", checksPassed: false }), {
    type: "halt",
    blocked: null,
  });
});

// — Completion —

test("advance opens the final PR when every slice is closed (no gate)", () => {
  assert.deepEqual(
    specStep({ phase: "advance", bullets: CHAIN, closed: new Set([4, 5, 6]) }),
    { type: "open-final-pr" },
  );
});

test("advance is done (not complete) when the remaining slices deadlock", () => {
  const cycle: TracerBullet[] = [
    { number: 7, blockedBy: [8] },
    { number: 8, blockedBy: [7] },
  ];
  assert.deepEqual(specStep({ phase: "advance", bullets: cycle, closed: new Set() }), {
    type: "done",
  });
});

// Completion is not re-derived: a spec with no tracer-bullets is trivially complete.
test("advance on an empty spec opens the final PR", () => {
  assert.deepEqual(specStep({ phase: "advance", bullets: [], closed: new Set() }), {
    type: "open-final-pr",
  });
});
