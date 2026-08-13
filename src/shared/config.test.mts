import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfigFile,
  resolveBaseBranch,
  resolveAgentModel,
  resolveCheckTimings,
  resolveWorktreeRoot,
  resolveBootstrap,
  resolveRunCeiling,
  resolveFinalPrReview,
  resolveConfig,
  effectiveBase,
  DEFAULT_AGENT_MODEL,
  DEFAULT_WORKTREE_ROOT,
  type ConfigFile,
} from "./config.mts";

// A private path per test-process so the on-disk cases can't collide.
function tmpConfig(name: string): string {
  return join(tmpdir(), `agent-workflows-config-${process.pid}-${name}.json`);
}

test("loadConfigFile returns {} when the file is absent", () => {
  assert.deepEqual(loadConfigFile(tmpConfig("absent")), {});
});

test("loadConfigFile returns {} for unparseable JSON", () => {
  const path = tmpConfig("bad");
  writeFileSync(path, "{ not json");
  try {
    assert.deepEqual(loadConfigFile(path), {});
  } finally {
    rmSync(path, { force: true });
  }
});

test("loadConfigFile parses a valid config file", () => {
  const path = tmpConfig("good");
  writeFileSync(path, JSON.stringify({ baseBranch: "develop", checks: { intervalSeconds: 5 } }));
  try {
    assert.deepEqual(loadConfigFile(path), { baseBranch: "develop", checks: { intervalSeconds: 5 } });
  } finally {
    rmSync(path, { force: true });
  }
});

// Precedence: per-run override (BASE_BRANCH) beats the file, the file beats the
// repository default (DEFAULT_BRANCH), and absent all three the base is empty.
test("resolveBaseBranch: override beats file beats repo default", () => {
  const file: ConfigFile = { baseBranch: "develop" };
  assert.equal(
    resolveBaseBranch({ env: { BASE_BRANCH: "release", DEFAULT_BRANCH: "main" }, file }),
    "release",
  );
  assert.equal(resolveBaseBranch({ env: { DEFAULT_BRANCH: "main" }, file }), "develop");
  assert.equal(resolveBaseBranch({ env: { DEFAULT_BRANCH: "main" }, file: {} }), "main");
  assert.equal(resolveBaseBranch({ env: {}, file: {} }), "");
});

test("resolveBaseBranch treats an empty override/file value as unset", () => {
  assert.equal(
    resolveBaseBranch({ env: { BASE_BRANCH: "", DEFAULT_BRANCH: "main" }, file: { baseBranch: "" } }),
    "main",
  );
});

// The spec-branch-wins rule shared by every base consumer: a tracer-bullet under a
// spec (fetch-spec emitted its spec branch) overrides the configured base; a
// standalone issue falls back to the configured base.
test("effectiveBase: a spec branch overrides the configured base", () => {
  assert.equal(effectiveBase("agent/spec-3-x", "develop"), "agent/spec-3-x");
  assert.equal(effectiveBase("", "develop"), "develop");
  assert.equal(effectiveBase(undefined, "develop"), "develop");
});

test("resolveAgentModel: override beats file beats the packaged default", () => {
  const file: ConfigFile = { agentModel: "claude-sonnet-5" };
  assert.equal(resolveAgentModel({ env: { AGENT_MODEL: "claude-opus-5" }, file }), "claude-opus-5");
  assert.equal(resolveAgentModel({ env: {}, file }), "claude-sonnet-5");
  assert.equal(resolveAgentModel({ env: {}, file: {} }), DEFAULT_AGENT_MODEL);
});

// Check timings: env override beats the file beats the built-in default, per field.
test("resolveCheckTimings: env beats file beats defaults, per field", () => {
  const file: ConfigFile = { checks: { intervalSeconds: 5, timeoutSeconds: 600, graceSeconds: 30 } };
  assert.deepEqual(
    resolveCheckTimings({ env: { CHECKS_INTERVAL_SECONDS: "2" }, file }),
    { intervalSeconds: 2, timeoutSeconds: 600, graceSeconds: 30 },
  );
  assert.deepEqual(
    resolveCheckTimings({ env: {}, file: {} }),
    { intervalSeconds: 15, timeoutSeconds: 1200, graceSeconds: 180 },
  );
});

test("resolveCheckTimings ignores invalid env and file values", () => {
  const file: ConfigFile = { checks: { intervalSeconds: -1, timeoutSeconds: 600 } };
  assert.deepEqual(
    resolveCheckTimings({ env: { CHECKS_GRACE_SECONDS: "nope" }, file }),
    { intervalSeconds: 15, timeoutSeconds: 600, graceSeconds: 180 },
  );
});

// The attended local sequencer's worktree root: per-run override (WORKTREE_ROOT)
// → file (`worktreeRoot`) → the OS-temp default. Never the developer's checkout.
test("resolveWorktreeRoot: override beats file beats the default", () => {
  const file: ConfigFile = { worktreeRoot: "/repo/.worktrees" };
  assert.equal(resolveWorktreeRoot({ env: { WORKTREE_ROOT: "/tmp/run" }, file }), "/tmp/run");
  assert.equal(resolveWorktreeRoot({ env: {}, file }), "/repo/.worktrees");
  assert.equal(resolveWorktreeRoot({ env: {}, file: {} }), DEFAULT_WORKTREE_ROOT);
  assert.equal(resolveWorktreeRoot({ env: { WORKTREE_ROOT: "" }, file: { worktreeRoot: "" } }), DEFAULT_WORKTREE_ROOT);
});

