import { test } from "node:test";
import assert from "node:assert/strict";
import { freshRender, needsFullPass } from "./freshness.mts";

// A `freshRender` wired to fakes: a scripted probe, a branch list the test can move, a
// clock it can advance, and a pass that counts its calls and stamps each frame so a reused
// one is distinguishable from a freshly-computed one. No network, no wall-clock.
function harness(
  script: Array<{ branches?: string[]; changed: boolean | null; advanceMs?: number }>,
  ceilingMs = 300_000,
) {
  let branches: string[] = [];
  let at = 0;
  let passes = 0;
  let probes = 0;
  let step = -1;
  const render = freshRender({
    branches: () => branches,
    changed: () => {
      probes++;
      return script[step]!.changed;
    },
    pass: (bs) => `frame ${++passes} · ${[...bs].sort().join(",")}`,
    now: () => at,
    ceilingMs,
  });
  return {
    tick() {
      step++;
      const s = script[step]!;
      if (s.branches !== undefined) branches = s.branches;
      if (s.advanceMs !== undefined) at += s.advanceMs;
      return render();
    },
    get passes() {
      return passes;
    },
    get probes() {
      return probes;
    },
  };
}

test("the first tick always performs a full pass", () => {
  const h = harness([{ changed: false }]);
  const frame = h.tick();
  assert.equal(h.passes, 1);
  assert.match(frame, /^frame 1/);
});

test("an unchanged tracker performs no full pass and redraws the previous frame", () => {
  const h = harness([{ changed: false }, { changed: false, advanceMs: 30_000 }]);
  const first = h.tick();
  const second = h.tick();
  assert.equal(h.passes, 1, "the second tick reused the frame rather than re-fetching");
  assert.equal(second, first, "and redrew exactly what the first tick produced");
});

test("a change performs a full pass and redraws the new frame", () => {
  const h = harness([{ changed: false }, { changed: true, advanceMs: 30_000 }]);
  const first = h.tick();
  const second = h.tick();
  assert.equal(h.passes, 2);
  assert.notEqual(second, first);
  assert.match(second, /^frame 2/);
});

test("a branch appearing forces a full pass even when the probe reports no change", () => {
  const h = harness([
    { branches: ["agent/spec-1-x"], changed: false },
    { branches: ["agent/spec-1-x", "agent/spec-2-y"], changed: false, advanceMs: 30_000 },
  ]);
  h.tick();
  h.tick();
  assert.equal(h.passes, 2, "a new spec branch is a change the issues probe cannot witness");
});

test("a branch disappearing forces a full pass even when the probe reports no change", () => {
  const h = harness([
    { branches: ["agent/spec-1-x", "agent/spec-2-y"], changed: false },
    { branches: ["agent/spec-1-x"], changed: false, advanceMs: 30_000 },
  ]);
  h.tick();
  h.tick();
  assert.equal(h.passes, 2);
});

test("a probe that cannot answer forces a full pass rather than a skipped refresh", () => {
  const h = harness([{ changed: false }, { changed: null, advanceMs: 30_000 }]);
  h.tick();
  h.tick();
  assert.equal(h.passes, 2, "a null verdict fails open to a full pass");
});

test("a probe that throws fails open to a full pass rather than ending the watch", () => {
  let passes = 0;
  let step = -1;
  const render = freshRender({
    branches: () => [],
    changed: () => {
      if (step === 1) throw new Error("gh: rate limited");
      return false;
    },
    pass: () => `frame ${++passes}`,
    now: () => 0,
    ceilingMs: 300_000,
  });
  step = 0;
  render();
  step = 1;
  assert.doesNotThrow(() => render());
  assert.equal(passes, 2);
});

test("the staleness ceiling forces a full pass even while the probe reports no change", () => {
  const h = harness(
    [
      { changed: false },
      { changed: false, advanceMs: 100 },
      { changed: false, advanceMs: 100 },
    ],
    150,
  );
  h.tick(); // pass at t=0
  h.tick(); // t=100, within the ceiling, no change → reuse
  assert.equal(h.passes, 1);
  h.tick(); // t=200, past the 150ms ceiling → forced pass
  assert.equal(h.passes, 2, "the ceiling forces a pass a change the probes cannot see would need");
});

test("the staleness ceiling resets after a pass", () => {
  const h = harness(
    [
      { changed: false }, // pass at t=0
      { changed: false, advanceMs: 200 }, // t=200 → ceiling forces pass, resets to t=200
      { changed: false, advanceMs: 100 }, // t=300, only 100ms since the reset → reuse
    ],
    150,
  );
  h.tick();
  h.tick();
  assert.equal(h.passes, 2);
  h.tick();
  assert.equal(h.passes, 2, "the ceiling counts from the last pass, not the last tick");
});

test("the probe runs every tick so its ETag tracks the latest state", () => {
  const h = harness([
    { changed: false },
    { changed: false, advanceMs: 30_000 },
    { changed: true, advanceMs: 30_000 },
  ]);
  h.tick();
  h.tick();
  h.tick();
  assert.equal(h.probes, 3, "even a reused tick probes, or the next tick's ETag is stale");
});

// The pure decision, exercised directly — the same rules the factory drives, with no state
// or closures in the way.
test("needsFullPass: no prior state is always a full pass", () => {
  assert.equal(needsFullPass(null, { branches: [], at: 0 }, false, 1000), true);
});

test("needsFullPass: a verified-unchanged tick within the ceiling reuses the frame", () => {
  const prev = { branches: ["a"], at: 0 };
  assert.equal(needsFullPass(prev, { branches: ["a"], at: 500 }, false, 1000), false);
});

test("needsFullPass: changed and could-not-tell both pass; only false reuses", () => {
  const prev = { branches: ["a"], at: 0 };
  const now = { branches: ["a"], at: 500 };
  assert.equal(needsFullPass(prev, now, true, 1000), true);
  assert.equal(needsFullPass(prev, now, null, 1000), true);
  assert.equal(needsFullPass(prev, now, false, 1000), false);
});
