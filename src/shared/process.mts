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

export interface CaptureOptions {
  // Discard the child's stderr instead of letting it reach the terminal. For the
  // few calls whose failure is EXPECTED and already handled by the caller — e.g.
  // creating a label that usually exists, where `gh` writes "already exists" to
  // stderr on the common path. Off by default: a command that fails unexpectedly
  // must still say why.
  readonly quiet?: boolean;
}

// Run a command and capture its stdout as a string. Used by PR-context gathering
// to shell out to `gh`. Args are passed as an array (never a shell string) so
// nothing is interpolated through a shell. The buffer is generous because PR
// diffs can be large; a non-zero exit throws and fails the run loudly.
//
// `execFileSync` sends the child's stderr to the parent's by default, which is what
// surfaces a real error — `quiet` opts a specific call out of that.
export function capture(
  file: string,
  args: ReadonlyArray<string>,
  opts: CaptureOptions = {},
): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.quiet ? { stdio: ["ignore", "pipe", "ignore"] as const } : {}),
  });
}
