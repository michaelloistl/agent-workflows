import { test } from "node:test";
import assert from "node:assert/strict";
import { planVerb, type Step } from "./plan.mts";

// Normalize a step to its pinned identity: a hook by name/args, a shell step by
// its label. The exact shell command strings are deliberately not pinned — the
// sequence (which steps, in what order, with which disposition) is the contract.
function shape(s: Step) {
  return s.kind === "hook"
    ? { kind: s.kind, hook: s.hook, args: s.args, onNonZero: s.onNonZero }
    : { kind: s.kind, name: s.name, onNonZero: s.onNonZero };
}

// Pin `explore`'s plan to the exact sequence the reusable workflow performs
// today: guards (a refusal, not a failure) → report in-progress → fetch the
// spec → the read-only agent run → post the comment → report done. If a step is
// added, removed, or reordered here, this assertion must change deliberately.
test("planVerb('explore') pins the workflow's sequence", () => {
  const plan = planVerb("explore", {});

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "guards", args: [], onNonZero: "refusal" },
    { kind: "hook", hook: "status", args: ["in-progress"], onNonZero: "failure" },
    { kind: "hook", hook: "fetch-spec", args: [], onNonZero: "failure" },
    { kind: "hook", hook: "run", args: [], onNonZero: "failure" },
    { kind: "hook", hook: "finalize", args: [], onNonZero: "failure" },
    { kind: "hook", hook: "status", args: ["done"], onNonZero: "failure" },
  ]);
});

// Pin `implement`'s plan to the sequence the reusable workflow performs today
// (issue #50): guards → report in-progress → fetch the spec → cut the branch →
// the agent run → the fresh-DB boot check (Ruby only) → push → finalize. Unlike
// explore, finalize owns the terminal label, so there is no trailing status.
test("planVerb('implement') pins the workflow's sequence (Ruby enabled)", () => {
  const plan = planVerb("implement", { enableRuby: true });

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "guards", args: [], onNonZero: "refusal" },
    { kind: "hook", hook: "status", args: ["in-progress"], onNonZero: "failure" },
    { kind: "hook", hook: "fetch-spec", args: [], onNonZero: "failure" },
    { kind: "shell", name: "create-branch", onNonZero: "failure" },
    { kind: "hook", hook: "run", args: [], onNonZero: "failure" },
    { kind: "shell", name: "boot-check", onNonZero: "failure" },
    { kind: "shell", name: "push", onNonZero: "failure" },
    { kind: "hook", hook: "finalize", args: [], onNonZero: "failure" },
  ]);
});

// The fresh-DB boot check is Rails-specific and gated on the Ruby toolchain,
// exactly as the workflow gated its step on `inputs.enable-ruby`. With Ruby off
// the sequence is otherwise identical.
test("planVerb('implement') omits the boot check when Ruby is disabled", () => {
  const plan = planVerb("implement", { enableRuby: false });

  assert.deepEqual(
    plan.map((s) => (s.kind === "hook" ? s.hook : s.name)),
    ["guards", "status", "fetch-spec", "create-branch", "run", "push", "finalize"],
  );
});

// Guards-only mode returns just the guard step, so the light guard job catches a
// refusal before Ruby and Postgres are paid for (spec #48 story 26). enable-ruby
// must not leak the boot check into a guards-only plan.
test("planVerb guards-only mode returns just the guard step", () => {
  for (const verb of ["explore", "implement"]) {
    const plan = planVerb(verb, { guardsOnly: true, enableRuby: true });
    assert.deepEqual(plan.map(shape), [
      { kind: "hook", hook: "guards", args: [], onNonZero: "refusal" },
    ]);
  }
});

test("planVerb produces steps with an env map and is pure (no I/O)", () => {
  const plan = planVerb("implement", { enableRuby: true });
  for (const step of plan) {
    assert.equal(typeof step.env, "object");
    assert.ok(step.env !== null);
  }
});

test("planVerb throws for a verb it has no plan for", () => {
  assert.throws(() => planVerb("nope", {}), /no plan for verb "nope"/);
});
