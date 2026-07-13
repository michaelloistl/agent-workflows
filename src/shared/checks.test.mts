import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketOfRun,
  checkVerdict,
  parseChecks,
  parseCommitCheckRuns,
  pollAction,
  type PollPolicy,
} from "./checks.mts";

test("checkVerdict: an empty set is 'none'", () => {
  assert.equal(checkVerdict([]), "none");
});

test("checkVerdict: all terminal-and-passing (incl. skipping) is 'pass'", () => {
  assert.equal(checkVerdict([{ bucket: "pass" }, { bucket: "skipping" }]), "pass");
});

test("checkVerdict: a failure dominates pending and pass", () => {
  assert.equal(
    checkVerdict([{ bucket: "pass" }, { bucket: "pending" }, { bucket: "fail" }]),
    "fail",
  );
});

test("checkVerdict: a cancellation counts as a failure", () => {
  assert.equal(checkVerdict([{ bucket: "pass" }, { bucket: "cancel" }]), "fail");
});

test("checkVerdict: still-running with no failures is 'pending'", () => {
  assert.equal(checkVerdict([{ bucket: "pass" }, { bucket: "pending" }]), "pending");
});

test("parseChecks: blank / non-array / garbage collapse to no runs", () => {
  assert.deepEqual(parseChecks(""), []);
  assert.deepEqual(parseChecks("   \n "), []);
  assert.deepEqual(parseChecks("{}"), []);
  assert.deepEqual(parseChecks("not json"), []);
});

test("parseChecks: reads a gh check-run array", () => {
  const runs = parseChecks(
    JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]),
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].bucket, "pass");
});

test("bucketOfRun: a not-yet-completed run is pending regardless of conclusion", () => {
  assert.equal(bucketOfRun({ status: "queued" }), "pending");
  assert.equal(bucketOfRun({ status: "in_progress" }), "pending");
  assert.equal(bucketOfRun({}), "pending");
});

test("bucketOfRun: a completed success is a pass", () => {
  assert.equal(bucketOfRun({ status: "completed", conclusion: "success" }), "pass");
});

test("bucketOfRun: non-failing terminal conclusions bucket as skipping", () => {
  assert.equal(bucketOfRun({ status: "completed", conclusion: "skipped" }), "skipping");
  assert.equal(bucketOfRun({ status: "completed", conclusion: "neutral" }), "skipping");
  assert.equal(bucketOfRun({ status: "completed", conclusion: "stale" }), "skipping");
});

test("bucketOfRun: a cancellation buckets as cancel", () => {
  assert.equal(bucketOfRun({ status: "completed", conclusion: "cancelled" }), "cancel");
});

test("bucketOfRun: failure / timed_out / action_required / missing conclusion all fail", () => {
  assert.equal(bucketOfRun({ status: "completed", conclusion: "failure" }), "fail");
  assert.equal(bucketOfRun({ status: "completed", conclusion: "timed_out" }), "fail");
  assert.equal(bucketOfRun({ status: "completed", conclusion: "action_required" }), "fail");
  assert.equal(bucketOfRun({ status: "completed", conclusion: null }), "fail");
});

test("parseCommitCheckRuns: blank / non-object / missing check_runs collapse to no runs", () => {
  assert.deepEqual(parseCommitCheckRuns(""), []);
  assert.deepEqual(parseCommitCheckRuns("   \n "), []);
  assert.deepEqual(parseCommitCheckRuns("not json"), []);
  assert.deepEqual(parseCommitCheckRuns("[]"), []);
  assert.deepEqual(parseCommitCheckRuns(JSON.stringify({ total_count: 0 })), []);
});

test("parseCommitCheckRuns: maps a check-runs payload to bucketed runs", () => {
  const runs = parseCommitCheckRuns(
    JSON.stringify({
      total_count: 2,
      check_runs: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "rubocop", status: "in_progress", conclusion: null },
      ],
    }),
  );
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.bucket), ["pass", "pending"]);
  assert.equal(checkVerdict(runs), "pending");
});

test("parseCommitCheckRuns: a failing run drives the verdict to fail", () => {
  const runs = parseCommitCheckRuns(
    JSON.stringify({
      check_runs: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "boot-check", status: "completed", conclusion: "failure" },
      ],
    }),
  );
  assert.equal(checkVerdict(runs), "fail");
});

const POLICY: PollPolicy = { timeoutMs: 1000, graceMs: 100 };

test("pollAction: pass merges and fail aborts immediately", () => {
  assert.equal(pollAction("pass", 0, POLICY), "merge");
  assert.equal(pollAction("fail", 0, POLICY), "abort");
});

test("pollAction: 'none' waits within the grace period, then merges", () => {
  assert.equal(pollAction("none", 0, POLICY), "wait");
  assert.equal(pollAction("none", 99, POLICY), "wait");
  assert.equal(pollAction("none", 100, POLICY), "merge");
});

test("pollAction: 'pending' waits until the timeout, then aborts", () => {
  assert.equal(pollAction("pending", 0, POLICY), "wait");
  assert.equal(pollAction("pending", 999, POLICY), "wait");
  assert.equal(pollAction("pending", 1000, POLICY), "abort");
});
