import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSequenceState, parseSequenceState } from "./sequence-state.mts";

// The file format the sequencer bridge WRITES and both attended entry points READ.
// One module owns it so writer and readers cannot drift — the drift here is
// expensive: a caller that cannot see "refused" reports a refusal as something else
// entirely (the spec loop reported it as an unconfirmed merge, three steps from the
// cause).

test("a refusal round-trips with the step that refused", () => {
  const text = renderSequenceState({ outcome: "refused", step: "guards" });
  assert.deepEqual(parseSequenceState(text), { outcome: "refused", step: "guards" });
});

test("branch and base round-trip alongside the outcome", () => {
  const text = renderSequenceState({
    outcome: "succeeded",
    step: "finalize",
    branch: "agent/issue-81-x",
    base: "agent/spec-80-y",
  });
  assert.deepEqual(parseSequenceState(text), {
    outcome: "succeeded",
    step: "finalize",
    branch: "agent/issue-81-x",
    base: "agent/spec-80-y",
  });
});

// Absent fields are omitted rather than written blank, so a reader can tell "not
// reported" from "reported empty".
test("absent fields are omitted from the rendered file", () => {
  const text = renderSequenceState({ outcome: "failed" });
  assert.match(text, /^outcome=failed$/m);
  assert.doesNotMatch(text, /branch=/);
  assert.doesNotMatch(text, /step=/);
});

test("parsing an empty or blank file yields no fields", () => {
  assert.deepEqual(parseSequenceState(""), {});
  assert.deepEqual(parseSequenceState("\n\n"), {});
});

// Forward compatibility, both ways: an older reader must ignore keys it does not
// know, and a newer reader must tolerate a file written without the outcome (the
// shape #57's `ask` path wrote before the outcome existed).
test("unknown keys are ignored and a legacy branch/base file still parses", () => {
  assert.deepEqual(parseSequenceState("branch=agent/issue-1-x\nbase=main\nfuture=42\n"), {
    branch: "agent/issue-1-x",
    base: "main",
  });
});

// A value may contain "=" (a branch name never does, but the parser must not lose
// data if one ever did): split on the FIRST separator only.
test("a value containing '=' survives the round trip", () => {
  assert.equal(parseSequenceState("step=a=b\n").step, "a=b");
});

// An outcome the reader does not recognise is dropped rather than trusted: the loop
// halts on "refused", so a garbled value must never be silently treated as one.
test("an unrecognised outcome is dropped", () => {
  assert.deepEqual(parseSequenceState("outcome=weird\n"), {});
});
