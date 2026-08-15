// `agent-workflows status -h` / `--help` (issue #123), tested at the EXECUTABLE boundary
// rather than at the parser: what is being promised here is that the whole command —
// dispatcher, entry point, and all — answers a help flag by printing to stdout and exiting
// 0 before it reads anything. A unit test of the option parser cannot observe the exit
// status, the stream, or the reads that did not happen, which is the entire feature.
//
// Every run below therefore spawns the real bin from a directory that is NOT a git
// checkout, with an EMPTY PATH so `git`, `gh` and `claude` cannot be found at all. Node
// itself is invoked by absolute path and resolves tsx and the source relative to this
// package, so a help run that needs none of the three succeeds in that environment and one
// that reads any of them cannot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
} from "./options.mts";

const BIN = fileURLToPath(new URL("../../bin/agent-workflows.mjs", import.meta.url));

// Outside any checkout, with nothing on the PATH and no `GH_REPO` — the environment a
// person learning the command is in, and the one every prerequisite would fail in.
function status(...args: string[]) {
  const result = spawnSync(process.execPath, [BIN, "status", ...args], {
    cwd: mkdtempSync(`${tmpdir()}/agent-workflows-help-`),
    env: { PATH: "" },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return result;
}

test("--help prints to stdout and exits 0, with nothing on stderr", () => {
  const result = status("--help");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /usage: agent-workflows status \[options\]/);
});

test("-h is the same help, so the conventional shorthand needs no learning", () => {
  const short = status("-h");
  const long = status("--help");
  assert.equal(short.status, 0);
  assert.equal(short.stdout, long.stdout);
});

test("help names both invocation forms — the binary and the package script", () => {
  const { stdout } = status("--help");
  assert.match(stdout, /agent-workflows status \[options\]/);
  assert.match(stdout, /yarn agent:status \[options\]/);
});

// The inventory `options.mts` defines. Help that lists some of the options is a worse
// answer than none: it reads as complete.
test("help documents every option the view takes, in both spellings where there are two", () => {
  const { stdout } = status("--help");
  for (const flag of [
    "-h",
    "--help",
    "--watch",
    "--interval <seconds>",
    "--no-color",
    "--no-colour",
    "--no-hyperlinks",
    "--hyperlinks",
    "--no-headroom",
  ]) {
    assert.ok(stdout.includes(flag), `expected help to document ${flag}`);
  }
});

// The three numbers a person picking a cadence needs, taken from the constants the parser
// validates against so the two cannot drift.
test("help gives the watch default and the interval bounds", () => {
  const { stdout } = status("--help");
  assert.match(stdout, new RegExp(`${DEFAULT_INTERVAL_SECONDS}s`));
  assert.match(
    stdout,
    new RegExp(`${MIN_INTERVAL_SECONDS}\\D+${MAX_INTERVAL_SECONDS}`),
    "the interval range, in order",
  );
});

test("help explains what depends on stdout being a terminal", () => {
  const { stdout } = status("--help");
  assert.match(stdout, /terminal/i);
  assert.match(stdout, /redirected|piped/i, "and what redirected output gets instead");
});

test("help explains the Herdr hyperlink default and its override", () => {
  const { stdout } = status("--help");
  assert.match(stdout, /HERDR_ENV=1/);
  assert.match(stdout, /--hyperlinks/);
});

// The domain term, not "usage": `CONTEXT.md` rules that word out because consumption
// already incurred points at the opposite decision from the one this line is read to make.
test("help describes --no-headroom in the glossary's vocabulary", () => {
  assert.match(status("--help").stdout, /quota headroom/);
});

// Precedence, in both directions and in either order. Asking for documentation must never
// start a render or a watch, and must never be answered with a refusal about the OTHER
// argument — the user is asking what the arguments are.
test("help wins over a valid companion option, in either order", () => {
  for (const args of [["--watch", "--help"], ["--help", "--watch"], ["--no-color", "-h"]]) {
    const result = status(...args);
    assert.equal(result.status, 0, `expected 0 for ${args.join(" ")}`);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /usage: agent-workflows status/);
  }
});

test("help wins over an invalid companion option rather than refusing", () => {
  for (const args of [["--json", "--help"], ["-h", "--json"], ["--interval", "nope", "-h"]]) {
    const result = status(...args);
    assert.equal(result.status, 0, `expected 0 for ${args.join(" ")}`);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /usage: agent-workflows status/);
  }
});

// The other half of the promise: with no help flag, the command still does what it did.
// Outside a checkout with an empty PATH there is no repo to resolve, so this is the repo
// refusal — proof that the help runs above were not merely finding a repo to be quiet
// about, and that the refusal path is untouched.
test("without a help flag the command still resolves a repo, and still refuses without one", () => {
  const result = status();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /agent-workflows status:/);
});

test("an unknown option is still refused when no help flag is present", () => {
  const result = status("--json");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--json/);
});
