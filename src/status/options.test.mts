import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  parseStatusArgs,
} from "./options.mts";

function options(argv: string[], isTTY = true) {
  const result = parseStatusArgs(argv, isTTY);
  assert.ok(result.ok, `expected ok, got: ${result.ok ? "" : result.message}`);
  return result.options;
}

function refusal(argv: string[], isTTY = true) {
  const result = parseStatusArgs(argv, isTTY);
  assert.equal(result.ok, false, "expected a refusal");
  return result.ok ? "" : result.message;
}

test("colour is on for a terminal and off for a pipe", () => {
  assert.deepEqual(options([], true), { colour: true, watchIntervalMs: null });
  assert.deepEqual(options([], false), { colour: false, watchIntervalMs: null });
});

test("--no-color suppresses colour even on a terminal", () => {
  assert.equal(options(["--no-color"], true).colour, false);
});

test("--no-colour is accepted too, since the repo spells it that way", () => {
  assert.equal(options(["--no-colour"], true).colour, false);
});

test("the flag is harmless off a terminal, where colour was already off", () => {
  assert.equal(options(["--no-color"], false).colour, false);
});

test("a bare argument is refused as readily as a flag: the view takes no repo", () => {
  assert.match(refusal(["madebyon/on-vantage"], false), /madebyon\/on-vantage/);
});

test("an unknown option is refused, and named in the message", () => {
  const message = refusal(["--json"]);
  assert.match(message, /--json/);
  assert.match(message, /--watch/, "the message lists what the view does take");
});

test("every unknown option is named, not just the first", () => {
  const message = refusal(["--json", "--repo"]);
  assert.match(message, /--json/);
  assert.match(message, /--repo/);
});

// --watch (issue #98). A one-shot render is still what you get without it.

test("without --watch the view renders once", () => {
  assert.equal(options([]).watchIntervalMs, null);
});

test("--watch redraws on the default interval", () => {
  assert.equal(options(["--watch"]).watchIntervalMs, DEFAULT_INTERVAL_SECONDS * 1000);
});

test("--interval sets the redraw cadence, in seconds, in either spelling", () => {
  assert.equal(options(["--watch", "--interval", "10"]).watchIntervalMs, 10_000);
  assert.equal(options(["--watch", "--interval=10"]).watchIntervalMs, 10_000);
});

test("--watch and --no-color are orthogonal", () => {
  assert.deepEqual(options(["--watch", "--no-color"]), {
    colour: false,
    watchIntervalMs: DEFAULT_INTERVAL_SECONDS * 1000,
  });
});

// Each redraw REPLACES the last, which a pipe or a file cannot do — so the flag is
// refused rather than quietly appending frames forever.
test("--watch is refused when stdout is not a terminal", () => {
  const message = refusal(["--watch"], false);
  assert.match(message, /--watch/);
  assert.match(message, /terminal/i);
});

test("--interval without --watch is refused, since a single render has no cadence", () => {
  const message = refusal(["--interval", "10"]);
  assert.match(message, /--watch/);
});

test("--interval with no value is refused rather than defaulted", () => {
  assert.match(refusal(["--watch", "--interval"]), /--interval/);
  assert.match(refusal(["--watch", "--interval", "--no-color"]), /--interval/);
});

test("a non-numeric interval is refused", () => {
  assert.match(refusal(["--watch", "--interval", "soon"]), /soon/);
});

// The floor is the rate limit's, not a preference: at a few calls per redraw a very
// tight interval would spend the hourly budget the agent runs also draw on.
test("an interval below the floor is refused, and the floor is named", () => {
  const message = refusal(["--watch", "--interval", "1"]);
  assert.match(message, new RegExp(String(MIN_INTERVAL_SECONDS)));
  assert.equal(options(["--watch", "--interval", String(MIN_INTERVAL_SECONDS)]).watchIntervalMs, MIN_INTERVAL_SECONDS * 1000);
});

test("a zero or negative interval is refused too", () => {
  assert.equal(parseStatusArgs(["--watch", "--interval", "0"], true).ok, false);
  assert.equal(parseStatusArgs(["--watch", "--interval", "-5"], true).ok, false);
});

// Past ~24.8 days `setTimeout` overflows and fires immediately, turning an absurd
// interval into no interval at all — the very thing the floor is there to prevent.
test("an interval beyond the ceiling is refused rather than overflowing the timer", () => {
  const message = refusal(["--watch", "--interval", "1000000000000"]);
  assert.match(message, new RegExp(String(MAX_INTERVAL_SECONDS)));
  assert.equal(
    options(["--watch", "--interval", String(MAX_INTERVAL_SECONDS)]).watchIntervalMs,
    MAX_INTERVAL_SECONDS * 1000,
  );
});

test("a fractional interval is refused, since the flag is documented in whole seconds", () => {
  assert.match(refusal(["--watch", "--interval", "7.5"]), /7\.5/);
});

test("--interval= with nothing after it is a missing value, not a zero", () => {
  const message = refusal(["--watch", "--interval="]);
  assert.match(message, /needs a value/);
});

// One round-trip per mistake is one too many: a command with two problems reports both.
test("an unknown flag is still named when the interval is also wrong", () => {
  const message = refusal(["--json", "--watch", "--interval", "nope"]);
  assert.match(message, /--json/);
});

test("the default interval is well inside the hourly rate limit", () => {
  // ~4 calls per redraw against GitHub's 5,000/hour for an authenticated user.
  const redrawsPerHour = 3600 / DEFAULT_INTERVAL_SECONDS;
  assert.ok(redrawsPerHour * 4 < 2000, `${redrawsPerHour} redraws/hour is not comfortable`);
});
