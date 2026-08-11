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
  resolveConfig,
  effectiveBase,
  DEFAULT_AGENT_MODEL,
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

test("resolveConfig combines the resolvers over env and file", () => {
  const cfg = resolveConfig(
    { DEFAULT_BRANCH: "main", AGENT_MODEL: "" },
    { baseBranch: "develop", checks: { timeoutSeconds: 900 } },
  );
  assert.equal(cfg.baseBranch, "develop");
  assert.equal(cfg.agentModel, DEFAULT_AGENT_MODEL);
  assert.equal(cfg.checks.timeoutSeconds, 900);
  assert.equal(cfg.checks.intervalSeconds, 15);
});
