import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVerdict, parseChecks, pollAction, type PollPolicy } from "./checks.mts";

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
