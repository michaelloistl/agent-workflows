// Process / environment helpers shared by the agent-workflow entrypoints.

import { execFileSync } from "node:child_process";

// Read a required environment variable, or exit non-zero with a clear message.
// The workflow YAML treats a non-zero exit as a run failure (→ `agent:blocked`),
// so a missing variable fails loudly rather than running the agent half-wired.
export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// Run a command and capture its stdout as a string. Used by PR-context gathering
// to shell out to `gh`. Args are passed as an array (never a shell string) so
// nothing is interpolated through a shell. The buffer is generous because PR
// diffs can be large; a non-zero exit throws and fails the run loudly.
export function capture(file: string, args: ReadonlyArray<string>): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
