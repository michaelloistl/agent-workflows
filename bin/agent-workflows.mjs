#!/usr/bin/env node
// Dispatcher bin for the agent-workflows package (issue #31).
//
// Consumers wire their `sandcastle:<verb>-<hook>` scripts at this one binary:
//
//   "sandcastle:implement-guards": "agent-workflows implement guards"
//   "sandcastle:implement":        "agent-workflows implement run"
//
// and the central reusable workflow invokes the PR-verb sequence by absolute
// path into the tooling checkout, resolved to the node_modules symlink (a
// consuming repo) or to this file (the central repo, which never installs
// itself):
//
//   "$AGENT_WORKFLOWS_BIN" review-pr   # cwd = PR head
//
// It maps (verb, hook) to an entrypoint file, resolves it override-first (a
// consumer's local .sandcastle/agent-workflows/ copy wins over the packaged
// src/ default), and runs it under tsx in a child process so the entrypoint
// sees a plain `node <entry> <args>` argv and its exit code propagates.
//
// This file is plain ESM JavaScript on purpose: it must start under bare `node`
// (it is the thing that bootstraps tsx), so it cannot itself be TypeScript.

import { spawn, spawnSync } from "node:child_process";
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
//   agent-workflows implement-spec <spec-issue> [--dry-run] [--pause] [--force]
//                                               [--interactive] [--stop]
//                                         → "spec-loop": drive a whole spec locally,
//                                           unattended by default (ADR-0011).
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
  // `status` is not a verb (issue #95): it runs no agent and follows no hook contract,
  // so it never reaches the (verb, hook) table. Classified before everything else
  // because its own flags would otherwise be read as hook names.
  if (verb === "status") return { kind: "status", args: args.slice(1) };
  // `init` and `sync` are not verbs either: they SET UP a repo to run the fleet rather
  // than running any part of it, so they follow no hook contract and reach no (verb,
  // hook) table. Classified here for the same reason `status` is — their flags would
  // otherwise be read as hook names, and a bare `init` as a whole-verb sequencer run.
  if (verb === "init" || verb === "sync") {
    return { kind: "install", mode: verb, args: args.slice(1) };
  }
  if (second === undefined) return { kind: "verb", verb };
  if (second === "--guards-only") return { kind: "verb", verb, guardsOnly: true };
  if (/^\d+$/.test(second)) {
    // `implement-spec <spec-issue>` is the attended SPEC LOOP (issue #59): it drives
    // a whole spec locally rather than running a single verb, so it routes to its
    // own entry point. A bare invocation runs the spec UNATTENDED (ADR-0011) — real
    // merges, no checkpoints, preview auto-accepted — so every flag here takes
    // something BACK rather than opting in.
    if (verb === "implement-spec") {
      return {
        kind: "spec-loop",
        spec: second,
        // `--dry-run` suppresses every irreversible action and halts where the loop
        // would first merge; `--pause` restores both human gates (the one-time
        // preview confirmation and the between-slices checkpoints).
        dryRun: rest.includes("--dry-run"),
        pause: rest.includes("--pause"),
        // `--force` overrules the local lock and each slice's guards. Deliberately
        // not part of the unattended default: it overrules a refusal, not a prompt.
        force: rest.includes("--force"),
        // Issue #60: `--interactive` hands each slice's implement run to a live agent
        // session (and therefore implies pausing); `--stop` is the graceful-stop
        // control command run from a second terminal.
        interactive: rest.includes("--interactive"),
        stop: rest.includes("--stop"),
        // `--execute` and `--yes` were the pre-ADR-0011 spelling of the default and
        // are now silent no-ops — not read here, because there is nothing left for
        // them to change. `--no-pause` is read even though it is equally a no-op: it
        // is half of the one contradiction a developer can still type out loud
        // (`--interactive --no-pause`), which the entry point refuses.
        noPause: rest.includes("--no-pause"),
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
// and confirming each slice from the terminal (issue #59). Unattended by default
// (ADR-0011); the flags forwarded below are the ways to take that back.
// Takes the classified invocation whole rather than one positional boolean per flag:
// the flags travel together, and a list of same-typed positionals is the shape a
// mis-ordered argument slips through unnoticed.
function runSpecLoop(invocation) {
  const { spec } = invocation;
  const runner = fileURLToPath(new URL("../src/sequencer/spec-loop-run.mts", import.meta.url));
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");

  const runnerArgs = [tsxCli, runner, spec];
  if (invocation.dryRun) runnerArgs.push("--dry-run");
  if (invocation.pause) runnerArgs.push("--pause");
  if (invocation.force) runnerArgs.push("--force");
  if (invocation.interactive) runnerArgs.push("--interactive");
  if (invocation.stop) runnerArgs.push("--stop");
  if (invocation.noPause) runnerArgs.push("--no-pause");
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

// Print the status view: spawn its entry point under tsx. Read-only — it takes no
// worktree, no lock, and no marker, because it changes nothing (ADR-0007).
//
// Spawned ASYNCHRONOUSLY, unlike every other runner here, because `--watch` can be
// interrupted: `spawnSync` blocks the event loop, so this process could not forward the
// signal and would die first, orphaning a watch that owns the terminal. A tty sends
// SIGINT to the whole process group and would reach the child anyway; a supervisor
// signalling this pid alone would not, and the child restores the screen on its way out.
function runStatusView(args) {
  const runner = fileURLToPath(new URL("../src/status/run.mts", import.meta.url));
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");

  const child = spawn(process.execPath, [tsxCli, runner, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    // Let the child unwind on its own: it exits by itself, and this process follows it
    // out through the `exit` handler below.
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error("agent-workflows: failed to run the status view:", error);
    process.exit(1);
  });
  // A child killed by a signal reports a null code; the watch treats its own interrupt
  // as an ordinary end, so this does too.
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}

// Set a repo up to run the fleet (`init`), or bring an installed one up to this
// package's version (`sync`). Spawned under tsx like every other entry point.
//
// This is the one command that runs BEFORE the package is a dependency — via
// `npx github:<owner>/agent-workflows#v1 init` — so it must not assume anything about
// the cwd beyond it being a git checkout. It gets that for free: tsx and the source
// both resolve relative to this file, in npm's cache, while the entry point reads and
// writes the cwd.
function runInstall(mode, args) {
  const runner = fileURLToPath(new URL("../src/install/run.mts", import.meta.url));
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");

  const child = spawnSync(process.execPath, [tsxCli, runner, mode, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (child.error) {
    console.error(`agent-workflows: failed to run ${mode}:`, child.error);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

function main() {
  const invocation = classifyInvocation(process.argv.slice(2));
  if (invocation.kind === "usage") {
    console.error(
      "usage: agent-workflows <verb> [hook | issue-number] [args...]\n" +
        "       agent-workflows status [options] (--help for the option list)\n" +
        "       agent-workflows init|sync [--enable=…] [--ref=…] [--dry-run] [--yes] (--help for the rest)",
    );
    process.exit(2);
  }
  if (invocation.kind === "status") {
    runStatusView(invocation.args);
    return;
  }
  if (invocation.kind === "install") {
    runInstall(invocation.mode, invocation.args);
    return;
  }
  if (invocation.kind === "verb") {
    runVerb(invocation.verb, invocation.guardsOnly);
    return;
  }
  if (invocation.kind === "spec-loop") {
    runSpecLoop(invocation);
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
