import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveEntryRelPath, resolveEntry, classifyInvocation } from "./agent-workflows.mjs";

test("resolveEntryRelPath maps the run hook to the verb's own entry", () => {
  assert.equal(resolveEntryRelPath("implement", "run"), join("implement", "implement.mts"));
  assert.equal(resolveEntryRelPath("explore", "run"), join("explore", "explore.mts"));
  assert.equal(
    resolveEntryRelPath("update-branch", "run"),
    join("update-branch", "update-branch.mts"),
  );
});

test("resolveEntryRelPath maps review-pr to the review/ dir", () => {
  assert.equal(resolveEntryRelPath("review-pr", "run"), join("review", "review.mts"));
  assert.equal(resolveEntryRelPath("review-pr", "finalize"), join("review", "finalize.mts"));
});

test("resolveEntryRelPath maps non-run hooks to <dir>/<hook>.mts", () => {
  assert.equal(resolveEntryRelPath("implement", "guards"), join("implement", "guards.mts"));
  assert.equal(resolveEntryRelPath("explore", "fetch-spec"), join("explore", "fetch-spec.mts"));
  assert.equal(
    resolveEntryRelPath("implement-pr", "status"),
    join("implement-pr", "status.mts"),
  );
});

test("resolveEntryRelPath covers the implement-spec orchestrator's non-standard hooks", () => {
  assert.equal(
    resolveEntryRelPath("implement-spec", "kickoff"),
    join("implement-spec", "kickoff.mts"),
  );
  assert.equal(
    resolveEntryRelPath("implement-spec", "advance"),
    join("implement-spec", "advance.mts"),
  );
});

test("resolveEntry prefers a consumer override under .sandcastle/", () => {
  const cwd = "/consumer";
  const srcDir = "/pkg/src";
  const expectedOverride = resolve(
    cwd,
    ".sandcastle",
    "agent-workflows",
    "implement",
    "guards.mts",
  );

  let checked;
  const result = resolveEntry("implement", "guards", {
    cwd,
    srcDir,
    exists: (p) => {
      checked = p;
      return true; // pretend the override exists
    },
  });

  assert.equal(checked, expectedOverride, "checks the override path first");
  assert.equal(result.source, "override");
  assert.equal(result.path, expectedOverride);
});

test("classifyInvocation treats a lone verb as a whole-verb sequencer run", () => {
  assert.deepEqual(classifyInvocation(["explore"]), { kind: "verb", verb: "explore" });
});

test("classifyInvocation treats verb + hook as the unchanged per-hook run", () => {
  assert.deepEqual(classifyInvocation(["explore", "run"]), {
    kind: "hook",
    verb: "explore",
    hook: "run",
    rest: [],
  });
  assert.deepEqual(classifyInvocation(["explore", "status", "in-progress"]), {
    kind: "hook",
    verb: "explore",
    hook: "status",
    rest: ["in-progress"],
  });
});

test("classifyInvocation treats a verb + issue number as an attended local run", () => {
  assert.deepEqual(classifyInvocation(["explore", "55"]), {
    kind: "attended",
    verb: "explore",
    issue: "55",
    force: false,
    finalize: undefined,
    interactive: false,
  });
});

// `implement-spec <spec-issue>` is the attended SPEC LOOP, not a single-verb
// attended run (issue #59): it routes to its own kind so the bin spawns the loop
// entry point. A BARE invocation is the unattended default (ADR-0011) — there is
// nothing to opt into, so every flag reads false and the entry point resolves what
// that means.
test("classifyInvocation treats implement-spec + issue number as the spec loop", () => {
  assert.deepEqual(classifyInvocation(["implement-spec", "48"]), {
    kind: "spec-loop",
    spec: "48",
    dryRun: false,
    pause: false,
    force: false,
    noPause: false,
    interactive: false,
    stop: false,
  });
});