// The bootstrap command that makes a fresh worktree runnable: override (BOOTSTRAP)
// → file (`bootstrap`) → empty (no bootstrap step). Empty is a valid "skip" value.
test("resolveBootstrap: override beats file beats empty", () => {
  const file: ConfigFile = { bootstrap: "yarn install" };
  assert.equal(resolveBootstrap({ env: { BOOTSTRAP: "make setup" }, file }), "make setup");
  assert.equal(resolveBootstrap({ env: {}, file }), "yarn install");
  assert.equal(resolveBootstrap({ env: {}, file: {} }), "");
});

// The run ceiling (issue #61): the most a single attended spec run may spend before
// a human sees it again — slices attempted, wall-clock, or both. Per field, env
// override → file → unset. Absent all → no ceiling ({}), preserving today's
// unbounded behaviour.
test("resolveRunCeiling: env beats file, per field", () => {
  const file: ConfigFile = { runCeiling: { maxSlices: 4, maxWallClockSeconds: 3600 } };
  assert.deepEqual(
    resolveRunCeiling({ env: { RUN_CEILING_MAX_SLICES: "2" }, file }),
    { maxSlices: 2, maxWallClockSeconds: 3600 },
  );
  assert.deepEqual(
    resolveRunCeiling({ env: { RUN_CEILING_MAX_WALLCLOCK_SECONDS: "600" }, file }),
    { maxSlices: 4, maxWallClockSeconds: 600 },
  );
});

test("resolveRunCeiling is empty (no ceiling) when nothing is configured", () => {
  assert.deepEqual(resolveRunCeiling({ env: {}, file: {} }), {});
});

test("resolveRunCeiling carries only the limits that are set", () => {
  assert.deepEqual(resolveRunCeiling({ env: {}, file: { runCeiling: { maxSlices: 3 } } }), {
    maxSlices: 3,
  });
  assert.deepEqual(
    resolveRunCeiling({ env: { RUN_CEILING_MAX_WALLCLOCK_SECONDS: "300" }, file: {} }),
    { maxWallClockSeconds: 300 },
  );
});

test("resolveRunCeiling ignores non-positive and non-numeric limits (a fat-finger is no ceiling)", () => {
  assert.deepEqual(
    resolveRunCeiling({ env: { RUN_CEILING_MAX_SLICES: "0" }, file: { runCeiling: { maxWallClockSeconds: -5 } } }),
    {},
  );
  assert.deepEqual(resolveRunCeiling({ env: { RUN_CEILING_MAX_SLICES: "nope" }, file: {} }), {});
});

// Whether the orchestrator labels the final spec→default PR for review when it
// opens it (issue #114). The FIRST boolean the resolver holds, so the rule for
// "off" is explicit: only a real `false` in the file and only the exact string
// `"false"` in the env disable it; a mistyped value falls through to on, because a
// typo must never silently remove a review a repo relies on. Default on.
test("resolveFinalPrReview: on by default, off only on an explicit false", () => {
  // Default — no env, no file — is on. A repo with no config file gets the label.
  assert.equal(resolveFinalPrReview({ env: {}, file: {} }), true);
  // A real boolean false in the file disables it.
  assert.equal(resolveFinalPrReview({ env: {}, file: { finalPrReview: false } }), false);
  // The exact string "false" in the env disables it.
  assert.equal(resolveFinalPrReview({ env: { FINAL_PR_REVIEW: "false" }, file: {} }), false);
});

test("resolveFinalPrReview: the env override beats the file in both directions", () => {
  // Env off beats file on.
  assert.equal(
    resolveFinalPrReview({ env: { FINAL_PR_REVIEW: "false" }, file: { finalPrReview: true } }),
    false,
  );
  // Env on beats file off.
  assert.equal(
    resolveFinalPrReview({ env: { FINAL_PR_REVIEW: "true" }, file: { finalPrReview: false } }),
    true,
  );
});

test("resolveFinalPrReview: only an explicit false disables — a typo leaves it on", () => {
  // A non-boolean in the file is not `false`, so it stays on.
  assert.equal(
    resolveFinalPrReview({ env: {}, file: { finalPrReview: "no" as unknown as boolean } }),
    true,
  );
  // A mistyped env string is not the exact "false", so it stays on.
  assert.equal(resolveFinalPrReview({ env: { FINAL_PR_REVIEW: "flase" }, file: {} }), true);
  // An empty env value is treated as unset and falls through to the file/default.
  assert.equal(resolveFinalPrReview({ env: { FINAL_PR_REVIEW: "" }, file: {} }), true);
});

test("resolveConfig combines the resolvers over env and file", () => {
  const cfg = resolveConfig(
    { DEFAULT_BRANCH: "main", AGENT_MODEL: "", RUN_CEILING_MAX_SLICES: "3" },
    { baseBranch: "develop", checks: { timeoutSeconds: 900 }, bootstrap: "yarn install" },
  );
  assert.equal(cfg.baseBranch, "develop");
  assert.equal(cfg.agentModel, DEFAULT_AGENT_MODEL);
  assert.equal(cfg.checks.timeoutSeconds, 900);
  assert.equal(cfg.checks.intervalSeconds, 15);
  assert.equal(cfg.worktreeRoot, DEFAULT_WORKTREE_ROOT);
  assert.equal(cfg.bootstrap, "yarn install");
  assert.deepEqual(cfg.runCeiling, { maxSlices: 3 });
  assert.equal(cfg.finalPrReview, true);
});
