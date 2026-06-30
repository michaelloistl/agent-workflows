import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./text.mts";

test("slugify lowercases, hyphenates runs of non-alphanumerics, and trims", () => {
  assert.equal(slugify("Add PRD: Orchestrate tracer-bullets!"), "add-prd-orchestrate-tracer-bullets");
  assert.equal(slugify("  spaces  "), "spaces");
});

test("slugify caps the slug at 40 characters", () => {
  assert.equal(slugify("x".repeat(80)).length, 40);
});
