import { test } from "node:test";
import assert from "node:assert/strict";
import { announceRefusals, repoFromRemoteUrl } from "./github.mts";

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

// — repoFromRemoteUrl —
//
// The parsing half of GH_REPO resolution for attended runs. In CI the workflow
// supplies `github.repository`; locally there is no workflow, and a missing GH_REPO
// makes every hook that requires it refuse — which the spec loop then reports as an
// unconfirmed merge, three steps from the actual cause.

test("repoFromRemoteUrl parses scp-style ssh remotes", () => {
  assert.equal(repoFromRemoteUrl("git@github.com:michaelloistl/agent-workflows.git"), "michaelloistl/agent-workflows");
  assert.equal(repoFromRemoteUrl("git@github.com:owner/name"), "owner/name");
});

test("repoFromRemoteUrl parses https remotes with and without .git", () => {
  assert.equal(repoFromRemoteUrl("https://github.com/owner/name.git"), "owner/name");
  assert.equal(repoFromRemoteUrl("https://github.com/owner/name"), "owner/name");
});

test("repoFromRemoteUrl parses ssh:// URLs, including an embedded user", () => {
  assert.equal(repoFromRemoteUrl("ssh://git@github.com/owner/name.git"), "owner/name");
});

test("repoFromRemoteUrl trims surrounding whitespace from command output", () => {
  assert.equal(repoFromRemoteUrl("  git@github.com:owner/name.git\n"), "owner/name");
});

test("repoFromRemoteUrl returns null for a shape it does not understand", () => {
  assert.equal(repoFromRemoteUrl(""), null);
  assert.equal(repoFromRemoteUrl("/local/path/to/repo"), null);
});