// The two flags that take the unattended default back (ADR-0011): `--dry-run`
// suppresses every irreversible action, `--pause` restores both human gates.
test("classifyInvocation reads --dry-run / --pause on the spec loop", () => {
  assert.deepEqual(classifyInvocation(["implement-spec", "48", "--dry-run", "--pause"]), {
    kind: "spec-loop",
    spec: "48",
    dryRun: true,
    pause: true,
    force: false,
    noPause: false,
    interactive: false,
    stop: false,
  });
});

test("classifyInvocation reads --force on the spec loop", () => {
  assert.deepEqual(classifyInvocation(["implement-spec", "48", "--force"]), {
    kind: "spec-loop",
    spec: "48",
    dryRun: false,
    pause: false,
    force: true,
    noPause: false,
    interactive: false,
    stop: false,
  });
});

// Issue #60: `--interactive` (steer each slice) and `--stop` (the graceful-stop
// control command) ride along on the spec loop.
test("classifyInvocation reads --interactive on the spec loop", () => {
  assert.deepEqual(classifyInvocation(["implement-spec", "48", "--interactive"]), {
    kind: "spec-loop",
    spec: "48",
    dryRun: false,
    pause: false,
    force: false,
    noPause: false,
    interactive: true,
    stop: false,
  });
});

// `--execute` and `--yes` are the pre-ADR-0011 spelling of what is now the default,
// kept as silent no-ops. The bin does not forward what it cannot change: they classify
// as a plain unattended run, which is exactly what they asked for. `--no-pause` is the
// exception — still recorded, because the entry point needs it to reject an explicit
// `--interactive --no-pause` pair.
test("classifyInvocation ignores the deprecated --execute / --yes", () => {
  assert.deepEqual(classifyInvocation(["implement-spec", "48", "--execute", "--yes"]), {
    kind: "spec-loop",
    spec: "48",
    dryRun: false,
    pause: false,
    force: false,
    noPause: false,
    interactive: false,
    stop: false,
  });
});

test("classifyInvocation still records a typed --no-pause, so the conflict is catchable", () => {
  assert.deepEqual(classifyInvocation(["implement-spec", "48", "--no-pause", "--interactive"]), {
    kind: "spec-loop",
    spec: "48",
    dryRun: false,
    pause: false,
    force: false,
    noPause: true,
    interactive: true,
    stop: false,
  });
});

test("classifyInvocation reads --stop as the graceful-stop control on the spec loop", () => {
  assert.deepEqual(classifyInvocation(["implement-spec", "48", "--stop"]), {
    kind: "spec-loop",
    spec: "48",
    dryRun: false,
    pause: false,
    force: false,
    noPause: false,
    interactive: false,
    stop: true,
  });
});

// The spec loop's non-numeric hooks (`kickoff`, `advance`) stay per-hook runs — only
// a numeric second arg is the loop, mirroring the attended-run rule.
test("classifyInvocation keeps implement-spec + hook as a per-hook run", () => {
  assert.deepEqual(classifyInvocation(["implement-spec", "advance"]), {
    kind: "hook",
    verb: "implement-spec",
    hook: "advance",
    rest: [],
  });
});

// A trailing `--force` on an attended run sets the force flag the entry point
// uses to overrule a refusal and both concurrency mutexes (issue #56).
test("classifyInvocation reads a trailing --force on an attended run", () => {
  assert.deepEqual(classifyInvocation(["explore", "55", "--force"]), {
    kind: "attended",
    verb: "explore",
    issue: "55",
    force: true,
    finalize: undefined,
    interactive: false,
  });
});

// A `--finalize=<mode>` flag on an attended run is captured verbatim and forwarded
// to the entry point, which parses its meaning (issue #57). It rides alongside
// `--force` in either order.
test("classifyInvocation forwards a --finalize flag on an attended run", () => {
  assert.deepEqual(classifyInvocation(["implement", "57", "--finalize=ask"]), {
    kind: "attended",
    verb: "implement",
    issue: "57",
    force: false,
    finalize: "--finalize=ask",
    interactive: false,
  });
  assert.deepEqual(classifyInvocation(["implement", "57", "--force", "--finalize=never"]), {
    kind: "attended",
    verb: "implement",
    issue: "57",
    force: true,
    finalize: "--finalize=never",
    interactive: false,
  });
});

