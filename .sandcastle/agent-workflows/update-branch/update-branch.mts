import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "@ai-hero/sandcastle";
import {
  claudeAgent,
  hostSandbox,
  HEAD_STRATEGY,
  COMPLETION_SIGNAL,
} from "../shared/agent.mts";
import { required, capture } from "../shared/process.mts";

// Thin agent-invocation entrypoint for the `agent:update-branch` GitHub Actions
// workflow (see .github/workflows/agent-update-branch.yml). All GitHub
// orchestration — the closed-PR refusal, label transitions, the push, the status
// comment — lives in the workflow YAML via `gh`. This file does ONE thing: bring
// the checked-out PR branch up to date with its base, and report — via a status
// file — which of the two outcomes happened.
//
// It reuses the shared base (the agent factory + process helpers) but NOT the
// read-only run-with-extraction pattern: updating a branch produces a merge
// commit, so it runs a single open-ended work pass like `implement`. The runner
// has checked out the PR head as HEAD, fetched the base branch, and set the git
// identity; the agent merges the base in (resolving conflicts), and the workflow
// pushes the result afterward.
//
// Branch strategy MUST be "head" under noSandbox so the agent runs in-place in
// the repo root where `node_modules`/gems are installed (see implement.mts for
// the full rationale).

// The two outcomes the workflow distinguishes via the status file: the branch was
// already current with base (no merge, no push), or the base was merged in.
const UP_TO_DATE = "up-to-date";
const MERGED = "merged";

const PR_NUMBER = required("PR_NUMBER");
const BASE_REF = required("BASE_REF");
const STATUS_FILE = required("STATUS_FILE");

// True when the base branch tip is already an ancestor of HEAD — i.e. the PR
// branch already contains base, so merging would be a no-op. `merge-base
// --is-ancestor` exits 0 when it is an ancestor and 1 when it is not; `capture`
// throws on the non-zero exit, which we read as "not current".
function branchIsCurrent(baseRef: string): boolean {
  try {
    capture("git", ["merge-base", "--is-ancestor", `origin/${baseRef}`, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

if (branchIsCurrent(BASE_REF)) {
  writeFileSync(STATUS_FILE, UP_TO_DATE);
  console.log(
    `PR #${PR_NUMBER}: already up to date with ${BASE_REF}; nothing to merge.`,
  );
  process.exit(0);
}

const result = await run({
  name: `update-branch-${PR_NUMBER}`,
  agent: claudeAgent(),
  sandbox: hostSandbox(),
  // Resolve the prompt relative to THIS script, not the process cwd: the PR
  // workflow runs this entrypoint from a separate `main` tooling checkout (so a
  // stale PR branch missing the tooling can still run it) while cwd stays the
  // PR working tree the agent merges into and commits.
  promptFile: join(import.meta.dirname, "prompt.md"),
  maxIterations: 3,
  completionSignal: COMPLETION_SIGNAL,
  branchStrategy: HEAD_STRATEGY,
  logging: { type: "stdout" },
  promptArgs: {
    PR_NUMBER,
    BASE_REF,
  },
});

// No commits → the agent failed to merge the base in. Exit non-zero so the
// workflow's failure path marks the PR `agent:blocked` rather than pushing an
// unchanged branch and claiming it was updated.
if (!result.commits || result.commits.length === 0) {
  console.error(
    `PR #${PR_NUMBER}: no merge commit produced; the branch was not updated.`,
  );
  process.exit(1);
}

writeFileSync(STATUS_FILE, MERGED);
console.log(
  `PR #${PR_NUMBER}: merged ${BASE_REF} in (${result.commits.length} commit(s)) on ${result.branch}.`,
);
