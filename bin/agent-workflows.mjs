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

// Classify the raw argv tail into an invocation kind. Three shapes are supported:
//
//   agent-workflows <verb>                → "verb": run the verb's whole sequence
//                                           via the sequencer (issue #49).
//   agent-workflows <verb> --guards-only  → "verb" in guards-only mode: run just
//                                           the guard step, for the light guard
//                                           job's cheap preflight (issue #50).
//   agent-workflows <verb> <issue-number> [--force] [--finalize=auto|ask|never]
//                                          [--interactive]
//                                         → "attended": run the verb locally as an
//                                           attended run against that issue, in its
//                                           own git worktree (issue #55). A hook
//                                           name is never all-digits, so a numeric
//                                           second arg disambiguates cleanly. A
//                                           trailing `--force` overrules a refusal
//                                           and both concurrency mutexes (issue #56);
//                                           `--finalize=<mode>` selects an `implement`
//                                           run's finalize policy (issue #57);
//                                           `--interactive` hands the composed prompt
//                                           to a live agent session (issue #58). All
//                                           are forwarded to the attended entry point.
//   agent-workflows <verb> <hook>         → "hook": run one hook (the original
//                                           form, unchanged — what consuming
//                                           repos' `sandcastle:<verb>-<hook>`
//                                           scripts call).
//
// Exported so the top-level dispatch is testable without spawning a child.
export function classifyInvocation(args) {
  const [verb, second, ...rest] = args;
  if (!verb) return { kind: "usage" };
  if (second === undefined) return { kind: "verb", verb };
  if (second === "--guards-only") return { kind: "verb", verb, guardsOnly: true };
  if (/^\d+$/.test(second)) {
    // `implement-spec <spec-issue>` is the attended SPEC LOOP (issue #59): it drives
    // a whole spec locally rather than running a single verb, so it routes to its
    // own entry point. A dry run is the safer default; `--execute` opts into real
    // merges and `--force` overrules the local lock and each slice's guards.
    if (verb === "implement-spec") {
      return {
        kind: "spec-loop",
        spec: second,
        execute: rest.includes("--execute"),
        dryRun: rest.includes("--dry-run"),
        force: rest.includes("--force"),
        // Issue #60: `--no-pause` runs the whole spec straight through (the loop
        // otherwise pauses at a checkpoint between slices); `--interactive` hands
        // each slice's implement run to a live agent session; `--stop` is the
        // graceful-stop control command run from a second terminal.
        noPause: rest.includes("--no-pause"),
        interactive: rest.includes("--interactive"),
        stop: rest.includes("--stop"),
      };
    }
    // Forward the attended flags verbatim (the entry point parses their meaning):
    // `--force` (issue #56), `--finalize=<mode>` (issue #57), and `--interactive`
    // (issue #58). `finalize` carries the raw flag string so a typo surfaces at the
    // entry point, not here.
    return {
      kind: "attended",
      verb,
      issue: second,
      force: rest.includes("--force"),
      finalize: rest.find((a) => a.startsWith("--finalize=")),
      interactive: rest.includes("--interactive"),
    };
  }
  return { kind: "hook", verb, hook: second, rest };
}

// Run a whole verb through the sequencer: spawn its bridge entrypoint under tsx.
// The bridge (src/sequencer/run.mts) re-invokes THIS bin once per step in the
// verb's plan, so every step still goes through the unchanged per-hook path.
function runVerb(verb, guardsOnly) {
  const runner = fileURLToPath(new URL("../src/sequencer/run.mts", import.meta.url));
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");

  const runnerArgs = [tsxCli, runner, verb];
  if (guardsOnly) runnerArgs.push("--guards-only");
  const child = spawnSync(process.execPath, runnerArgs, {
    stdio: "inherit",
    env: process.env,
  });
  if (child.error) {
    console.error(`agent-workflows: failed to run sequencer for "${verb}":`, child.error);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

// Run a verb locally as an attended run: spawn the attended sequencer entrypoint
// under tsx. It creates a git worktree, bootstraps it, streams the run to the
// terminal, and cleans up per the worktree policy (issue #55).
function runAttended(verb, issue, force, finalize, interactive) {
  const runner = fileURLToPath(new URL("../src/sequencer/attended.mts", import.meta.url));
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");

  const runnerArgs = [tsxCli, runner, verb, issue];
  if (force) runnerArgs.push("--force");
  if (finalize) runnerArgs.push(finalize);
  if (interactive) runnerArgs.push("--interactive");
  const child = spawnSync(process.execPath, runnerArgs, {
    stdio: "inherit",
    env: process.env,
  });
  if (child.error) {
    console.error(`agent-workflows: failed to run attended ${verb} #${issue}:`, child.error);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

// Run a whole spec locally as the attended spec loop: spawn the loop entrypoint
// under tsx. It creates one worktree on the spec branch, bootstraps it once, and
// builds the spec's tracer-bullets one at a time — dispatching, gating, merging,
// and confirming each slice from the terminal (issue #59).
function runSpecLoop(spec, execute, dryRun, force, noPause, interactive, stop) {
  const runner = fileURLToPath(new URL("../src/sequencer/spec-loop-run.mts", import.meta.url));
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");

  const runnerArgs = [tsxCli, runner, spec];
  if (execute) runnerArgs.push("--execute");
  if (dryRun) runnerArgs.push("--dry-run");
  if (force) runnerArgs.push("--force");
  if (noPause) runnerArgs.push("--no-pause");
  if (interactive) runnerArgs.push("--interactive");
  if (stop) runnerArgs.push("--stop");
  const child = spawnSync(process.execPath, runnerArgs, {
    stdio: "inherit",
    env: process.env,
  });
  if (child.error) {
    console.error(`agent-workflows: failed to run the spec loop for #${spec}:`, child.error);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

function main() {
  const invocation = classifyInvocation(process.argv.slice(2));
  if (invocation.kind === "usage") {
    console.error("usage: agent-workflows <verb> [hook | issue-number] [args...]");
    process.exit(2);
  }
  if (invocation.kind === "verb") {
    runVerb(invocation.verb, invocation.guardsOnly);
    return;
  }
  if (invocation.kind === "spec-loop") {
    runSpecLoop(
      invocation.spec,
      invocation.execute,
      invocation.dryRun,
      invocation.force,
      invocation.noPause,
      invocation.interactive,
      invocation.stop,
    );
    return;
  }
  if (invocation.kind === "attended") {
    runAttended(
      invocation.verb,
      invocation.issue,
      invocation.force,
      invocation.finalize,
      invocation.interactive,
    );
    return;
  }

  const { verb, hook, rest } = invocation;
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
