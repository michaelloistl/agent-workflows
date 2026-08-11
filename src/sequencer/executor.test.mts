import { test } from "node:test";
import assert from "node:assert/strict";
import type { Step } from "./plan.mts";
import { runPlan } from "./executor.mts";

function step(hook: string, onNonZero: Step["onNonZero"]): Step {
  return { hook, args: [], env: {}, onNonZero };
}

test("runPlan runs every step in order and reports success", () => {
  const seen: string[] = [];
  const plan = [step("a", "failure"), step("b", "failure"), step("c", "failure")];

  const result = runPlan(plan, (s) => {
    seen.push(s.hook);
    return 0;
  });

  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(result, { outcome: "succeeded", code: 0 });
});

test("a non-zero refusal step stops the run and is distinguishable from a failure", () => {
  const seen: string[] = [];
  const plan = [step("guards", "refusal"), step("run", "failure")];

  const result = runPlan(plan, (s) => {
    seen.push(s.hook);
    return s.hook === "guards" ? 1 : 0;
  });

  assert.deepEqual(seen, ["guards"], "stops before the next step");
  assert.equal(result.outcome, "refused");
  assert.equal(result.code, 1);
  assert.equal(result.step?.hook, "guards");
});

test("a non-zero failure step stops the run and propagates its exit code", () => {
  const seen: string[] = [];
  const plan = [step("guards", "refusal"), step("run", "failure"), step("finalize", "failure")];

  const result = runPlan(plan, (s) => {
    seen.push(s.hook);
    return s.hook === "run" ? 42 : 0;
  });

  assert.deepEqual(seen, ["guards", "run"], "stops at the failing step");
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, 42);
  assert.equal(result.step?.hook, "run");
});

test("a tolerated step's non-zero exit does not stop the run", () => {
  const seen: string[] = [];
  const plan = [step("cleanup", "tolerated"), step("finalize", "failure")];

  const result = runPlan(plan, (s) => {
    seen.push(s.hook);
    return s.hook === "cleanup" ? 3 : 0;
  });

  assert.deepEqual(seen, ["cleanup", "finalize"]);
  assert.deepEqual(result, { outcome: "succeeded", code: 0 });
});
