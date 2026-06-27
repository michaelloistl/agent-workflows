import { run } from "@ai-hero/sandcastle";
import {
  claudeAgent,
  hostSandbox,
  HEAD_STRATEGY,
  COMPLETION_SIGNAL,
} from "../shared/agent.mts";
import { required } from "../shared/process.mts";

// Thin agent-invocation entrypoint for the `agent:implement` GitHub Actions
// workflow (see .github/workflows/agent-implement.yml). All GitHub orchestration
// — guard checks, branch creation, label transitions, push, PR, comments — lives
// in the workflow YAML via `gh`. This file does ONE thing: run the agent on a
// single issue and signal, via exit code, whether it produced any commits.
//
// It runs directly on the ephemeral runner (noSandbox) — the runner itself is
// the isolation boundary that a local Docker sandbox would have provided. The
// workflow has already prepared the environment (Ruby/Node/deps, Postgres +
// Redis services, RAILS_ENV/DATABASE_URL/REDIS_URL, ~/.claude/settings.json) and
// checked out the target branch as HEAD; the agent commits onto it and the
// workflow pushes it afterward.
//
// Branch strategy MUST be "head". With noSandbox, any other strategy makes
// sandcastle run the agent in a separate git worktree under .sandcastle/, where
// the repo root's `node_modules` would be absent — breaking the agent's
// feedback loop (which depends on `yarn install`-ed packages).

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
// Written by the `implement-fetch-spec` hook; the prompt inlines it.
const SPEC_FILE = required("SPEC_FILE");

const result = await run({
  name: `issue-${ISSUE_NUMBER}`,
  agent: claudeAgent(),
  sandbox: hostSandbox(),
  promptFile: "./.sandcastle/agent-workflows/implement/prompt.md",
  maxIterations: 3,
  completionSignal: COMPLETION_SIGNAL,
  branchStrategy: HEAD_STRATEGY,
  // Stream the agent's output to the Actions step log (default is a file under
  // .sandcastle/logs/, which vanishes on the ephemeral runner).
  logging: { type: "stdout" },
  promptArgs: {
    ISSUE_NUMBER,
    ISSUE_TITLE,
    SPEC_FILE,
  },
});

// No commits → the agent did not implement anything. Exit non-zero so the
// workflow's failure path marks the issue `agent:blocked` rather than pushing an
// empty branch and opening an empty PR.
if (!result.commits || result.commits.length === 0) {
  console.error(`No commits produced for issue #${ISSUE_NUMBER}.`);
  process.exit(1);
}

console.log(
  `Issue #${ISSUE_NUMBER}: ${result.commits.length} commit(s) on ${result.branch}.`,
);
