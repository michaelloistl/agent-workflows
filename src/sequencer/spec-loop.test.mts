import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveOrder,
  formatPreview,
  parseMergeView,
  mergeConfirmed,
  mergeHaltReason,
  dryRunSuppressed,
  formatSliceHeader,
  formatSliceFooter,
  formatSpecSummary,
  type SpecPlan,
} from "./spec-loop.mts";
import type { TracerBullet } from "../shared/spec-graph.mts";

// The same three-slice chain the spec-step tests use: 4 ready, 5 blocked by 4,
// 6 ready. `nextSlice` picks the lowest ready slice each step, so the order is
// [4, 5, 6] (4 unblocks 5, and 5 < 6).
const CHAIN: TracerBullet[] = [
  { number: 4, blockedBy: [] },
  { number: 5, blockedBy: [4] },
  { number: 6, blockedBy: [] },
];

// — resolveOrder —

test("resolveOrder returns the strict topological build order", () => {
  const { order, deadlocked } = resolveOrder(CHAIN);
  assert.deepEqual(order, [4, 5, 6]);
  assert.deepEqual(deadlocked, []);
});

test("resolveOrder surfaces a dependency cycle as deadlocked, not in the order", () => {
  const cycle: TracerBullet[] = [
    { number: 7, blockedBy: [8] },
    { number: 8, blockedBy: [7] },
  ];
  const { order, deadlocked } = resolveOrder(cycle);
  assert.deepEqual(order, []);
  assert.deepEqual(deadlocked.sort(), [7, 8]);
});

// — formatPreview —

const PLAN: SpecPlan = {
  spec: 3,
  specBranch: "agent/spec-3-stacked",
  base: "main",
  order: [4, 5, 6],
  deadlocked: [],
  dryRun: true,
};

test("formatPreview shows the slice list, branches, and the dry-run mode", () => {
  const out = formatPreview(PLAN);
  assert.match(out, /implement-spec #3 — DRY RUN/);
  assert.match(out, /spec branch : agent\/spec-3-stacked/);
  assert.match(out, /base branch : main/);
  assert.match(out, /1\. #4/);
  assert.match(out, /2\. #5/);
  assert.match(out, /3\. #6/);
  assert.match(out, /DRY RUN — merges/);
});

test("formatPreview names EXECUTE mode when not a dry run", () => {
  const out = formatPreview({ ...PLAN, dryRun: false });
  assert.match(out, /implement-spec #3 — EXECUTE/);
  assert.match(out, /EXECUTE — each slice is merged/);
});

test("formatPreview lists deadlocked slices separately", () => {
  const out = formatPreview({ ...PLAN, order: [4], deadlocked: [7, 8] });
  assert.match(out, /deadlocked \(dependency cycle — not built\):/);
  assert.match(out, /- #7/);
  assert.match(out, /- #8/);
});

// — parseMergeView —

test("parseMergeView prefers the merged PR when several share the head", () => {
  const json = JSON.stringify([
    { number: 10, state: "CLOSED", mergedAt: null, baseRefName: "agent/spec-3-x" },
    { number: 11, state: "MERGED", mergedAt: "2026-08-11T00:00:00Z", baseRefName: "agent/spec-3-x" },
  ]);
  assert.equal(parseMergeView(json)?.number, 11);
});

test("parseMergeView tolerates blank/empty/garbage as null", () => {
  assert.equal(parseMergeView(""), null);
  assert.equal(parseMergeView("[]"), null);
  assert.equal(parseMergeView("not json"), null);
});

// — mergeConfirmed —

test("mergeConfirmed is true only for a PR merged into the exact spec branch", () => {
  assert.equal(
    mergeConfirmed(
      { number: 11, state: "MERGED", mergedAt: "2026-08-11T00:00:00Z", baseRefName: "agent/spec-3-x" },
      "agent/spec-3-x",
    ),
    true,
  );
});

test("mergeConfirmed is false for a queued (still open) merge", () => {
  assert.equal(
    mergeConfirmed(
      { number: 11, state: "OPEN", mergedAt: null, baseRefName: "agent/spec-3-x" },
      "agent/spec-3-x",
    ),
    false,
  );
});

test("mergeConfirmed is false for a merge into a different base (a stale view)", () => {
  assert.equal(
    mergeConfirmed(
      { number: 11, state: "MERGED", mergedAt: "2026-08-11T00:00:00Z", baseRefName: "main" },
      "agent/spec-3-x",
    ),
    false,
  );
});

test("mergeConfirmed is false when no PR was found", () => {
  assert.equal(mergeConfirmed(null, "agent/spec-3-x"), false);
});

// — mergeHaltReason —

test("mergeHaltReason names the missing merge when no PR was found", () => {
  const r = mergeHaltReason(null, 4, "agent/spec-3-x");
  assert.match(r, /no PR into `agent\/spec-3-x` was found merged/);
  assert.match(r, /next slice is NOT built/);
});

test("mergeHaltReason names the PR's actual state when it did not land", () => {
  const r = mergeHaltReason(
    { number: 11, state: "OPEN", mergedAt: null, baseRefName: "agent/spec-3-x" },
    4,
    "agent/spec-3-x",
  );
  assert.match(r, /PR #11 reads OPEN/);
  assert.match(r, /not merged into `agent\/spec-3-x`/);
});

// — dry-run reporting + framing —

test("dryRunSuppressed prefixes the suppressed action", () => {
  assert.equal(
    dryRunSuppressed("merge PR #12 into agent/spec-3-x"),
    "  ⟂ [dry-run] would merge PR #12 into agent/spec-3-x",
  );
});

test("formatSliceHeader frames a slice with its position", () => {
  const out = formatSliceHeader({ position: 2, total: 3, slice: 6, specBranch: "agent/spec-3-x" });
  assert.match(out, /slice 2\/3: #6 → agent\/spec-3-x/);
});

test("formatSliceFooter distinguishes merged, would-merge, and built", () => {
  assert.match(formatSliceFooter({ slice: 4, outcome: "merged" }), /merged into the spec branch/);
  assert.match(formatSliceFooter({ slice: 4, outcome: "would-merge" }), /merge suppressed \(dry run\)/);
  assert.match(formatSliceFooter({ slice: 4, outcome: "built" }), /built \(not merged\)/);
});

// — summary —

test("formatSpecSummary reports a completed real run and the final PR", () => {
  const out = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: false,
    merged: [4, 6, 5],
    halted: null,
    finalPrOpened: true,
  });
  assert.match(out, /implement-spec #3: run complete/);
  assert.match(out, /slices merged : #4, #6, #5/);
  assert.match(out, /final PR : opened for agent\/spec-3-x/);
});

test("formatSpecSummary reports where a run halted", () => {
  const out = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: false,
    merged: [4],
    halted: { slice: 6, reason: "the spec branch CI did not pass" },
    finalPrOpened: false,
  });
  assert.match(out, /run halted/);
  assert.match(out, /halted at #6: the spec branch CI did not pass/);
});

test("formatSpecSummary reports a dry run as previewed", () => {
  const out = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: true,
    merged: [4],
    halted: { slice: 4, reason: "dry run — stopped before the merge" },
    finalPrOpened: false,
  });
  assert.match(out, /dry run halted/);
  assert.match(out, /slices previewed : #4/);
});
