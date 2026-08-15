import { test } from "node:test";
import assert from "node:assert/strict";
import { runningVersion } from "./version.mts";

// The one link in this feature that fails SILENTLY: the footer's fallback is `version
// unknown`, so a resolution that stops finding the packaged manifest — this module moving a
// directory, the manifest losing its version — degrades the footer forever without a failing
// test or a line on stderr. This test reads the real manifest through the real function, so
// it goes red exactly when the link is broken and never otherwise.
test("the running package version resolves against the real packaged manifest", () => {
  const version = runningVersion();
  assert.notEqual(version, null, "the packaged manifest no longer resolves from src/status/");
  assert.match(version!, /^\d+\.\d+\.\d+/);
});
