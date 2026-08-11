import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { resolveEntryRelPath, resolveEntry, classifyInvocation } from "./agent-workflows.mjs";

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

test("resolveEntryRelPath covers the implement-spec orchestrator's non-standard hooks", () => {
  assert.equal(
    resolveEntryRelPath("implement-spec", "kickoff"),
    join("implement-spec", "kickoff.mts"),
  );
  assert.equal(
    resolveEntryRelPath("implement-spec", "advance"),
    join("implement-spec", "advance.mts"),
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

test("classifyInvocation treats a lone verb as a whole-verb sequencer run", () => {
  assert.deepEqual(classifyInvocation(["explore"]), { kind: "verb", verb: "explore" });
});

test("classifyInvocation treats verb + hook as the unchanged per-hook run", () => {
  assert.deepEqual(classifyInvocation(["explore", "run"]), {
    kind: "hook",
    verb: "explore",
    hook: "run",
    rest: [],
  });
  assert.deepEqual(classifyInvocation(["explore", "status", "in-progress"]), {
    kind: "hook",
    verb: "explore",
    hook: "status",
    rest: ["in-progress"],
  });
});

test("classifyInvocation treats a verb + issue number as an attended local run", () => {
  assert.deepEqual(classifyInvocation(["explore", "55"]), {
    kind: "attended",
    verb: "explore",
    issue: "55",
  });
});

// A hook name is never all-digits, so only a numeric second arg is an attended
// run — the per-hook form (verb + hook) is untouched.
test("classifyInvocation keeps a non-numeric second arg as a per-hook run", () => {
  assert.deepEqual(classifyInvocation(["explore", "fetch-spec"]), {
    kind: "hook",
    verb: "explore",
    hook: "fetch-spec",
    rest: [],
  });
});

test("classifyInvocation treats --guards-only as a guards-only whole-verb run", () => {
  assert.deepEqual(classifyInvocation(["implement", "--guards-only"]), {
    kind: "verb",
    verb: "implement",
    guardsOnly: true,
  });
});

test("classifyInvocation reports usage when no verb is given", () => {
  assert.deepEqual(classifyInvocation([]), { kind: "usage" });
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
