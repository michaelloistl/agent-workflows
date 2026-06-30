import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { resolveEntryRelPath, resolveEntry } from "./agent-workflows.mjs";

test("resolveEntryRelPath maps the run hook to the verb's own entry", () => {
  assert.equal(resolveEntryRelPath("implement", "run"), join("implement", "implement.mts"));
  assert.equal(resolveEntryRelPath("explore", "run"), join("explore", "explore.mts"));
  assert.equal(
    resolveEntryRelPath("update-branch", "run"),
    join("update-branch", "update-branch.mts"),
  );
});

test("resolveEntryRelPath maps review-pr to the review/ dir", () => {
  assert.equal(resolveEntryRelPath("review-pr", "run"), join("review", "review.mts"));
  assert.equal(resolveEntryRelPath("review-pr", "finalize"), join("review", "finalize.mts"));
});

test("resolveEntryRelPath maps non-run hooks to <dir>/<hook>.mts", () => {
  assert.equal(resolveEntryRelPath("implement", "guards"), join("implement", "guards.mts"));
  assert.equal(resolveEntryRelPath("explore", "fetch-spec"), join("explore", "fetch-spec.mts"));
  assert.equal(
    resolveEntryRelPath("implement-pr", "status"),
    join("implement-pr", "status.mts"),
  );
});

test("resolveEntryRelPath covers the implement-prd orchestrator's non-standard hooks", () => {
  assert.equal(
    resolveEntryRelPath("implement-prd", "kickoff"),
    join("implement-prd", "kickoff.mts"),
  );
  assert.equal(
    resolveEntryRelPath("implement-prd", "advance"),
    join("implement-prd", "advance.mts"),
  );
});

test("resolveEntry prefers a consumer override under .sandcastle/", () => {
  const cwd = "/consumer";
  const srcDir = "/pkg/src";
  const expectedOverride = resolve(
    cwd,
    ".sandcastle",
    "agent-workflows",
    "implement",
    "guards.mts",
  );

  let checked;
  const result = resolveEntry("implement", "guards", {
    cwd,
    srcDir,
    exists: (p) => {
      checked = p;
      return true; // pretend the override exists
    },
  });

  assert.equal(checked, expectedOverride, "checks the override path first");
  assert.equal(result.source, "override");
  assert.equal(result.path, expectedOverride);
});

test("resolveEntry falls back to the packaged src/ entry when no override exists", () => {
  const result = resolveEntry("review-pr", "run", {
    cwd: "/consumer",
    srcDir: "/pkg/src",
    exists: () => false,
  });

  assert.equal(result.source, "packaged");
  assert.equal(result.path, join("/pkg/src", "review", "review.mts"));
});
