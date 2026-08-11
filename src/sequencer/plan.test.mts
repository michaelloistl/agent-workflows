import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  planVerb,
  worktreePath,
  retainWorktree,
  parseFinalizeMode,
  formatRunSummary,
  type Step,
} from "./plan.mts";

// Normalize a step to its pinned identity: a hook by name/args, a shell step by
// its label, plus its `cwd` split. The exact shell command strings are
// deliberately not pinned — the sequence (which steps, in what order, with which
// disposition, and where each runs) is the contract. `cwd` is `undefined` for the
// issue verbs (a single checkout, no split) and set on the PR verbs, which run
// tracker hooks from the tooling worktree and the agent/git against the PR head.
function shape(s: Step) {
  const base = { kind: s.kind, onNonZero: s.onNonZero, cwd: s.cwd };
  return s.kind === "hook"
    ? { ...base, hook: s.hook, args: s.args }
    : { ...base, name: s.name };
}

// Pin `explore`'s plan to the exact sequence the reusable workflow performs
// today: guards (a refusal, not a failure) → report in-progress → fetch the
// spec → the read-only agent run → post the comment → report done. If a step is
// added, removed, or reordered here, this assertion must change deliberately.
test("planVerb('explore') pins the workflow's sequence", () => {
  const plan = planVerb("explore", {});

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "guards", args: [], onNonZero: "refusal", cwd: undefined },
    { kind: "hook", hook: "status", args: ["in-progress"], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "fetch-spec", args: [], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "run", args: [], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "finalize", args: [], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "status", args: ["done"], onNonZero: "failure", cwd: undefined },
  ]);
});

// Pin `implement`'s plan to the sequence the reusable workflow performs today
// (issue #50): guards → report in-progress → fetch the spec → cut the branch →
// the agent run → the fresh-DB boot check (Ruby only) → push → finalize. Unlike
// explore, finalize owns the terminal label, so there is no trailing status.
test("planVerb('implement') pins the workflow's sequence (Ruby enabled)", () => {
  const plan = planVerb("implement", { enableRuby: true });

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "guards", args: [], onNonZero: "refusal", cwd: undefined },
    { kind: "hook", hook: "status", args: ["in-progress"], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "fetch-spec", args: [], onNonZero: "failure", cwd: undefined },
    { kind: "shell", name: "create-branch", onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "run", args: [], onNonZero: "failure", cwd: undefined },
    { kind: "shell", name: "boot-check", onNonZero: "failure", cwd: undefined },
    { kind: "shell", name: "push", onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "finalize", args: [], onNonZero: "failure", cwd: undefined },
  ]);
});

// An attended `implement` run with `--finalize=never` keeps everything off GitHub
// until finalize (issue #57): it drops BOTH the push + finalize tail AND the
// `in-progress` status step, so the run touches the tracker not at all and stops
// with the commits on the agent branch. Guards, fetch-spec, the branch cut, and the
// agent run remain.
test("planVerb('implement') drops the tail and the status step for finalize:never", () => {
  const plan = planVerb("implement", { finalize: "never" });

  assert.deepEqual(
    plan.map((s) => (s.kind === "hook" ? s.hook : s.name)),
    ["guards", "fetch-spec", "create-branch", "run"],
  );
});

// `--finalize=ask` also holds everything off GitHub until confirmation — same
// dropped status step and tail; the tail runs later as its own confirmed slice, so
// the first slice must stop at the commits (the boot check still runs when Ruby is on).
test("planVerb('implement') drops the tail and the status step for finalize:ask", () => {
  const plan = planVerb("implement", { finalize: "ask", enableRuby: true });

  assert.deepEqual(
    plan.map((s) => (s.kind === "hook" ? s.hook : s.name)),
    ["guards", "fetch-spec", "create-branch", "run", "boot-check"],
  );
});

// The default (`auto`, or an absent mode as an unattended run leaves it) keeps the
// tail, so the one sequence pushes and opens the PR — full parity with CI.
test("planVerb('implement') keeps the tail for finalize:auto", () => {
  const plan = planVerb("implement", { finalize: "auto" });

  assert.deepEqual(
    plan.map((s) => (s.kind === "hook" ? s.hook : s.name)),
    ["guards", "status", "fetch-spec", "create-branch", "run", "push", "finalize"],
  );
});

