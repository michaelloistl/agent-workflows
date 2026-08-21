// The `.sandcastle/.env` reader (ADR-0012). Sandcastle keeps the fleet's local
// credentials in one gitignored file — `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`,
// and now `DISCORD_WEBHOOK_URL` — but it resolves that file inside `run()` and merges
// it into the AGENT's environment only. The calling process never sees it. That was
// invisible until the run surface needed a credential in the SEQUENCER, which is what
// emits every event and never enters an agent's environment at all.
//
// So the sequencer reads the file itself. Two rules make that safe to add:
//
//   1. The parser is sandcastle's, transcribed line for line from its dist — first
//      `=` splits, both sides trimmed, matching quotes stripped, backslash escapes
//      expanded inside double quotes only, `#` lines and `=`-less lines skipped. A
//      line must not mean one thing to the agent and another to the process that
//      launches it, which is a class of bug nobody would think to look for.
//   2. The precedence is sandcastle's too: **the file wins over the environment**,
//      via `||` so an empty file value falls through. Note this INVERTS `config.mts`,
//      where the environment is the per-run override on top of a committed file. The
//      two are not inconsistent: `config.json` is committed repo policy that a run may
//      override, while `.sandcastle/.env` is the machine's credential store and the
//      agent already treats it as authoritative. Matching it is the whole point.
//
// Reading is tolerant, exactly like `loadConfigFile`: an absent or unparseable file
// collapses to `{}`. Most consuming repos have no such file, and none of them should
// fail to run because of it.
//
// One consequence worth naming: values applied here are inherited by every child the
// sequencer spawns (the bootstrap command, each slice's sequence). That is a wider
// reach than sandcastle's agent-only merge. It is accepted because the file's
// contents are already destined for those runs, and because the alternative — a
// key-by-key allowlist — would be a third precedence rule for a reader to learn.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Where the file lives in the consuming-repo checkout (cwd), beside the
// `.sandcastle/agent-workflows/config.json` that `configPath` resolves.
export function sandcastleEnvPath(cwd: string = process.cwd()): string {
  return resolve(cwd, ".sandcastle", ".env");
}

// Parse `.env` text into a plain key/value map, by sandcastle's rules (see above).
// Pure: no disk, no `process.env`, so every rule below is asserted rather than assumed.
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const doubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    const singleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
    if (doubleQuoted || singleQuoted) value = value.slice(1, -1);
    if (doubleQuoted) {
      value = value.replace(/\\([nrt\\])/g, (_, ch: string) =>
        ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\",
      );
    }
    vars[key] = value;
  }
  return vars;
}

// Read + parse the file. A missing or unreadable file is `{}` — never an error.
export function readSandcastleEnv(path: string = sandcastleEnvPath()): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// Merge the parsed file into an environment, FILE WINS. `||` rather than `??` so a
// blank value in the file falls through to whatever the shell has, matching
// sandcastle exactly. Returns the keys actually applied — the caller uses it only to
// decide whether to say anything, never to decide what happens next.
export function applySandcastleEnv(
  env: NodeJS.ProcessEnv,
  file: Record<string, string>,
): string[] {
  const applied: string[] = [];
  for (const key of Object.keys(file)) {
    const value = file[key] || env[key];
    if (!value) continue;
    if (env[key] === value) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

// The whole thing in one call — what the sequencer's entry point runs at startup,
// before any config resolution, so a key set in the file is already in place by the
// time anything reads it.
export function loadSandcastleEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  return applySandcastleEnv(env, readSandcastleEnv(sandcastleEnvPath(cwd)));
}
