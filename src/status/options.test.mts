import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatusArgs } from "./options.mts";

test("colour is on for a terminal and off for a pipe", () => {
  assert.deepEqual(parseStatusArgs([], true), { ok: true, options: { colour: true } });
  assert.deepEqual(parseStatusArgs([], false), { ok: true, options: { colour: false } });
});

test("--no-color suppresses colour even on a terminal", () => {
  assert.deepEqual(parseStatusArgs(["--no-color"], true), { ok: true, options: { colour: false } });
});

test("--no-colour is accepted too, since the repo spells it that way", () => {
  assert.deepEqual(parseStatusArgs(["--no-colour"], true), { ok: true, options: { colour: false } });
});

test("the flag is harmless off a terminal, where colour was already off", () => {
  assert.deepEqual(parseStatusArgs(["--no-color"], false), { ok: true, options: { colour: false } });
});

// A flag that does nothing must say so rather than appear to work — `--watch` is issue
// #98 and does not exist yet.
test("an unknown option is refused, and named in the message", () => {
  const result = parseStatusArgs(["--watch"], true);
  assert.equal(result.ok, false);
  assert.match(result.message, /--watch/);
  assert.match(result.message, /--no-color/);
});

test("every unknown option is named, not just the first", () => {
  const result = parseStatusArgs(["--watch", "--json"], false);
  assert.equal(result.ok, false);
  assert.match(result.message, /--watch/);
  assert.match(result.message, /--json/);
});

test("a bare argument is refused as readily as a flag: the view takes no repo", () => {
  const result = parseStatusArgs(["madebyon/on-vantage"], false);
  assert.equal(result.ok, false);
  assert.match(result.message, /madebyon\/on-vantage/);
});