// The finalize-tail-only slice (the attended `ask` path's confirmed second slice)
// is exactly the two tail steps the unattended run ends with — no guards, status,
// or agent run — so a confirmed local finalize does what CI's tail does and no more.
test("planVerb('implement') finalizeTailOnly returns just push then finalize", () => {
  const plan = planVerb("implement", { finalizeTailOnly: true });

  assert.deepEqual(plan.map(shape), [
    { kind: "shell", name: "push", onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "finalize", args: [], onNonZero: "failure", cwd: undefined },
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

// Pin `review-pr`'s plan to the sequence the reusable workflow performs today:
// guards → report in-progress → the read-only agent run → post the review →
// report done. The tracker hooks (guards/status/finalize) run from the tooling
// worktree (`cwd: "tooling"`); the agent `run` runs against the PR head
// (`cwd: "work"`). There is no fetch-spec — the run gathers its own PR context.
test("planVerb('review-pr') pins the workflow's sequence", () => {
  const plan = planVerb("review-pr", {});

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "guards", args: [], onNonZero: "refusal", cwd: "tooling" },
    { kind: "hook", hook: "status", args: ["in-progress"], onNonZero: "failure", cwd: "tooling" },
    { kind: "hook", hook: "run", args: [], onNonZero: "failure", cwd: "work" },
    { kind: "hook", hook: "finalize", args: [], onNonZero: "failure", cwd: "tooling" },
    { kind: "hook", hook: "status", args: ["done"], onNonZero: "failure", cwd: "tooling" },
  ]);
});

// Pin `implement-pr`'s plan: guards → report in-progress → the agent run (commits
// onto the PR head) → push-and-finalize. The agent run exits non-zero on a no-op
// (`failure`), so nothing to commit reports blocked. Unlike review-pr, the push
// is conditional (a non-fast-forward self-reports blocked, no force) and finalize
// only runs after a successful push — so both live in one work-tree shell step.
test("planVerb('implement-pr') pins the workflow's sequence", () => {
  const plan = planVerb("implement-pr", {});

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "guards", args: [], onNonZero: "refusal", cwd: "tooling" },
    { kind: "hook", hook: "status", args: ["in-progress"], onNonZero: "failure", cwd: "tooling" },
    { kind: "hook", hook: "run", args: [], onNonZero: "failure", cwd: "work" },
    { kind: "shell", name: "push-and-finalize", onNonZero: "failure", cwd: "work" },
  ]);
});

// Pin `update-branch`'s plan: guards → report in-progress → the agent run (merges
// the base into the PR head) → push-and-finalize. Like implement-pr the push is
// conditional (an up-to-date run pushes nothing but still finalizes; a merged run
// pushes without force) and finalize is bundled with it in one work-tree step.
test("planVerb('update-branch') pins the workflow's sequence", () => {
  const plan = planVerb("update-branch", {});

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "guards", args: [], onNonZero: "refusal", cwd: "tooling" },
    { kind: "hook", hook: "status", args: ["in-progress"], onNonZero: "failure", cwd: "tooling" },
    { kind: "hook", hook: "run", args: [], onNonZero: "failure", cwd: "work" },
    { kind: "shell", name: "push-and-finalize", onNonZero: "failure", cwd: "work" },
  ]);
});

// Pin the `implement-spec` orchestrator's KICKOFF plan to the sequence its run
// job performs today (issue #52): a single tracer/`gh`-only step, the kickoff
// hook, with no agent and no fetch-spec. A non-zero exit is a genuine failure
// (the kickoff hook never refuses — the separate guard job owns that). No `cwd`
// split: the orchestrator runs in one checkout.
test("planVerb('implement-spec') pins the kickoff sequence", () => {
  const plan = planVerb("implement-spec", { specMode: "kickoff" });

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "kickoff", args: [], onNonZero: "failure", cwd: undefined },
  ]);
});

