import { test } from "node:test";
import assert from "node:assert/strict";
import { renderProgress } from "./prd-report.mts";

const BULLETS = [
  { number: 4, blockedBy: [] },
  { number: 5, blockedBy: [4] },
  { number: 6, blockedBy: [] },
];

test("renderProgress marks closed, dispatched, and pending slices in order", () => {
  const out = renderProgress({
    branch: "agent/prd-3-stacked",
    bullets: BULLETS,
    closed: new Set([4]),
    dispatched: 5,
  });
  assert.match(out, /agent\/prd-3-stacked/);
  assert.match(out, /- \[x\] #4$/m);
  assert.match(out, /- \[ \] #5 ◀ building$/m);
  assert.match(out, /- \[ \] #6$/m);
});

test("renderProgress surfaces a deadlocked cycle rather than dropping it", () => {
  const out = renderProgress({
    branch: "agent/prd-3-x",
    bullets: [
      { number: 4, blockedBy: [5] },
      { number: 5, blockedBy: [4] },
    ],
    closed: new Set(),
    dispatched: null,
  });
  assert.match(out, /#4 ⚠ blocked \(dependency cycle\)/);
  assert.match(out, /#5 ⚠ blocked \(dependency cycle\)/);
});
