import { test } from "node:test";
import assert from "node:assert/strict";
import { packageVersion, statusFrame } from "./frame.mts";

const AT = new Date("2026-08-12T09:04:05");

test("a one-shot frame ends with one blank line and the running package version", () => {
  assert.equal(statusFrame("view", "1.6.0"), "view\n\nagent-workflows v1.6.0");
});

test("a watch frame carries the version, the interval, the clock and how to stop", () => {
  assert.equal(
    statusFrame("view", "1.6.0", { intervalMs: 5_000, at: AT }),
    "view\n\nagent-workflows v1.6.0 · watching every 5s · updated 09:04:05 · ctrl-c to stop",
  );
});

test("an unknown version says so rather than rendering `vunknown`", () => {
  assert.equal(statusFrame("view", null), "view\n\nagent-workflows version unknown");
  assert.equal(
    statusFrame("view", null, { intervalMs: 30_000, at: AT }),
    "view\n\nagent-workflows version unknown · watching every 30s · updated 09:04:05 · ctrl-c to stop",
  );
});

// The footer is read off a screenshot and out of a redirected file alike, so it carries no
// colour, no dimming and no hyperlink — whatever the terminal it was rendered on.
test("the footer is plain text in both modes", () => {
  const frames = [
    statusFrame("view", "1.6.0"),
    statusFrame("view", null),
    statusFrame("view", "1.6.0", { intervalMs: 5_000, at: AT }),
  ];
  for (const frame of frames) assert.doesNotMatch(frame, /\x1b/);
});

// The body arrives already rendered — painted, linked, quota line and all — and the frame
// only adds to it. Anything else would mean two renderers deciding what the view looks like.
test("the body is passed through untouched", () => {
  const body = "\x1b[2mquota · week 39% used\x1b[0m\n\nrepo — nothing is currently building.";
  assert.equal(statusFrame(body, "1.6.0"), `${body}\n\nagent-workflows v1.6.0`);
});

test("the interval is stated in whole seconds", () => {
  assert.match(statusFrame("view", "1.6.0", { intervalMs: 2_500, at: AT }), /watching every 3s/);
});

// The manifest is read by the dispatch half and normalised here, so every shape a damaged
// or unusual `package.json` can take resolves to the unknown footer rather than a throw.
test("a manifest version is taken only when it is a non-empty string", () => {
  assert.equal(packageVersion({ version: "1.6.0" }), "1.6.0");
  assert.equal(packageVersion({ version: " 1.6.0 " }), "1.6.0");
  assert.equal(packageVersion({}), null, "absent");
  assert.equal(packageVersion({ version: 2 }), null, "non-string");
  assert.equal(packageVersion({ version: "" }), null, "empty");
  assert.equal(packageVersion({ version: "   " }), null, "blank");
  assert.equal(packageVersion(null), null, "no manifest at all");
  assert.equal(packageVersion("1.6.0"), null, "not an object");
});
