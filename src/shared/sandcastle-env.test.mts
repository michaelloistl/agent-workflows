import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnvFile,
  readSandcastleEnv,
  applySandcastleEnv,
  sandcastleEnvPath,
} from "./sandcastle-env.mts";

// — parseEnvFile: mirrors sandcastle's own parser, deliberately —
//
// Every case here was read off `parseEnvFile` in @ai-hero/sandcastle's dist. The
// point is not that these rules are the best ones, it is that they are THE SAME
// rules, so a line in `.sandcastle/.env` cannot mean one thing to the agent and
// another to the sequencer that launches it.

test("parseEnvFile reads plain KEY=VALUE lines", () => {
  assert.deepEqual(parseEnvFile("A=1\nB=two\n"), { A: "1", B: "two" });
});

test("parseEnvFile skips blank lines and comments", () => {
  assert.deepEqual(parseEnvFile("\n# a comment\nA=1\n\n   # indented comment\n"), { A: "1" });
});

test("parseEnvFile skips lines with no '='", () => {
  assert.deepEqual(parseEnvFile("NOPE\nA=1\n"), { A: "1" });
});

// The webhook URL has a query-free path but every Discord send appends `?wait=true`,
// and a consumer may well paste something with an `=` in it — so first-match splitting
// is load-bearing rather than incidental.
test("parseEnvFile splits on the FIRST '=' so a value may contain more", () => {
  assert.deepEqual(parseEnvFile("URL=https://x/y?a=b&c=d\n"), { URL: "https://x/y?a=b&c=d" });
});

test("parseEnvFile trims the key and the value", () => {
  assert.deepEqual(parseEnvFile("  A  =  1  \n"), { A: "1" });
});

test("parseEnvFile strips matching single or double quotes", () => {
  assert.deepEqual(parseEnvFile('A="1"\nB=\'2\'\n'), { A: "1", B: "2" });
});

test("parseEnvFile unescapes \\n \\r \\t and \\\\ inside DOUBLE quotes only", () => {
  assert.deepEqual(parseEnvFile('A="x\\ny"\n'), { A: "x\ny" });
  assert.deepEqual(parseEnvFile("B='x\\ny'\n"), { B: "x\\ny" });
});

test("parseEnvFile keeps an unmatched quote as part of the value", () => {
  assert.deepEqual(parseEnvFile('A="1\n'), { A: '"1' });
});

test("parseEnvFile yields an empty value for a bare KEY=", () => {
  assert.deepEqual(parseEnvFile("A=\n"), { A: "" });
});

// — readSandcastleEnv: tolerant I/O —
//
// Tolerant for the same reason `loadConfigFile` is: the sequencer must never fail to
// run because a consumer has no `.sandcastle/.env`. Most consuming repos will not.

test("readSandcastleEnv returns {} when the file is absent", () => {
  assert.deepEqual(readSandcastleEnv(join(tmpdir(), `absent-${process.pid}`, ".env")), {});
});

test("readSandcastleEnv parses a file that is there", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, "DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1/tok\n");
  assert.deepEqual(readSandcastleEnv(path), {
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/tok",
  });
});

// — applySandcastleEnv: FILE WINS —
//
// The precedence is sandcastle's (`sandcastleEnv[key] || process.env[key]`), matched
// rather than improved on. It is the OPPOSITE of `config.mts`, where the environment
// is the per-run override — and that difference is exactly why it is worth pinning.

test("applySandcastleEnv sets keys the environment does not have", () => {
  const env: NodeJS.ProcessEnv = {};
  applySandcastleEnv(env, { A: "1" });
  assert.equal(env.A, "1");
});

test("applySandcastleEnv OVERRIDES a key already in the environment", () => {
  const env: NodeJS.ProcessEnv = { A: "from-shell" };
  applySandcastleEnv(env, { A: "from-file" });
  assert.equal(env.A, "from-file");
});

// `||`, not `??`: an empty value in the file is falsy to sandcastle, so the shell's
// value survives. Matched exactly, so "blank it out to unset it" fails the same way
// in both readers rather than only in one of them.
test("an EMPTY file value falls through to the environment, as sandcastle's || does", () => {
  const env: NodeJS.ProcessEnv = { A: "from-shell" };
  applySandcastleEnv(env, { A: "" });
  assert.equal(env.A, "from-shell");
});

test("an empty file value with nothing in the environment leaves the key unset", () => {
  const env: NodeJS.ProcessEnv = {};
  applySandcastleEnv(env, { A: "" });
  assert.equal(env.A, undefined);
});

test("applySandcastleEnv leaves environment keys the file never mentions alone", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  applySandcastleEnv(env, { A: "1" });
  assert.equal(env.PATH, "/usr/bin");
});

test("applySandcastleEnv reports the keys it applied", () => {
  const env: NodeJS.ProcessEnv = { A: "from-shell" };
  assert.deepEqual(applySandcastleEnv(env, { A: "", B: "2" }), ["B"]);
});

// — sandcastleEnvPath —

test("sandcastleEnvPath points at .sandcastle/.env under the checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-root-"));
  mkdirSync(join(dir, ".sandcastle"));
  assert.equal(sandcastleEnvPath(dir), join(dir, ".sandcastle", ".env"));
});
