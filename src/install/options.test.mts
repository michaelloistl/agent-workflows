import { test } from "node:test";
import assert from "node:assert/strict";

import { INSTALL_USAGE, defaultRef, parseInstallArgs } from "./options.mts";

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
  assert.equal(options.installables, null);
  assert.equal(options.ref, null);
  assert.equal(options.enableRuby, null);
  assert.equal(options.gitAuthorEmail, null);
  assert.equal(options.dryRun, false);
  assert.equal(options.yes, false);
  assert.equal(options.help, false);
});

test("--enable is order-independent and deduplicated", () => {
  assert.deepEqual(ok(["--enable=implement,explore"]).installables, ["explore", "implement"]);
  assert.deepEqual(ok(["--enable=explore,implement"]).installables, ["explore", "implement"]);
  assert.deepEqual(ok(["--enable=explore,explore"]).installables, ["explore"]);
});

test("an unknown workflow is rejected with the known ones listed", () => {
  const message = err(["--enable=explore,implement-prd"]);
  assert.match(message, /cannot enable implement-prd/);
  assert.match(message, /implement-spec/);
});

// The command the README leads with is reached through `npx`, before the package is
// installed and before there is anything else to read the flag list off.
test("--help and -h ask for the usage text rather than being rejected", () => {
  assert.equal(ok(["--help"]).help, true);
  assert.equal(ok(["-h"]).help, true);
  // Still parsed alongside the rest, so `init --enable=explore --help` explains
  // itself rather than complaining about the flag it did not reach.
  assert.equal(ok(["--enable=explore", "--help"]).help, true);
  assert.match(INSTALL_USAGE, /--enable=/);
  assert.match(INSTALL_USAGE, /--dry-run/);
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
