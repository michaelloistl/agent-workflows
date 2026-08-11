import { test } from "node:test";
import assert from "node:assert/strict";
import { planVerb, type Step } from "./plan.mts";

// Pin `explore`'s plan to the exact sequence the reusable workflow performs
// today: guards (a refusal, not a failure) → report in-progress → fetch the
// spec → the read-only agent run → post the comment → report done. If a step is
// added, removed, or reordered here, this assertion must change deliberately.
test("planVerb('explore') pins the workflow's sequence", () => {
  const plan = planVerb("explore", {});
  const shape = plan.map((s: Step) => ({
    hook: s.hook,
    args: s.args,
    onNonZero: s.onNonZero,
  }));

  assert.deepEqual(shape, [
    { hook: "guards", args: [], onNonZero: "refusal" },
    { hook: "status", args: ["in-progress"], onNonZero: "failure" },
    { hook: "fetch-spec", args: [], onNonZero: "failure" },
    { hook: "run", args: [], onNonZero: "failure" },
    { hook: "finalize", args: [], onNonZero: "failure" },
    { hook: "status", args: ["done"], onNonZero: "failure" },
  ]);
});

test("planVerb produces steps with an env map and is pure (no I/O)", () => {
  const plan = planVerb("explore", {});
  for (const step of plan) {
    assert.equal(typeof step.env, "object");
    assert.ok(step.env !== null);
  }
});

test("planVerb throws for a verb it has no plan for", () => {
  assert.throws(() => planVerb("nope", {}), /no plan for verb "nope"/);
});
