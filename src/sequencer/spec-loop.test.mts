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
  specFlagConflict,
  previewGate,
  sliceDisposition,
  formatCheckpoint,
  checkpointPrompt,
  gracefulStopAcknowledged,
  gracefulStopHaltReason,
  formatResumeGate,
  formatAlreadyMerged,
  ceilingReached,
  hasCeiling,
  formatCeilingConsumption,
  specBranchCutCommands,
  sliceRefusedHaltReason,
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
  runLog: "/tmp/agent-workflows-worktrees/spec-3-run.log",
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

// A run that is auto-accepted by default is a run nobody is necessarily watching, so
// the preview has to say where to read it afterwards — the one moment it is on screen.
test("formatPreview names the run log, so a run left alone can be read later", () => {
  assert.match(formatPreview(PLAN), /run log {5}: \/tmp\/agent-workflows-worktrees\/spec-3-run\.log/);
});

// The Discord run surface's status (ADR-0012). Absent by default, because an
// unconfigured surface is silent and most consuming repos will never configure one.
test("formatPreview says nothing about Discord when the surface has nothing to say", () => {
  assert.doesNotMatch(formatPreview(PLAN), /discord/i);
  assert.doesNotMatch(formatPreview({ ...PLAN, discord: null }), /discord/i);
});