// Pin the ADVANCE plan the same way: a single advance hook step. A non-zero exit
// is a failure — advance exits non-zero to halt the run when the spec branch's CI
// is red, and that must fail the job so a human decides.
test("planVerb('implement-spec') pins the advance sequence", () => {
  const plan = planVerb("implement-spec", { specMode: "advance" });

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "advance", args: [], onNonZero: "failure", cwd: undefined },
  ]);
});

// The orchestrator's mode selects the plan; an unrecognised mode is a wiring bug,
// not a silent empty sequence.
test("planVerb('implement-spec') throws for an unknown mode", () => {
  assert.throws(() => planVerb("implement-spec", { specMode: "nope" }), /unknown mode "nope"/);
});

// Guards-only mode returns just the guard step, so the light guard job catches a
// refusal before Ruby and Postgres are paid for (spec #48 story 26). enable-ruby
// must not leak the boot check into a guards-only plan. The issue verbs guard in
// a single checkout (`cwd: undefined`); the PR verbs guard from the tooling
// worktree (`cwd: "tooling"`) — set here even though the light guard job runs in
// a plain default-branch checkout with no TOOLING_DIR (the bridge no-ops it there).
test("planVerb guards-only mode returns just the guard step", () => {
  for (const verb of ["explore", "implement"]) {
    const plan = planVerb(verb, { guardsOnly: true, enableRuby: true });
    assert.deepEqual(plan.map(shape), [
      { kind: "hook", hook: "guards", args: [], onNonZero: "refusal", cwd: undefined },
    ]);
  }
  for (const verb of ["review-pr", "implement-pr", "update-branch"]) {
    const plan = planVerb(verb, { guardsOnly: true });
    assert.deepEqual(plan.map(shape), [
      { kind: "hook", hook: "guards", args: [], onNonZero: "refusal", cwd: "tooling" },
    ]);
  }
});

// A forced run (issue #56) overrules a guard refusal: the guards step still runs
// (its reason prints to the terminal), but its non-zero exit becomes `tolerated`
// so the executor continues the sequence instead of stopping. Every other step's
// disposition is untouched. This is the single force flag overruling a refusal.
test("planVerb with force tolerates a guard refusal", () => {
  const plan = planVerb("explore", { force: true });

  assert.deepEqual(plan.map(shape), [
    { kind: "hook", hook: "guards", args: [], onNonZero: "tolerated", cwd: undefined },
    { kind: "hook", hook: "status", args: ["in-progress"], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "fetch-spec", args: [], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "run", args: [], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "finalize", args: [], onNonZero: "failure", cwd: undefined },
    { kind: "hook", hook: "status", args: ["done"], onNonZero: "failure", cwd: undefined },
  ]);
});

// Force flips the guard step for the PR verbs too (which guard from the tooling
// worktree), and leaves everything else — including the `cwd` split — intact.
test("planVerb with force tolerates the guard refusal on the PR verbs", () => {
  const plan = planVerb("review-pr", { force: true });

  assert.equal(plan[0].kind, "hook");
  assert.deepEqual(shape(plan[0]), {
    kind: "hook",
    hook: "guards",
    args: [],
    onNonZero: "tolerated",
    cwd: "tooling",
  });
});

