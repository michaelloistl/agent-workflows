import { test } from "node:test";
import assert from "node:assert/strict";
import { parentRef, blockedByRefs, tracerBullets, nextSlice, isComplete, topologicalOrder } from "./spec-graph.mts";

// A tracer-bullet body parented to `spec` with the given blockers.
function bullet(spec: number, blockers: number[]): string {
  const blocked = blockers.length ? blockers.map((n) => `- #${n}`).join("\n") : "None";
  return `## Parent\n#${spec}\n\n## Blocked by\n${blocked}`;
}

test("parentRef reads the spec number from the Parent section, ignoring #N elsewhere", () => {
  const body = [
    "## Parent",
    "#3",
    "",
    "## What to build",
    "Builds on the work in #99 and closes #100.",
    "",
    "## Blocked by",
    "- #5",
  ].join("\n");
  assert.equal(parentRef(body), 3);
});

test("parentRef returns null when there is no Parent section", () => {
  assert.equal(parentRef("## What to build\nstandalone issue, see #7"), null);
});

test("blockedByRefs lists the section's refs, ignoring #N outside it", () => {
  const body = ["## What to build", "touches #99", "## Blocked by", "- #5", "- #6"].join("\n");
  assert.deepEqual(blockedByRefs(body), [5, 6]);
});

test("blockedByRefs returns [] for a 'None' section", () => {
  const body = ["## Blocked by", "None - can start immediately"].join("\n");
  assert.deepEqual(blockedByRefs(body), []);
});

test("tracerBullets keeps only candidates parented to the spec, with their edges", () => {
  const candidates = [
    { number: 4, body: bullet(3, []) },
    { number: 5, body: bullet(3, [4]) },
    { number: 9, body: bullet(8, []) }, // a different spec's slice
    { number: 10, body: "## What to build\nunrelated standalone issue" },
  ];
  assert.deepEqual(tracerBullets(3, candidates), [
    { number: 4, blockedBy: [] },
    { number: 5, blockedBy: [4] },
  ]);
});

const CHAIN: { number: number; blockedBy: number[] }[] = [
  { number: 4, blockedBy: [] },
  { number: 5, blockedBy: [4] },
  { number: 6, blockedBy: [] },
];

test("nextSlice picks the lowest-numbered ready slice, advancing as blockers close", () => {
  assert.equal(nextSlice(CHAIN, new Set()), 4); // 4 and 6 ready → lowest
  assert.equal(nextSlice(CHAIN, new Set([4])), 5); // 5 now unblocked, lower than 6
  assert.equal(nextSlice(CHAIN, new Set([4, 5])), 6);
  assert.equal(nextSlice(CHAIN, new Set([4, 5, 6])), null); // all closed
});

test("nextSlice ignores blockers outside the spec's own slice set", () => {
  // #100 is not a tracer-bullet of this spec — the implement guard handles it, not us.
  const bullets = [{ number: 4, blockedBy: [100] }];
  assert.equal(nextSlice(bullets, new Set()), 4);
});

test("nextSlice returns null on a cycle rather than hanging", () => {
  const cycle = [
    { number: 4, blockedBy: [5] },
    { number: 5, blockedBy: [4] },
  ];
  assert.equal(nextSlice(cycle, new Set()), null);
});

test("isComplete is true iff every tracer-bullet is closed", () => {
  assert.equal(isComplete(CHAIN, new Set([4, 5])), false);
  assert.equal(isComplete(CHAIN, new Set([4, 5, 6])), true);
  assert.equal(isComplete([], new Set()), true);
});

test("topologicalOrder is nextSlice applied until done, partial on a cycle", () => {
  assert.deepEqual(topologicalOrder(CHAIN), [4, 5, 6]);
  assert.deepEqual(
    topologicalOrder([
      { number: 4, blockedBy: [5] },
      { number: 5, blockedBy: [4] },
    ]),
    [],
  );
});
