import { test } from "node:test";
import assert from "node:assert/strict";
import { announceRefusals } from "./github.mts";

// By default a guard refusal is announced on the tracker (retire the trigger
// label + comment why) — the unattended workflow's behaviour, unchanged.
test("announceRefusals is true when the suppression flag is unset", () => {
  assert.equal(announceRefusals({}), true);
});

// An attended local run sets ANNOUNCE_REFUSALS=false: there may be no trigger
// label to retire, and a refusal comment on an issue the developer is watching
// is noise. The reason prints to the terminal instead (in `refuse`).
test("announceRefusals is false when ANNOUNCE_REFUSALS=false", () => {
  assert.equal(announceRefusals({ ANNOUNCE_REFUSALS: "false" }), false);
});

// Only the exact string "false" suppresses — any other value falls back to
// announcing, so a fat-fingered flag never silently swallows a tracker refusal.
test("announceRefusals only suppresses on the exact string false", () => {
  assert.equal(announceRefusals({ ANNOUNCE_REFUSALS: "true" }), true);
  assert.equal(announceRefusals({ ANNOUNCE_REFUSALS: "0" }), true);
  assert.equal(announceRefusals({ ANNOUNCE_REFUSALS: "" }), true);
});
