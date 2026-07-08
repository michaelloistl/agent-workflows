import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSpecBranch,
  specNumberFromBranch,
  issueNumberFromBranch,
  pickSpecBranch,
} from "./spec-context.mts";

test("isSpecBranch recognises a spec branch and rejects others", () => {
  assert.equal(isSpecBranch("agent/spec-42-stacked-orchestrator"), true);
  assert.equal(isSpecBranch("agent/issue-7-base-threading"), false);
  assert.equal(isSpecBranch("main"), false);
});

test("specNumberFromBranch reads the spec number from a base ref, null otherwise", () => {
  assert.equal(specNumberFromBranch("agent/spec-42-stacked-orchestrator"), 42);
  assert.equal(specNumberFromBranch("agent/issue-7-x"), null);
  assert.equal(specNumberFromBranch("main"), null);
});

test("issueNumberFromBranch reads the tracer-bullet number from a head ref, null otherwise", () => {
  assert.equal(issueNumberFromBranch("agent/issue-7-base-threading"), 7);
  assert.equal(issueNumberFromBranch("agent/spec-42-x"), null);
  assert.equal(issueNumberFromBranch("feature/whatever"), null);
});

test("pickSpecBranch finds the live spec branch for a number, ignoring others", () => {
  const branches = [
    "main",
    "agent/issue-7-base-threading",
    "agent/spec-3-stacked-orchestrator",
    "agent/spec-30-other",
  ];
  assert.equal(pickSpecBranch(3, branches), "agent/spec-3-stacked-orchestrator");
  assert.equal(pickSpecBranch(99, branches), null);
});
