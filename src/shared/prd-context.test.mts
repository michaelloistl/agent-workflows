import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPrdBranch,
  prdNumberFromBranch,
  issueNumberFromBranch,
  pickPrdBranch,
} from "./prd-context.mts";

test("isPrdBranch recognises a PRD branch and rejects others", () => {
  assert.equal(isPrdBranch("agent/prd-42-stacked-orchestrator"), true);
  assert.equal(isPrdBranch("agent/issue-7-base-threading"), false);
  assert.equal(isPrdBranch("main"), false);
});

test("prdNumberFromBranch reads the PRD number from a base ref, null otherwise", () => {
  assert.equal(prdNumberFromBranch("agent/prd-42-stacked-orchestrator"), 42);
  assert.equal(prdNumberFromBranch("agent/issue-7-x"), null);
  assert.equal(prdNumberFromBranch("main"), null);
});

test("issueNumberFromBranch reads the tracer-bullet number from a head ref, null otherwise", () => {
  assert.equal(issueNumberFromBranch("agent/issue-7-base-threading"), 7);
  assert.equal(issueNumberFromBranch("agent/prd-42-x"), null);
  assert.equal(issueNumberFromBranch("feature/whatever"), null);
});

test("pickPrdBranch finds the live PRD branch for a number, ignoring others", () => {
  const branches = [
    "main",
    "agent/issue-7-base-threading",
    "agent/prd-3-stacked-orchestrator",
    "agent/prd-30-other",
  ];
  assert.equal(pickPrdBranch(3, branches), "agent/prd-3-stacked-orchestrator");
  assert.equal(pickPrdBranch(99, branches), null);
});
