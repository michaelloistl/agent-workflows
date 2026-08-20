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
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
// `--version` / `-v` and `--help` / `-h` are classified before any of them, but only in
// the FIRST argv position (issues #130 and #131): anywhere later they are left in the argv
// of the command they follow, for that command to make of what it will. `status` and
// `init`/`sync` each parse a help flag of their own, so `agent-workflows status --help`
// answers with the status view's option list. No verb entry point reads one yet, so after a
// verb the flag is carried along and ignored — `agent-workflows implement 42 --help` starts
// the attended run rather than describing it.
//
// Exported so the top-level dispatch is testable without spawning a child.
export function classifyInvocation(args) {
  const [verb, second, ...rest] = args;
  if (!verb) return { kind: "usage" };
  // Leading `--version` is not a verb: left to fall through, it spawned the sequencer for
  // a verb by that name. Classified first so no later rule can claim it.
  if (verb === "--version" || verb === "-v") return { kind: "version" };
  // Leading `--help` shares that slot, and for the same reason: unclassified it spawned
  // the sequencer for a verb named `--help`.
  if (verb === "--help" || verb === "-h") return { kind: "help" };
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
        // `--yes` pre-accepts the preview prompt. A non-interactive stdin declines it,
        // so without this nothing but a human at a terminal can start a run.
        yes: rest.includes("--yes"),
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

// What `--help` prints: every form this bin answers to, grouped so a reader can find
// their case rather than read the lot. Lives here beside `classifyInvocation` for the
// reason `STATUS_USAGE` and `INSTALL_USAGE` live beside their parsers — the list and the
// classification going out of step is the whole hazard.
//
// Wrapped inside 80 columns, and it POINTS AT `status --help` and `init --help` instead
// of restating their option lists: those two own their own flags, and a copy here would
// be the copy that goes stale.
export const BIN_USAGE = [
  "usage: agent-workflows <command> [args...]",
  "",
  "Runs the coding-agent fleet: the five verbs — explore, implement, implement-pr,",
  "review-pr, update-branch — plus the implement-spec orchestrator.",
  "",
  "Verb sequences",
  "  <verb>                     run the verb's whole sequence in this checkout",
  "  <verb> --guards-only       run just the guard step (the cheap preflight)",
  "",
  "One hook",
  "  <verb> <hook>              run a single hook: guards, fetch-spec, run, status",
  "                             or finalize — what a consuming repo's",
  "                             sandcastle:<verb>-<hook> scripts call",
  "",
  "Spec orchestrator (not a verb: it runs no agent of its own)",
  "  implement-spec             sequence its kickoff or advance entry point,",
  "                             whichever SPEC_MODE names",
  "  implement-spec <hook>      run one of its own hooks: guards, kickoff or",
  "                             advance — the sandcastle:implement-spec-* form",
  "",
  "Attended local runs",
  "  <verb> <issue> [flags]     run the verb here against that issue, in its own",
  "                             git worktree, streamed to this terminal",
  "    --force                  overrule a refusal and both concurrency mutexes",
  "    --finalize=auto|ask|never  an implement run's finalize policy",
  "    --interactive            hand the composed prompt to a live agent session",
  "",
  "Attended spec loop",
  "  implement-spec <spec> [flags]  build a spec's tracer-bullets one at a time",
  "    --execute                do it for real (a dry run is the default)",
  "    --dry-run                the default: plan the slices and merge nothing",
  "    --force                  overrule the local lock and each slice's guards",
  "    --no-pause               run straight through, without the checkpoint",
  "    --interactive            steer each slice in a live agent session",
  "    --yes                    pre-accept the preview prompt",
  "    --stop                   ask a running loop to stop after this slice",
  "",
  "Everything else",
  "  status [options]           print what is building in this repo, read-only",
  "                             (status --help for the option list)",
  "  init | sync [flags]        set a repo up to run the fleet, or move an",
  "                             installed one to this package's version",
  "                             (init --help for the flags)",
  "  --version, -v              print the running package version",
  "  --help, -h                 print this",
  "",
  "Both top-level flags are read in the first position only. Later in the line they",
  "belong to the command they follow: status and init | sync answer their own",
  "--help, while a verb does not read one yet — <verb> <issue> --help starts the",
  "run.",
].join("\n");

// Asking for help is not a misuse, so it goes to stdout and exits 0 — unlike the bare
// invocation, which is one and keeps its stderr and its exit 2.
function printUsage() {
  console.log(BIN_USAGE);
  process.exit(0);
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
// Takes the classified invocation whole rather than one positional boolean per flag:
// the flags travel together, and a list of same-typed positionals is the shape a
// mis-ordered argument slips through unnoticed.
function runSpecLoop(invocation) {
  const { spec } = invocation;
  const runner = fileURLToPath(new URL("../src/sequencer/spec-loop-run.mts", import.meta.url));
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");

  const runnerArgs = [tsxCli, runner, spec];
  if (invocation.execute) runnerArgs.push("--execute");
  if (invocation.dryRun) runnerArgs.push("--dry-run");
  if (invocation.force) runnerArgs.push("--force");
  if (invocation.noPause) runnerArgs.push("--no-pause");
  if (invocation.interactive) runnerArgs.push("--interactive");
  if (invocation.stop) runnerArgs.push("--stop");
  if (invocation.yes) runnerArgs.push("--yes");
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

// Read the manifest of the package copy this file belongs to — resolved relative to THIS
// file, so it follows the bin wherever it is installed and never picks up a cwd.
function defaultReadManifest() {
  return readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
}

// The RUNNING PACKAGE VERSION: the version declared by the manifest of the exact package
// copy executing this bin — never the consuming repo's manifest in the cwd, and never a git
// ref. The same notion `src/status/version.mts` established for the status footer, read
// again here rather than imported because that module is TypeScript and this file runs
// under bare `node`, before tsx is in play. The normalisation is likewise a hand copy of
// `packageVersion` in `src/status/frame.mts` (non-string → null, trim, empty → null); the
// bin test imports that function and asserts the two agree on the real manifest, so the
// copy cannot drift into reporting a different version than the footer does.
//
// Every failure is unknown rather than fatal — missing file, unreadable bytes, unparseable
// JSON, no usable version in it — matching the footer's treatment of a damaged manifest as
// a reporting failure. The caller decides what to do with the null.
//
// `readManifest` is injectable the way `resolveEntry` takes `exists`, but only the READ is:
// WHICH manifest is read stays sealed in the default, because reading the running copy's
// own is the whole claim and a test free to redirect it would assert nothing. That half is
// covered at the executable boundary instead.
export function runningVersion(readManifest = defaultReadManifest) {
  try {
    const { version } = JSON.parse(readManifest());
    if (typeof version !== "string") return null;
    const trimmed = version.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

// Print the bare version to stdout, so `$(agent-workflows --version)` is the number itself.
// An unknown version goes to stderr with a non-zero exit instead: nothing is printed that a
// caller could mistake for a version.
function printVersion() {
  const version = runningVersion();
  if (version === null) {
    console.error("agent-workflows: version unknown");
    process.exit(1);
  }
  console.log(version);
  process.exit(0);
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
        "       agent-workflows init|sync [--enable=…] [--ref=…] [--dry-run] [--yes] (--help for the rest)\n" +
        "       agent-workflows --help for the full command list",
    );
    process.exit(2);
  }
  if (invocation.kind === "version") {
    printVersion();
    return;
  }
  if (invocation.kind === "help") {
    printUsage();
    return;
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
