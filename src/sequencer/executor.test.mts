import { test } from "node:test";
import assert from "node:assert/strict";
import type { Step } from "./plan.mts";
import { runPlan } from "./executor.mts";

function step(hook: string, onNonZero: Step["onNonZero"]): Step {
  return { kind: "hook", hook, args: [], env: {}, onNonZero };
}

// A step's dispatch name — its hook, or a shell step's label.
function name(step: Step): string {
  return "hook" in step ? step.hook : step.name;
}

// The offending step's hook name, or undefined for a shell step / no step.
function offendingHook(step: Step | undefined): string | undefined {
  return step && "hook" in step ? step.hook : undefined;
}

test("runPlan runs every step in order and reports success", () => {
  const seen: string[] = [];
  const plan = [step("a", "failure"), step("b", "failure"), step("c", "failure")];

  const result = runPlan(plan, (s) => {
    seen.push(name(s));
    return 0;
  });

  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(result, { outcome: "succeeded", code: 0 });
});

test("a non-zero refusal step stops the run and is distinguishable from a failure", () => {
  const seen: string[] = [];
  const plan = [step("guards", "refusal"), step("run", "failure")];

  const result = runPlan(plan, (s) => {
    seen.push(name(s));
    return name(s) === "guards" ? 1 : 0;
  });

  assert.deepEqual(seen, ["guards"], "stops before the next step");
  assert.equal(result.outcome, "refused");
  assert.equal(result.code, 1);
  assert.equal(offendingHook(result.step), "guards");
});

test("a non-zero failure step stops the run and propagates its exit code", () => {
  const seen: string[] = [];
  const plan = [step("guards", "refusal"), step("run", "failure"), step("finalize", "failure")];

  const result = runPlan(plan, (s) => {
    seen.push(name(s));
    return name(s) === "run" ? 42 : 0;
  });

  assert.deepEqual(seen, ["guards", "run"], "stops at the failing step");
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, 42);
  assert.equal(offendingHook(result.step), "run");
});

test("a tolerated step's non-zero exit does not stop the run", () => {
  const seen: string[] = [];
  const plan = [step("cleanup", "tolerated"), step("finalize", "failure")];

  const result = runPlan(plan, (s) => {
    seen.push(name(s));
    return name(s) === "cleanup" ? 3 : 0;
  });

  assert.deepEqual(seen, ["cleanup", "finalize"]);
  assert.deepEqual(result, { outcome: "succeeded", code: 0 });
});
