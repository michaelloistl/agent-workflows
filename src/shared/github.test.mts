import { test } from "node:test";
import assert from "node:assert/strict";
import { announceRefusals, defaultBranchFromRef, repoFromRemoteUrl } from "./github.mts";

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

// — defaultBranchFromRef —
//
// The normalising half of DEFAULT_BRANCH resolution for attended runs. In CI the
// reusable workflow passes the repository default; locally it is read off git or
// `gh`, which answer in the two shapes this collapses — a remote-tracking ref and a
// bare name — and can also answer with a sentinel that names no branch at all.
// Empty is the "nothing resolved" signal `resolveBaseBranch` already understands.

test("defaultBranchFromRef strips the remote prefix a remote-tracking ref carries", () => {
  assert.equal(defaultBranchFromRef("origin/main"), "main");
  assert.equal(defaultBranchFromRef("origin/develop"), "develop");
});

test("defaultBranchFromRef passes a bare branch name through", () => {
  assert.equal(defaultBranchFromRef("main"), "main");
});

test("defaultBranchFromRef keeps a slash inside the branch name itself", () => {
  assert.equal(defaultBranchFromRef("origin/release/2026"), "release/2026");
});

test("defaultBranchFromRef trims surrounding whitespace from command output", () => {
  assert.equal(defaultBranchFromRef("  origin/main\n"), "main");
});

// `HEAD` names no branch: it is what a detached or unset symref abbreviates to, and
// passing it on as the base would make `create-branch` cut from `origin/HEAD`.
test("defaultBranchFromRef refuses the HEAD sentinel in either shape", () => {
  assert.equal(defaultBranchFromRef("HEAD"), "");
  assert.equal(defaultBranchFromRef("origin/HEAD"), "");
});

test("defaultBranchFromRef returns empty for nothing at all", () => {
  assert.equal(defaultBranchFromRef(""), "");
  assert.equal(defaultBranchFromRef("   \n"), "");
  assert.equal(defaultBranchFromRef("origin/"), "");
});
