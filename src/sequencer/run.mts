// Sequencer bridge (issue #49, extended for `implement` in #50). The whole-verb
// invocation `agent-workflows <verb> [--guards-only]` spawns this entrypoint
// under tsx. It builds the verb's plan (plan.mts), runs it through the executor
// (executor.mts), and maps the outcome to a process exit code the reusable
// workflow can act on.
//
// A hook step re-invokes the dispatcher bin — `agent-workflows <verb> <hook>
// <args…>` — so every hook still runs through the unchanged per-hook path
// (override resolution included). A shell step (branch creation, the fresh-DB
// boot check, the push) runs the command GitHub Actions used to run inline. This
// is the seam the future local sequencer swaps out to run steps in-process
// against a worktree instead.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planVerb, type RunContext, type Step } from "./plan.mts";
import { runPlan } from "./executor.mts";
import { resolveConfig, effectiveBase } from "../shared/config.mts";

const verb = process.argv[2];
if (!verb) {
  console.error("sequencer: usage: run <verb> [--guards-only]");
  process.exit(2);
}

const guardsOnly = process.argv.includes("--guards-only");

const binPath = fileURLToPath(new URL("../../bin/agent-workflows.mjs", import.meta.url));
// A private file for a hook step's `$GITHUB_OUTPUT`, so fetch-spec's `branch`
// and `base` can be read back and threaded into later steps — the sequencer's
// stand-in for the Actions step-outputs the collapsed YAML used to pass around.
const outFile = join(tmpdir(), `agent-workflows-seq-${process.pid}.out`);

const context: RunContext = {
  guardsOnly,
  enableRuby: process.env.ENABLE_RUBY === "true",
  // Base branch the produced branch/PR falls back to: per-run override → config
  // file → repository default (issue #53). Absent a config file this is just
  // DEFAULT_BRANCH, so behaviour is unchanged.
  baseBranch: resolveConfig().baseBranch,
  // Which orchestrator entry point to sequence — `implement-spec` reads this;
  // every other verb ignores it (issue #52).
  specMode: process.env.SPEC_MODE,
};
const plan = planVerb(verb, context);

// Outputs accumulated across hook steps (fetch-spec emits `branch`/`base`).
const outputs: Record<string, string> = {};

// Ambient env for a step, with fetch-spec's outputs threaded in as the `BRANCH`
// and `BASE` the git steps and finalize read. `BASE` falls back to the resolved
// base branch (per-run override → config file → repository default, issue #53)
// when the issue is not a spec tracer-bullet.
function envForStep(step: Step): NodeJS.ProcessEnv {
  const threaded: Record<string, string> = {};
  if (outputs.branch !== undefined) {
    threaded.BRANCH = outputs.branch;
    // A spec tracer-bullet's own spec branch (fetch-spec's `base`) overrides the
    // configured base; a standalone issue falls back to it (issue #53).
    threaded.BASE = effectiveBase(outputs.base, context.baseBranch || "");
  }
  return { ...process.env, ...threaded, ...step.env };
}

// Which directory a step runs in. A `"tooling"` step (a PR verb's tracker hook)
// runs in the detached default-branch worktree at $TOOLING_DIR, so it uses the
// CURRENT packaged logic even when the PR head predates the tooling — mirroring
// the collapsed YAML's `yarn --cwd "$TOOLING_DIR" …`. Everything else (the issue
// verbs' single checkout, and the PR verbs' `"work"` run/push) inherits the
// bridge's cwd, which the workflow launched from the PR head. When TOOLING_DIR is
// unset (the light guard job runs guards from a plain default-branch checkout),
// even a `"tooling"` step falls back to the ambient cwd.
function cwdForStep(step: Step): string | undefined {
  if (step.cwd === "tooling" && process.env.TOOLING_DIR) {
    return process.env.TOOLING_DIR;
  }
  return undefined;
}

function captureOutputs(): void {
  let text: string;
  try {
    text = readFileSync(outFile, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq !== -1) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
}

function runStep(step: Step): number {
  const env = envForStep(step);
  const cwd = cwdForStep(step);

  if (step.kind === "shell") {
    // Match GitHub Actions' default bash flags (`-e -o pipefail`) so a failing
    // command in a multi-line step stops it, exactly as the YAML step did.
    const child = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
      stdio: "inherit",
      env,
      cwd,
    });
    if (child.error) {
      console.error(`sequencer: failed to run ${verb} ${step.name}:`, child.error);
      return 1;
    }
    return child.status ?? 1;
  }

  writeFileSync(outFile, "");
  const child = spawnSync(process.execPath, [binPath, verb, step.hook, ...step.args], {
    stdio: "inherit",
    env: { ...env, GITHUB_OUTPUT: outFile },
    cwd,
  });
  if (child.error) {
    console.error(`sequencer: failed to run ${verb} ${step.hook}:`, child.error);
    return 1;
  }
  const code = child.status ?? 1;
  if (code === 0) captureOutputs();
  return code;
}

function label(step: Step | undefined): string {
  if (!step) return "?";
  return step.kind === "hook" ? step.hook : step.name;
}

const result = runPlan(plan, runStep);

// Guards-only mode is the light guard job's cheap preflight: propagate the exit
// code faithfully (a refusal is non-zero) so the workflow skips the heavy job on
// a refusal — unlike the full path below, which swallows a refusal to 0.
if (guardsOnly) {
  if (result.outcome === "refused") {
    console.log(`sequencer: ${verb} guards refused at "${label(result.step)}".`);
  }
  process.exit(result.code);
}

switch (result.outcome) {
  case "failed":
    console.error(`sequencer: ${verb} failed at "${label(result.step)}" (exit ${result.code}).`);
    process.exit(result.code || 1);
  case "refused":
    // A refusal is NOT a failure: the guard already posted its explanation and
    // cleared the trigger label. Exit 0 so the workflow stays green and never
    // reports `blocked`; the distinct outcome is preserved in the log.
    console.log(`sequencer: ${verb} refused at "${label(result.step)}".`);
    process.exit(0);
  case "succeeded":
    console.log(`sequencer: ${verb} completed.`);
    process.exit(0);
}
