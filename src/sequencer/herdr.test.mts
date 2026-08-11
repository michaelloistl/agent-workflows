import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectHerdr,
  sliceTitle,
  haltNotice,
  completeNotice,
  renameCommand,
  notifyCommand,
  createHerdrSurface,
} from "./herdr.mts";

// — detectHerdr —

// The env var name is verified against a live Herdr session, not guessed: a wrong
// name disables the whole surface silently, because "no pane" and "wrong var" look
// identical to a best-effort emitter.
test("detectHerdr returns the pane when HERDR_PANE_ID is set", () => {
  assert.deepEqual(detectHerdr({ HERDR_PANE_ID: "wR:p2" }), { pane: "wR:p2" });
});

test("detectHerdr ignores the old guessed variable name", () => {
  assert.equal(detectHerdr({ HERDR_PANE: "wR:p2" }), null);
});

test("detectHerdr returns null outside a Herdr pane", () => {
  assert.equal(detectHerdr({}), null);
  assert.equal(detectHerdr({ HERDR_PANE_ID: "" }), null);
});

// — pure text —

test("sliceTitle names the spec, position, and slice compactly", () => {
  assert.equal(sliceTitle({ spec: 48, slice: 5, position: 2, total: 3 }), "spec #48 · 2/3 · #5");
});

test("haltNotice carries the halt reason", () => {
  assert.match(haltNotice({ spec: 48, reason: "the spec-branch tip CI did not pass" }), /spec #48 halted: the spec-branch tip CI did not pass/);
});

test("completeNotice says the final PR opened", () => {
  assert.match(completeNotice({ spec: 48 }), /spec #48 complete — final PR opened/);
});

// — command builders —

// `herdr pane rename <pane_id> <label>` — the `pane` group, id positional.
test("renameCommand builds a herdr pane rename with the id positional", () => {
  assert.deepEqual(renameCommand({ pane: "wR:p2" }, "spec #48 · 2/3 · #5"), {
    file: "herdr",
    args: ["pane", "rename", "wR:p2", "spec #48 · 2/3 · #5"],
  });
});

// `herdr notification show <title>` — session-scoped; there is no per-pane notify,
// so the message itself carries the spec.
test("notifyCommand builds a herdr notification show", () => {
  assert.deepEqual(notifyCommand("done"), {
    file: "herdr",
    args: ["notification", "show", "done"],
  });
});

// — createHerdrSurface: the best-effort surface —

test("outside a Herdr pane the surface is inactive and emits nothing", () => {
  const calls: unknown[] = [];
  const surface = createHerdrSurface({}, (file, args) => calls.push([file, args]));
  assert.equal(surface.active, false);
  surface.renameToSlice({ spec: 48, slice: 5, position: 2, total: 3 });
  surface.notifyHalt({ spec: 48, reason: "x" });
  surface.notifyComplete({ spec: 48 });
  assert.deepEqual(calls, []);
});

test("inside a Herdr pane renameToSlice runs the rename command", () => {
  const calls: Array<[string, readonly string[]]> = [];
  const surface = createHerdrSurface({ HERDR_PANE_ID: "wR:p2" }, (file, args) => calls.push([file, args]));
  assert.equal(surface.active, true);
  surface.renameToSlice({ spec: 48, slice: 5, position: 2, total: 3 });
  assert.deepEqual(calls, [["herdr", ["pane", "rename", "wR:p2", "spec #48 · 2/3 · #5"]]]);
});

test("inside a Herdr pane notifyHalt and notifyComplete fire notifications", () => {
  const calls: Array<[string, readonly string[]]> = [];
  const surface = createHerdrSurface({ HERDR_PANE_ID: "wR:p2" }, (file, args) => calls.push([file, args]));
  surface.notifyHalt({ spec: 48, reason: "boom" });
  surface.notifyComplete({ spec: 48 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["herdr", ["notification", "show", "spec #48 halted: boom"]]);
  assert.deepEqual(calls[1], ["herdr", ["notification", "show", "spec #48 complete — final PR opened"]]);
});

test("a throwing spawn (e.g. the herdr CLI is absent) never propagates", () => {
  const surface = createHerdrSurface({ HERDR_PANE_ID: "wR:p2" }, () => {
    throw new Error("spawn herdr ENOENT");
  });
  assert.doesNotThrow(() => surface.renameToSlice({ spec: 48, slice: 5, position: 2, total: 3 }));
  assert.doesNotThrow(() => surface.notifyHalt({ spec: 48, reason: "x" }));
  assert.doesNotThrow(() => surface.notifyComplete({ spec: 48 }));
});
