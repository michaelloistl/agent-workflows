// Sequencer bridge (issue #49). The whole-verb invocation `agent-workflows
// <verb>` spawns this entrypoint under tsx. It builds the verb's plan (plan.mts),
// runs it through the executor (executor.mts), and maps the outcome to a process
// exit code the reusable workflow can act on.
//
// `runStep` re-invokes the dispatcher bin once per step — `agent-workflows <verb>
// <hook> <args…>` — so every hook still runs through the unchanged per-hook path
// (override resolution included). This is the seam the future local sequencer
// swaps out to run steps in-process against a worktree instead.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planVerb, type RunContext, type Step } from "./plan.mts";
import { runPlan } from "./executor.mts";

const verb = process.argv[2];
if (!verb) {
  console.error("sequencer: usage: run <verb>");
  process.exit(2);
}

const binPath = fileURLToPath(new URL("../../bin/agent-workflows.mjs", import.meta.url));

// No per-run inputs are needed for `explore` today; later verbs read config here.
const context: RunContext = {};
const plan = planVerb(verb, context);

function runStep(step: Step): number {
  const child = spawnSync(process.execPath, [binPath, verb, step.hook, ...step.args], {
    stdio: "inherit",
    env: { ...process.env, ...step.env },
  });
  if (child.error) {
    console.error(`sequencer: failed to run ${verb} ${step.hook}:`, child.error);
    return 1;
  }
  return child.status ?? 1;
}

const result = runPlan(plan, runStep);

switch (result.outcome) {
  case "failed":
    console.error(`sequencer: ${verb} failed at "${result.step?.hook}" (exit ${result.code}).`);
    process.exit(result.code || 1);
  case "refused":
    // A refusal is NOT a failure: the guard already posted its explanation and
    // cleared the trigger label. Exit 0 so the workflow stays green and never
    // reports `blocked`; the distinct outcome is preserved in the log.
    console.log(`sequencer: ${verb} refused at "${result.step?.hook}".`);
    process.exit(0);
  case "succeeded":
    console.log(`sequencer: ${verb} completed.`);
    process.exit(0);
}
