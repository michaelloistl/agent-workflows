import { test } from "node:test";
import assert from "node:assert/strict";
import { section } from "./markdown.mts";

test("section extracts the text under a `## heading`, case-insensitive", () => {
  const body = ["## Parent", "#42", "", "## Blocked by", "- #7"].join("\n");
  assert.equal(section(body, "parent"), "#42");
});

test("section stops at the next `## heading` and reads a multi-word heading", () => {
  const body = ["## Blocked by", "- #7", "- #9", "## Acceptance criteria", "- [ ] x"].join("\n");
  assert.equal(section(body, "Blocked by"), "- #7\n- #9");
});

test("section returns '' when the heading is absent", () => {
  assert.equal(section("## What to build\nstuff", "parent"), "");
});
