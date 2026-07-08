// `implement-spec-advance` hook. Fired when a tracer-bullet PR merges into a spec
// branch (the thin caller filters `merged && base.ref ~ agent/spec-*`). Close the
// merged tracer-bullet (merging into a non-default base does NOT auto-close it),
// recompute the spec's slice set live, then dispatch the next single slice — or,
// when the last one is done, open the final spec→default PR. The orchestrator runs
// NO agent; pure `gh` over the pure `spec-graph` brain. Strictly sequential
// (ADR-0003): exactly one slice is dispatched per advance.
import { required, capture } from "../shared/process.mts";
import { addLabel, comment } from "../shared/github.mts";
import { tracerBullets, nextSlice, isComplete } from "../shared/spec-graph.mts";
import { renderProgress } from "../shared/spec-report.mts";
import { listIssues } from "../shared/spec-tracker.mts";
import { specNumberFromBranch, issueNumberFromBranch } from "../shared/spec-context.mts";

const baseRef = required("BASE_REF");
const headRef = required("HEAD_REF");

const spec = specNumberFromBranch(baseRef);
if (spec === null) {
  console.log(`Base ${baseRef} is not a spec branch — nothing to advance.`);
  process.exit(0);
}

// 1. Close the merged tracer-bullet.
const merged = issueNumberFromBranch(headRef);
if (merged !== null) {
  try {
    capture("gh", ["issue", "close", String(merged), "--comment", `Merged into \`${baseRef}\`.`]);
  } catch {
    /* already closed / a race with a re-run must not fail advance */
  }
}

// 2. Recompute the slice set live — late-added slices are picked up.
const issues = listIssues();
const bullets = tracerBullets(spec, issues);
const closed = new Set(issues.filter((i) => i.state === "CLOSED").map((i) => i.number));
if (merged !== null) closed.add(merged); // guard against issue-list lag

// 3. Dispatch the next single slice, or open the final PR when complete.
const next = nextSlice(bullets, closed);
if (next !== null) {
  addLabel("issue", String(next), "agent:implement");
} else if (isComplete(bullets, closed)) {
  openFinalPr(spec, baseRef);
}

// 4. Refresh the dashboard on the spec issue.
comment("issue", String(spec), renderProgress({ branch: baseRef, bullets, closed, dispatched: next }));

console.log(
  `spec #${spec}: closed ${merged === null ? "(none)" : `#${merged}`}; ${
    next !== null
      ? `dispatched #${next}`
      : isComplete(bullets, closed)
        ? "all slices done — opened final PR"
        : "no ready slice (deadlocked)"
  }.`,
);

// The single human-review gate: a draft PR from the spec branch to the default
// branch with `Closes #<spec>` (base IS default, so the merge auto-closes the spec).
// Idempotent — never opens a second final PR.
function openFinalPr(specNumber: number, specBranch: string): void {
  const defaultBranch = capture("gh", [
    "repo",
    "view",
    "--json",
    "defaultBranchRef",
    "-q",
    ".defaultBranchRef.name",
  ]).trim();
  const existing = capture("gh", [
    "pr",
    "list",
    "--head",
    specBranch,
    "--base",
    defaultBranch,
    "--state",
    "open",
    "--json",
    "number",
    "-q",
    ".[].number",
  ]).trim();
  if (existing) {
    console.log(`Final PR already open (#${existing}).`);
    return;
  }
  const title = capture("gh", ["issue", "view", String(specNumber), "--json", "title", "-q", ".title"]).trim();
  const body = `Automated by the implement-spec orchestrator: every tracer-bullet of spec #${specNumber} is merged into \`${specBranch}\`. This is the single human-review gate for the whole feature.\n\nCloses #${specNumber}`;
  capture("gh", [
    "pr",
    "create",
    "--draft",
    "--base",
    defaultBranch,
    "--head",
    specBranch,
    "--title",
    title,
    "--body",
    body,
  ]);
}