// Without force the guard stays a `refusal` — the default (and only) unattended
// behaviour, so a refusal halts the run.
test("planVerb without force leaves the guard as a refusal", () => {
  const plan = planVerb("explore", {});
  assert.equal((plan[0] as { onNonZero: string }).onNonZero, "refusal");
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

// The attended entry point's worktree path derivation lives here, not in a
// separate module, and is pinned by these tests (issue #55). Each run gets its
// own directory UNDER the configured root, named for the verb and issue so
// concurrent runs of different verbs/issues never collide and a retained tree is
// self-identifying. The path is deterministic in (root, verb, issue) so re-running
// the same command lands on the same tree.
test("worktreePath derives a per-run directory under the configured root", () => {
  assert.equal(worktreePath("/tmp/wt", "explore", "55"), join("/tmp/wt", "explore-55"));
  assert.equal(worktreePath("/tmp/wt", "explore", 55), join("/tmp/wt", "explore-55"));
});

test("worktreePath is deterministic and distinct per verb and issue", () => {
  assert.equal(worktreePath("/root", "explore", "1"), worktreePath("/root", "explore", "1"));
  assert.notEqual(worktreePath("/root", "explore", "1"), worktreePath("/root", "explore", "2"));
  assert.notEqual(worktreePath("/root", "explore", "1"), worktreePath("/root", "implement", "1"));
});

// The cleanup policy lives here too (issue #55). The worktree is REMOVED only on a
// clean end with nothing to inspect — a success, or a guard refusal that produced
// no work and posted its own explanation. A failure or a Ctrl-C abort RETAINS the
// tree, because that half-finished tree is exactly what the developer wants to open.
test("retainWorktree keeps the tree on failure or abort, removes it otherwise", () => {
  assert.equal(retainWorktree("failed"), true);
  assert.equal(retainWorktree("aborted"), true);
  assert.equal(retainWorktree("succeeded"), false);
  assert.equal(retainWorktree("refused"), false);
});

// An attended `implement` run also retains a SUCCESSFUL tree (issue #57): the
// surviving worktree is what provides inspection, so a clean success keeps it too.
// A guard refusal still removes (no work to inspect); a failure/abort still retains.
test("retainWorktree keeps a successful implement tree but not a successful explore tree", () => {
  assert.equal(retainWorktree("succeeded", "implement"), true);
  assert.equal(retainWorktree("succeeded", "explore"), false);
  assert.equal(retainWorktree("refused", "implement"), false);
  assert.equal(retainWorktree("failed", "implement"), true);
  assert.equal(retainWorktree("aborted", "implement"), true);
});

// The `--finalize=<mode>` flag (issue #57) parses to a mode, defaults to `auto`
// when absent, and throws on a typo rather than silently defaulting to the pushing
// path — the surprise the flag exists to prevent.
test("parseFinalizeMode reads the flag, defaults to auto, and rejects a typo", () => {
  assert.equal(parseFinalizeMode(["implement", "57"]), "auto");
  assert.equal(parseFinalizeMode(["implement", "57", "--finalize=ask"]), "ask");
  assert.equal(parseFinalizeMode(["implement", "57", "--finalize=never"]), "never");
  assert.equal(parseFinalizeMode(["implement", "57", "--finalize=auto"]), "auto");
  assert.throws(() => parseFinalizeMode(["--finalize=nver"]), /unknown finalize mode "nver"/);
});

// The end-of-run summary (issue #57) states the outcome, the worktree's fate, and —
// for `implement` — what finalize did. A finalized run reports the push and PR; a
// `never` run and a not-finalized `ask` run report the commits left on the branch.
test("formatRunSummary renders outcome, worktree fate, and finalize disposition", () => {
  const finalized = formatRunSummary({
    verb: "implement",
    issue: "57",
    outcome: "succeeded",
    retained: true,
    tree: "/tmp/wt/implement-57",
    finalize: "auto",
    finalized: true,
  });
  assert.match(finalized, /implement #57: succeeded/);
  assert.match(finalized, /worktree: retained at \/tmp\/wt\/implement-57/);
  assert.match(finalized, /finalize: auto — pushed the branch, opened the PR/);

  const declined = formatRunSummary({
    verb: "implement",
    issue: "57",
    outcome: "succeeded",
    retained: true,
    tree: "/tmp/wt/implement-57",
    finalize: "ask",
    finalized: false,
  });
  assert.match(declined, /finalize: ask — not finalized/);

  const never = formatRunSummary({
    verb: "implement",
    issue: "57",
    outcome: "succeeded",
    retained: true,
    tree: "/tmp/wt/implement-57",
    finalize: "never",
    finalized: false,
  });
  assert.match(never, /finalize: never — nothing pushed/);

  // `explore` carries no finalize mode, so the summary omits the finalize line.
  const explore = formatRunSummary({
    verb: "explore",
    issue: "42",
    outcome: "succeeded",
    retained: false,
    tree: "/tmp/wt/explore-42",
  });
  assert.match(explore, /worktree: removed at/);
  assert.doesNotMatch(explore, /finalize:/);
});