// A trailing `--interactive` on an attended run sets the flag the entry point uses to
// hand the composed prompt to a live agent session (issue #58). It rides alongside
// the other attended flags in any order.
test("classifyInvocation reads a trailing --interactive on an attended run", () => {
  assert.deepEqual(classifyInvocation(["implement", "58", "--interactive"]), {
    kind: "attended",
    verb: "implement",
    issue: "58",
    force: false,
    finalize: undefined,
    interactive: true,
  });
  assert.deepEqual(
    classifyInvocation(["implement", "58", "--interactive", "--force", "--finalize=ask"]),
    {
      kind: "attended",
      verb: "implement",
      issue: "58",
      force: true,
      finalize: "--finalize=ask",
      interactive: true,
    },
  );
});

// A hook name is never all-digits, so only a numeric second arg is an attended
// run — the per-hook form (verb + hook) is untouched.
test("classifyInvocation keeps a non-numeric second arg as a per-hook run", () => {
  assert.deepEqual(classifyInvocation(["explore", "fetch-spec"]), {
    kind: "hook",
    verb: "explore",
    hook: "fetch-spec",
    rest: [],
  });
});

test("classifyInvocation treats --guards-only as a guards-only whole-verb run", () => {
  assert.deepEqual(classifyInvocation(["implement", "--guards-only"]), {
    kind: "verb",
    verb: "implement",
    guardsOnly: true,
  });
});

// The status view is not a verb (issue #95) — it has no hooks, so `status` alone must
// not be classified as a whole-verb sequencer run, and its flags must not be read as
// hook names. The bin FORWARDS flags verbatim and the entry point decides what they
// mean, as it does for the attended runs: `--watch` is forwarded here and rejected
// there until issue #98 implements it.
test("classifyInvocation routes status to the read-only status view", () => {
  assert.deepEqual(classifyInvocation(["status"]), { kind: "status", args: [] });
  assert.deepEqual(classifyInvocation(["status", "--watch"]), {
    kind: "status",
    args: ["--watch"],
  });
});

// `init` and `sync` set a repo UP to run the fleet rather than running any part of it,
// so they follow no hook contract and must not be classified as whole-verb sequencer
// runs. Their flags are forwarded verbatim, as the status view's are.
test("classifyInvocation routes init and sync to the installer", () => {
  assert.deepEqual(classifyInvocation(["init"]), { kind: "install", mode: "init", args: [] });
  assert.deepEqual(classifyInvocation(["sync"]), { kind: "install", mode: "sync", args: [] });
  assert.deepEqual(classifyInvocation(["init", "--enable=explore", "--dry-run"]), {
    kind: "install",
    mode: "init",
    args: ["--enable=explore", "--dry-run"],
  });
});

test("classifyInvocation reports usage when no verb is given", () => {
  assert.deepEqual(classifyInvocation([]), { kind: "usage" });
});

test("resolveEntry falls back to the packaged src/ entry when no override exists", () => {
  const result = resolveEntry("review-pr", "run", {
    cwd: "/consumer",
    srcDir: "/pkg/src",
    exists: () => false,
  });

  assert.equal(result.source, "packaged");
  assert.equal(result.path, join("/pkg/src", "review", "review.mts"));
});

// The PR-verb workflows now fall back to invoking THIS file directly when the
// `node_modules/.bin` symlink is absent (the central repo is the package, so it never
// installs itself). That fallback execs the file, so the executable bit is load-bearing
// in a way nothing else checks: lose it and the workflows fail with a message about a
// missing dispatcher, pointing at the wrong thing entirely.
test("the dispatcher bin is executable, so the workflow fallback can exec it", () => {
  const bin = fileURLToPath(new URL("agent-workflows.mjs", import.meta.url));
  const mode = statSync(bin).mode;
  assert.ok(mode & 0o100, `expected owner-executable, got mode ${(mode & 0o777).toString(8)}`);
});
