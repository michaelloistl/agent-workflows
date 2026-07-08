#!/usr/bin/env node
// Dispatcher bin for the agent-workflows package (issue #31).
//
// Consumers wire their `sandcastle:<verb>-<hook>` scripts at this one binary:
//
//   "sandcastle:implement-guards": "agent-workflows implement guards"
//   "sandcastle:implement":        "agent-workflows implement run"
//
// and the central reusable workflow invokes the PR-verb agent run by absolute
// path into the tooling checkout:
//
//   "$TOOLING_DIR/node_modules/.bin/agent-workflows" review-pr run   # cwd = PR head
//
// It maps (verb, hook) to an entrypoint file, resolves it override-first (a
// consumer's local .sandcastle/agent-workflows/ copy wins over the packaged
// src/ default), and runs it under tsx in a child process so the entrypoint
// sees a plain `node <entry> <args>` argv and its exit code propagates.
//
// This file is plain ESM JavaScript on purpose: it must start under bare `node`
// (it is the thing that bootstraps tsx), so it cannot itself be TypeScript.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

// (verb, hook) → entrypoint path relative to a source root.
//
// - The `review-pr` verb lives under the `review/` dir; every other verb's dir
//   matches its name.
// - The `run` hook (the agent run itself) is the `<dir>/<dir>.mts` entry;
//   every other hook is `<dir>/<hook>.mts`. This generic rule also covers the
//   implement-spec orchestrator's non-standard hooks (kickoff, advance).
export function resolveEntryRelPath(verb, hook) {
  const dir = verb === "review-pr" ? "review" : verb;
  const file = hook === "run" ? dir : hook;
  return join(dir, `${file}.mts`);
}

// Resolve the entrypoint override-first. `exists` is injectable for testing.
export function resolveEntry(verb, hook, { cwd, srcDir, exists = existsSync }) {
  const rel = resolveEntryRelPath(verb, hook);
  const override = resolve(cwd, ".sandcastle", "agent-workflows", rel);
  if (exists(override)) return { path: override, source: "override" };
  return { path: join(srcDir, rel), source: "packaged" };
}

function main() {
  const [verb, hook, ...rest] = process.argv.slice(2);
  if (!verb || !hook) {
    console.error("usage: agent-workflows <verb> <hook> [args...]");
    process.exit(2);
  }

  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const { path: entry } = resolveEntry(verb, hook, {
    cwd: process.cwd(),
    srcDir,
  });

  if (!existsSync(entry)) {
    console.error(
      `agent-workflows: no entrypoint for "${verb} ${hook}" (looked for ${entry})`,
    );
    process.exit(2);
  }

  // Resolve tsx relative to this package, not the consumer's cwd — the PR-verb
  // working tree may predate the tooling and lack tsx entirely.
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");

  const child = spawnSync(process.execPath, [tsxCli, entry, ...rest], {
    stdio: "inherit",
    env: process.env,
  });

  if (child.error) {
    console.error(`agent-workflows: failed to run ${entry}:`, child.error);
    process.exit(1);
  }
  // Forward the signal-or-status exit code so guard refusals (non-zero) and the
  // agent-run "produced nothing" exit propagate to the workflow unchanged.
  process.exit(child.status ?? 1);
}

// Only run when invoked as the bin, not when imported by the resolver test.
// Compare realpaths: when run via the node_modules/.bin symlink, argv[1] is the
// symlink path while import.meta.url is already realpath-resolved, so a raw
// string compare would never match.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
