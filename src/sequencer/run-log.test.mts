import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogPath, formatRunLogLine, appendRunLine } from "./run-log.mts";

// — runLogPath —

test("runLogPath puts the log under the worktree root, keyed by spec", () => {
  assert.equal(runLogPath("/tmp/wt", 48), join("/tmp/wt", "spec-48-run.log"));
});

// — formatRunLogLine —

test("formatRunLogLine writes timestamp, slice, action, and outcome tab-separated", () => {
  assert.equal(
    formatRunLogLine({ timestamp: "2026-08-11T09:00:00.000Z", slice: 4, action: "build", outcome: "merged" }),
    "2026-08-11T09:00:00.000Z\t#4\tbuild\tmerged",
  );
});

test("formatRunLogLine labels a spec-level transition as `spec`", () => {
  assert.equal(
    formatRunLogLine({ timestamp: "2026-08-11T09:00:00.000Z", slice: null, action: "complete", outcome: "final PR opened" }),
    "2026-08-11T09:00:00.000Z\tspec\tcomplete\tfinal PR opened",
  );
});

// — appendRunLine —

test("appendRunLine appends each transition as its own line", () => {
  const path = join(tmpdir(), `agent-workflows-run-log-${process.pid}.log`);
  rmSync(path, { force: true });
  try {
    appendRunLine(path, { timestamp: "2026-08-11T09:00:00.000Z", slice: 4, action: "build", outcome: "merged" });
    appendRunLine(path, { timestamp: "2026-08-11T09:05:00.000Z", slice: 5, action: "build", outcome: "built" });
    assert.equal(
      readFileSync(path, "utf8"),
      "2026-08-11T09:00:00.000Z\t#4\tbuild\tmerged\n" +
        "2026-08-11T09:05:00.000Z\t#5\tbuild\tbuilt\n",
    );
  } finally {
    rmSync(path, { force: true });
  }
});

test("appendRunLine swallows a write failure rather than throwing (best-effort)", () => {
  // A path whose parent directory does not exist can never be written — the run must
  // not fail because of it.
  const path = join(tmpdir(), `agent-workflows-run-log-missing-${process.pid}`, "nope", "run.log");
  assert.doesNotThrow(() =>
    appendRunLine(path, { timestamp: "2026-08-11T09:00:00.000Z", slice: 4, action: "build", outcome: "merged" }),
  );
});
