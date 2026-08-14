import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultRef, parseInstallArgs } from "./options.mts";

function ok(args: readonly string[]) {
  const parsed = parseInstallArgs(args);
  assert.ok(parsed.ok, `expected ${args.join(" ")} to parse`);
  return parsed.options;
}

function err(args: readonly string[]): string {
  const parsed = parseInstallArgs(args);
  assert.ok(!parsed.ok, `expected ${args.join(" ")} to be rejected`);
  return parsed.message;
}

test("no arguments leaves every choice to the repo", () => {
  const options = ok([]);
  assert.equal(options.verbs, null);
  assert.equal(options.ref, null);
  assert.equal(options.enableRuby, null);
  assert.equal(options.gitAuthorEmail, null);
  assert.equal(options.dryRun, false);
  assert.equal(options.yes, false);
});

test("--verbs is order-independent and deduplicated", () => {
  assert.deepEqual(ok(["--verbs=implement,explore"]).verbs, ["explore", "implement"]);
  assert.deepEqual(ok(["--verbs=explore,implement"]).verbs, ["explore", "implement"]);
  assert.deepEqual(ok(["--verbs=explore,explore"]).verbs, ["explore"]);
});

test("an unknown verb is rejected with the known ones listed", () => {
  const message = err(["--verbs=explore,implement-prd"]);
  assert.match(message, /unknown verb implement-prd/);
  assert.match(message, /implement-spec/);
});

test("--enable-ruby and --no-enable-ruby both override the detected default", () => {
  assert.equal(ok(["--enable-ruby"]).enableRuby, true);
  assert.equal(ok(["--no-enable-ruby"]).enableRuby, false);
});

test("--workflows-repo must be an owner/name slug", () => {
  assert.equal(ok(["--workflows-repo=fork/agent-workflows"]).workflowsRepo, "fork/agent-workflows");
  assert.match(err(["--workflows-repo=https://github.com/fork/x"]), /must be owner\/name/);
});

test("a flag with no value is rejected rather than read as empty", () => {
  assert.match(err(["--ref="]), /needs a value/);
});

test("unrecognised arguments are rejected", () => {
  assert.match(err(["--force"]), /unrecognised flag `--force`/);
  assert.match(err(["55"]), /unrecognised argument `55`/);
});

// These flags take their value with `=` only, so a space-separated value would
// otherwise be silently dropped and the default used instead.
test("a value flag given the wrong way round says so", () => {
  assert.match(err(["--ref", "v1"]), /`--ref` takes its value as `--ref=<value>`/);
});

test("--dry-run and --yes are read", () => {
  assert.equal(ok(["--dry-run"]).dryRun, true);
  assert.equal(ok(["--yes"]).yes, true);
  assert.equal(ok(["-y"]).yes, true);
});

// The compatibility promise is at the major, so a consumer tracking `v1` picks up a new
// hook on their next sync and a breaking change cannot reach them without re-pinning.
test("defaultRef pins the installer's own major version", () => {
  assert.equal(defaultRef("1.5.0"), "v1");
  assert.equal(defaultRef("2.0.0-rc.1"), "v2");
});