// A failed thread create silences the WHOLE run, so it is stated at the one moment
// the developer is still looking.
test("formatPreview carries the Discord status line when there is one", () => {
  const out = formatPreview({ ...PLAN, discord: "discord     : off (the thread could not be created)" });
  assert.match(out, /^discord {5}: off \(the thread could not be created\)$/m);
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

// A halted run KEEPS the marker (ADR-0009), and the summary is what the developer
// reads at the end of a long run — so the block that says the run halted also says
// the spec is still marked, and what clears it.
test("formatSpecSummary says the marker was kept and how to clear it", () => {
  const out = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: false,
    merged: [4],
    halted: { slice: 6, reason: "paused at a checkpoint — re-run to resume" },
    finalPrOpened: false,
    markerKept: true,
  });
  assert.match(out, /marker : /);
  assert.match(out, /agent:local/);
  assert.match(out, /#3/);
});

// Every other exit — a completed run, a dry run, a halt that never claimed one —
// says nothing about the marker, so today's output is unchanged where nothing is held.
test("formatSpecSummary omits the marker line when no marker is held", () => {
  const out = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: false,
    merged: [4, 6],
    halted: null,
    finalPrOpened: true,
  });
  assert.doesNotMatch(out, /marker : /);
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

// — specFlagConflict (issue #60, narrowed by the unattended default) —
//
// Running straight through is now the DEFAULT, not a flag, so the conflict can only be
// one the developer actually TYPED. `--interactive` on its own implies pausing and
// must be accepted; only the explicit pair is a contradiction.

test("specFlagConflict rejects an explicit --interactive --no-pause pair", () => {
  const msg = specFlagConflict({ interactive: true, noPause: true });
  assert.match(String(msg), /mutually exclusive/);
  assert.match(String(msg), /--interactive/);
  assert.match(String(msg), /--no-pause/);
});

test("specFlagConflict accepts --interactive alone, which implies pausing", () => {
  assert.equal(specFlagConflict({ interactive: true, noPause: false }), null);
  assert.equal(specFlagConflict({ interactive: false, noPause: true }), null);
  assert.equal(specFlagConflict({ interactive: false, noPause: false }), null);
});

// The refusal names --no-pause as a no-op rather than describing behaviour it no
// longer has — it asks for the straight-through run that is already the default.
test("specFlagConflict's message does not credit --no-pause with running anything", () => {
  const msg = String(specFlagConflict({ interactive: true, noPause: true }));
  assert.match(msg, /already the default/);
  assert.match(msg, /no-op/);
});

// — previewGate: does the run stop to ask, or proceed? —
//
// The loop runs UNATTENDED by default (ADR-0011): the preview is auto-accepted and the
// run proceeds. `--pause` puts the gate back — and it is then a real gate, because a
// non-interactive stdin declines it. The property under test is that proceeding is
// never SILENT: the preview still prints in full, and the notice names both the
// default that accepted it and the two flags that take it back.

test("previewGate proceeds without asking by default", () => {
  const gate = previewGate({ pause: false, yes: false, dryRun: false });
  assert.equal(gate.prompt, null);
  assert.match(String(gate.notice), /REAL merges/);
});

test("previewGate asks the human when --pause is given", () => {
  const gate = previewGate({ pause: true, yes: false, dryRun: false });
  assert.match(String(gate.prompt), /proceed with REAL merges\?/);
  assert.equal(gate.notice, null);
});

// `--yes` survives the flip, and is not merely tolerated: `--interactive` implies
// `--pause`, and `--pause` restores the PREVIEW gate as well as the checkpoints, so
// without `--yes` there would be no way at all to start an interactive run from
// anything that has no terminal to answer with (a non-interactive stdin declines).
test("previewGate lets --yes answer the preview when --pause put the gate back", () => {
  const gate = previewGate({ pause: true, yes: true, dryRun: false });
  assert.equal(gate.prompt, null);
  assert.match(String(gate.notice), /--yes/);
  assert.match(String(gate.notice), /REAL merges/);
});

// It answers that ONE gate only — the checkpoints are `--pause`'s other half and keep
// stopping, which is the whole point of pairing it with `--interactive`.
test("previewGate's --yes notice says the checkpoints still stop", () => {
  const notice = String(previewGate({ pause: true, yes: true, dryRun: false }).notice);
  assert.match(notice, /checkpoints still stop/);
});

// Under the default there is no gate for it to answer, so it changes nothing: the
// notice is the ordinary auto-accepted one, naming the default rather than the flag.
test("previewGate treats --yes as a no-op under the unattended default", () => {
  const withFlag = previewGate({ pause: false, yes: true, dryRun: false });
  assert.deepEqual(withFlag, previewGate({ pause: false, yes: false, dryRun: false }));
  assert.match(String(withFlag.notice), /default/);
});

// The question and the notice are built from one blast-radius string, so they can
// never drift into describing different things.
test("previewGate's prompt and notice name the same blast radius", () => {
  assert.match(String(previewGate({ pause: true, yes: false, dryRun: true }).prompt), /this DRY RUN/);
  assert.match(String(previewGate({ pause: false, yes: false, dryRun: true }).notice), /this DRY RUN/);
  assert.match(String(previewGate({ pause: true, yes: true, dryRun: true }).notice), /this DRY RUN/);
  assert.match(String(previewGate({ pause: true, yes: false, dryRun: false }).prompt), /REAL merges/);
  assert.match(String(previewGate({ pause: false, yes: false, dryRun: false }).notice), /REAL merges/);
});

// Nothing was typed to accept the preview any more, so the notice has to name the
// DEFAULT that accepted it and the way back — otherwise a run that merges for real
// looks like one nobody chose.
test("previewGate's notice names the default and both escape hatches", () => {
  const notice = String(previewGate({ pause: false, yes: false, dryRun: false }).notice);
  assert.match(notice, /default/);
  assert.match(notice, /--pause/);
  assert.match(notice, /--dry-run/);
});

// Only the hatches still available: telling an already-dry run to try `--dry-run` is
// noise, and implies the run is about to merge when it is not.
test("previewGate's notice omits --dry-run when the run is already dry", () => {
  const notice = String(previewGate({ pause: false, yes: false, dryRun: true }).notice);
  assert.match(notice, /--pause/);
  assert.doesNotMatch(notice, /--dry-run/);
});

// `--pause` covers BOTH gates, so the notice must not describe it as only one of them.
test("previewGate's notice says --pause covers the start and the checkpoints", () => {
  const notice = String(previewGate({ pause: false, yes: false, dryRun: false }).notice);
  assert.match(notice, /asked first and between slices/);
});

// — sliceDisposition (issue #60): resume derives from the PR state alone —

const MERGED = {
  number: 12,
  state: "MERGED",
  mergedAt: "2026-08-11T00:00:00Z",
  baseRefName: "agent/spec-3-x",
};
const OPEN = { number: 12, state: "OPEN", mergedAt: null, baseRefName: "agent/spec-3-x" };

test("sliceDisposition treats a PR merged into the spec branch as already-merged", () => {
  assert.equal(sliceDisposition(MERGED, "agent/spec-3-x"), "already-merged");
});

test("sliceDisposition resumes at the gate for an open PR into the spec branch", () => {
  assert.equal(sliceDisposition(OPEN, "agent/spec-3-x"), "resume-gate");
});

test("sliceDisposition builds when there is no PR", () => {
  assert.equal(sliceDisposition(null, "agent/spec-3-x"), "build");
});

test("sliceDisposition builds for a closed-but-not-merged PR (a superseded slice)", () => {
  assert.equal(
    sliceDisposition(
      { number: 12, state: "CLOSED", mergedAt: null, baseRefName: "agent/spec-3-x" },
      "agent/spec-3-x",
    ),
    "build",
  );
});

test("sliceDisposition builds when an open PR targets a different base (a stale head)", () => {
  assert.equal(sliceDisposition({ ...OPEN, baseRefName: "main" }, "agent/spec-3-x"), "build");
});

// — checkpoint framing (issue #60) —

test("formatCheckpoint names the merged slice, the spec branch, and the next slice", () => {
  const out = formatCheckpoint({ lastMerged: 4, next: 5, specBranch: "agent/spec-3-x" });
  assert.match(out, /checkpoint: slice #4 is merged into `agent\/spec-3-x`/);
  assert.match(out, /next slice \(#5\)/);
});

test("checkpointPrompt asks whether to continue to the next slice", () => {
  assert.match(checkpointPrompt(5), /continue to slice #5\? \[y\/N\]/);
});

// — graceful stop (issue #60) —

test("gracefulStopAcknowledged explains the finish-then-halt behaviour and contrasts Ctrl-C", () => {
  const out = gracefulStopAcknowledged();
  assert.match(out, /finishing the current slice/);
  assert.match(out, /next checkpoint/);
  assert.match(out, /Ctrl-C/);
});

test("gracefulStopHaltReason names the last merged slice, or none", () => {
  assert.match(gracefulStopHaltReason(4), /graceful stop after slice #4 merged — re-run to resume/);
  assert.match(gracefulStopHaltReason(null), /before any slice merged/);
});

// — resume notes (issue #60) —

test("formatResumeGate says it resumes the gate and does NOT re-run the agent", () => {
  const out = formatResumeGate({ slice: 5, pr: 12, specBranch: "agent/spec-3-x" });
  assert.match(out, /PR #12 into `agent\/spec-3-x` is already open/);
  assert.match(out, /NOT re-running the agent/);
});

test("formatAlreadyMerged says it advances without rebuilding", () => {
  const out = formatAlreadyMerged({ slice: 5, pr: 12, specBranch: "agent/spec-3-x" });
  assert.match(out, /PR #12 is already merged/);
  assert.match(out, /advancing without rebuilding/);
});

// — run ceiling (issue #61): the decision in the loop's step —

test("ceilingReached is null when no ceiling is configured (today's behaviour)", () => {
  assert.equal(ceilingReached({}, { slicesAttempted: 99, elapsedSeconds: 99999 }), null);
});

test("ceilingReached halts once the slices-attempted ceiling is reached", () => {
  assert.equal(ceilingReached({ maxSlices: 3 }, { slicesAttempted: 2, elapsedSeconds: 0 }), null);
  const r = ceilingReached({ maxSlices: 3 }, { slicesAttempted: 3, elapsedSeconds: 0 });
  assert.match(String(r), /run ceiling reached/);
  assert.match(String(r), /3\/3 slices/);
  assert.match(String(r), /re-run to resume/);
});

test("ceilingReached halts once the wall-clock ceiling is reached", () => {
  assert.equal(
    ceilingReached({ maxWallClockSeconds: 600 }, { slicesAttempted: 1, elapsedSeconds: 599 }),
    null,
  );
  const r = ceilingReached({ maxWallClockSeconds: 600 }, { slicesAttempted: 1, elapsedSeconds: 600 });
  assert.match(String(r), /run ceiling reached/);
  assert.match(String(r), /600s\/600s wall-clock/);
});

test("ceilingReached reports the slices limit first when both are reached", () => {
  const r = ceilingReached(
    { maxSlices: 2, maxWallClockSeconds: 60 },
    { slicesAttempted: 2, elapsedSeconds: 120 },
  );
  assert.match(String(r), /slices attempted/);
});

test("hasCeiling is true only when at least one limit is set", () => {
  assert.equal(hasCeiling({}), false);
  assert.equal(hasCeiling({ maxSlices: 1 }), true);
  assert.equal(hasCeiling({ maxWallClockSeconds: 1 }), true);
});

test("formatCeilingConsumption shows consumed against each set limit", () => {
  assert.equal(
    formatCeilingConsumption({
      slicesAttempted: 2,
      maxSlices: 3,
      elapsedSeconds: 65,
      maxWallClockSeconds: 300,
    }),
    "consumed : 2/3 slices, 65s/300s wall-clock",
  );
});

test("formatCeilingConsumption shows a bare figure for an unconfigured limit", () => {
  assert.equal(
    formatCeilingConsumption({ slicesAttempted: 2, elapsedSeconds: 65, maxWallClockSeconds: 300 }),
    "consumed : 2 slices, 65s/300s wall-clock",
  );
});

// — summary reports the ceiling consumption on exit (issue #61) —

test("formatSpecSummary reports what was consumed against the ceiling", () => {
  const out = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: false,
    merged: [4, 5],
    halted: { slice: 5, reason: "run ceiling reached: 2/2 slices attempted this run." },
    finalPrOpened: false,
    ceiling: { slicesAttempted: 2, maxSlices: 2, elapsedSeconds: 65 },
  });
  assert.match(out, /run halted/);
  assert.match(out, /run ceiling reached/);
  assert.match(out, /consumed : 2\/2 slices, 65s wall-clock/);
});

test("formatSpecSummary surfaces the run log path when given, and omits the line otherwise (issue #62)", () => {
  const withLog = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: false,
    merged: [4],
    halted: null,
    finalPrOpened: true,
    runLog: "/tmp/wt/spec-3-run.log",
  });
  assert.match(withLog, /run log : \/tmp\/wt\/spec-3-run\.log/);
  const withoutLog = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: false,
    merged: [4],
    halted: null,
    finalPrOpened: true,
  });
  assert.doesNotMatch(withoutLog, /run log :/);
});

test("formatSpecSummary omits the consumed line when no ceiling was configured", () => {
  const out = formatSpecSummary({
    spec: 3,
    specBranch: "agent/spec-3-x",
    dryRun: false,
    merged: [4],
    halted: null,
    finalPrOpened: true,
  });
  assert.doesNotMatch(out, /consumed :/);
});

// — Cutting the spec branch —
//
// The cwd carries the whole point of these tests. A cut issued without one runs in
// the developer's own checkout: it moves their HEAD onto the spec branch, and git
// then refuses to check that branch out in the worktree where the slices are built.

test("every spec-branch cut command runs in the run's worktree, never the ambient cwd", () => {
  const cmds = specBranchCutCommands({
    specBranch: "agent/spec-3-x",
    base: "main",
    tree: "/tmp/worktrees/spec-3",
  });
  assert.ok(cmds.length > 0);
  for (const c of cmds) assert.equal(c.cwd, "/tmp/worktrees/spec-3");
});

test("with a base, the cut fetches it, branches off origin/<base>, and pushes upstream", () => {
  assert.deepEqual(
    specBranchCutCommands({ specBranch: "agent/spec-3-x", base: "develop", tree: "/w" }),
    [
      { file: "git", args: ["fetch", "origin", "develop"], cwd: "/w" },
      { file: "git", args: ["checkout", "-B", "agent/spec-3-x", "origin/develop"], cwd: "/w" },
      { file: "git", args: ["push", "-u", "origin", "agent/spec-3-x"], cwd: "/w" },
    ],
  );
});

// No resolvable base: the worktree is already detached AT the base, so branching off
// its HEAD is the same cut — and there is nothing to fetch.
test("with no base, the cut branches off the worktree's HEAD and pushes", () => {
  assert.deepEqual(specBranchCutCommands({ specBranch: "agent/spec-3-x", base: "", tree: "/w" }), [
    { file: "git", args: ["checkout", "-B", "agent/spec-3-x"], cwd: "/w" },
    { file: "git", args: ["push", "-u", "origin", "agent/spec-3-x"], cwd: "/w" },
  ]);
});

// — A refused slice —
//
// A guard refusal exits 0 by design (CI must stay green), so before the outcome seam
// the loop saw "the sequence succeeded", found no merged PR, and blamed the merge.
// The reason must name the step that refused, because that is the thing to go and fix.

test("sliceRefusedHaltReason names the slice and the step that refused", () => {
  const r = sliceRefusedHaltReason({ slice: 81, step: "guards" });
  assert.match(r, /#81/);
  assert.match(r, /guards/);
  // Not a failure, and explicitly not a merge problem.
  assert.match(r, /refused/);
  assert.doesNotMatch(r, /merge/i);
});

test("sliceRefusedHaltReason copes with an unnamed step", () => {
  assert.match(sliceRefusedHaltReason({ slice: 81, step: "" }), /#81/);
});

// A refused slice built nothing at all, so the footer must not say "built" — that is
// the same lie the halt reason was fixed to stop telling, one line further down.
test("formatSliceFooter distinguishes a refused slice from a built one", () => {
  const refused = formatSliceFooter({ slice: 81, outcome: "refused" });
  assert.match(refused, /refused/);
  assert.notEqual(refused, formatSliceFooter({ slice: 81, outcome: "built" }));
});
