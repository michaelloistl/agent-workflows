import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_RUN_LABEL,
  markerPresent,
  advanceStandDown,
  markerAcquired,
  markerReleased,
  markerRetained,
  markerReleasedOnExit,
  markerUnverified,
} from "./spec-marker.mts";

// — Reading the marker off an issue's labels —

test("the marker is present when the label is on the issue", () => {
  assert.equal(markerPresent(["ready-for-agent", LOCAL_RUN_LABEL]), true);
});

test("the marker is absent when the issue carries no labels", () => {
  assert.equal(markerPresent([]), false);
});

// State labels are a different vocabulary — none of them is the marker, and none is
// a trigger string, which is exactly why they could not solve this in the first place.
test("state labels are not the marker", () => {
  assert.equal(markerPresent(["agent:in-progress", "agent:review", "agent:blocked"]), false);
});

test("a differently-suffixed label is a different label", () => {
  assert.equal(markerPresent(["agent:local-only"]), false);
});

// — The decision: should CI advance stand down? —
//
// A pure function of (spec state, marker present). The merged PR's base branch names
// the spec; the marker says whether an attended local run owns its sequencing.

test("advance stands down while the spec carries the marker", () => {
  const reason = advanceStandDown({ spec: 48, marker: true });
  assert.ok(reason, "expected a stand-down reason");
  assert.match(reason, /#48/);
  assert.match(reason, /agent:local/);
  // A refusal, not a failure — the distinction the message must carry.
  assert.match(reason, /not a failure/);
  // And the way out of a marker nobody owns — which is two steps, because this run
  // is the one the merge fired and it is exiting: taking the label off dispatches
  // nothing on its own, so the message names the re-run as well.
  assert.match(reason, /remove/);
  assert.match(reason, /re-run/);
});

test("advance proceeds when the spec does not carry the marker", () => {
  assert.equal(advanceStandDown({ spec: 48, marker: false }), null);
});

// Advance already no-ops on a base that is not a spec branch; there is nothing to
// stand down from, marker or not.
test("advance does not stand down when the base is not a spec branch", () => {
  assert.equal(advanceStandDown({ spec: null, marker: true }), null);
  assert.equal(advanceStandDown({ spec: null, marker: false }), null);
});

// — The loop's side of the lifecycle —

test("claiming the marker names the spec and what it suppresses", () => {
  const line = markerAcquired({ spec: 48, reclaimed: false });
  assert.match(line, /#48/);
  assert.match(line, /agent:local/);
  assert.match(line, /stands down/);
  assert.doesNotMatch(line, /stale/);
});

// A marker found while this run holds the local lock was left by a run that is not
// alive — a crash, or (since ADR-0009) an ordinary halt, which KEEPS the marker. So
// the reclaim sentence must read as a normal resume, not as a report of damage: the
// developer who just declined a checkpoint and re-ran is the common case.
test("reclaiming a marker reads as a resume, not as a fault", () => {
  const line = markerAcquired({ spec: 48, reclaimed: true });
  assert.match(line, /#48/);
  assert.match(line, /agent:local/);
  assert.match(line, /reclaim/i);
  // It names who left it and what is true now, without calling it stale or broken.
  assert.match(line, /previous run/);
  assert.match(line, /owns/);
  assert.doesNotMatch(line, /stale/);
});

test("releasing the marker says the spec is CI's again", () => {
  assert.match(markerReleased(48), /#48/);
  assert.match(markerReleased(48), /released/);
});

// — The release decision: does a finished run hand the marker back? —
//
// A pure function of the run's terminal state. Completion is the only ending that
// releases: a halt means the run is waiting for the developer, so the spec's
// sequencing is still owned and CI advance must keep standing down.

test("a completed run releases the marker", () => {
  assert.equal(markerReleasedOnExit("completed"), true);
});

test("a halted run retains the marker", () => {
  assert.equal(markerReleasedOnExit("halted"), false);
});

// The sentence a halted run leaves behind has to answer, without a trip to the
// source: what is still true, and the ONE action that changes it.
test("retaining the marker says what is still true and how to hand the spec back", () => {
  const line = markerRetained(48);
  assert.match(line, /#48/);
  assert.match(line, /agent:local/);
  // Why it is still there — the run halted, so the spec is still the developer's.
  assert.match(line, /halted/);
  // What that suppresses, and the action that lifts it.
  assert.match(line, /stands down/);
  assert.match(line, /[Rr]emove/);
  // Removing the label lifts the stand-down but dispatches nothing: `advance` fires
  // on a MERGE, and the run that stood down has already exited. The sentence must
  // not promise CI carries on by itself.
  assert.match(line, /dispatches nothing|starts nothing/);
  assert.match(line, /re-run/);
  assert.match(line, /advance/);
  // And that resuming locally is not blocked by it.
  assert.match(line, /reclaim/);
});

// An unclaimed marker is not survivable: every merge this run makes would start CI
// on the next slice. The halt must say so and must name the first merge as the line
// it stops before.
test("an unverified marker halts before the first merge", () => {
  const reason = markerUnverified(48);
  assert.match(reason, /#48/);
  assert.match(reason, /before the first\s+merge/);
});
