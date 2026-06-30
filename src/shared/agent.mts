import { claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// Claude-agent factory shared by the agent-workflow entrypoints. One place to
// pin the model and the runner shape so the whole fleet moves together.

// Model every agent workflow runs on. Standardized by default so the whole
// fleet moves together on a package version bump; a consumer that needs a
// different model sets the optional `agent-model` input on the reusable
// workflow, which passes it through as AGENT_MODEL (issue #31).
export const AGENT_MODEL = process.env.AGENT_MODEL || "claude-opus-4-8";

// Completion signal the prompts emit to stop an iteration loop early. Matches
// the `<promise>COMPLETE</promise>` the prompt files end with.
export const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

// Branch strategy MUST be "head" under noSandbox: the agent runs in-place in the
// repo root where `node_modules`/gems are installed, rather than a fresh
// worktree that would lack them. See docs/adr/0001-sandcastle-agent-workflows.md.
export const HEAD_STRATEGY = { type: "head" } as const;

// The configured Claude agent provider.
export function claudeAgent() {
  return claudeCode(AGENT_MODEL);
}

// The no-sandbox provider: run the agent directly on the ephemeral CI runner,
// which is itself the isolation boundary.
export function hostSandbox() {
  return noSandbox();
}
