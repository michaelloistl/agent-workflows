// `implement-prd-advance` hook. Fired when a tracer-bullet PR merges into a PRD
// branch (the thin caller filters `merged && base.ref ~ agent/prd-*`). Close the
// merged tracer-bullet (merging into a non-default base does NOT auto-close it),
// recompute the PRD's slice set live, then dispatch the next single slice — or,
// when the last one is done, open the final PRD→default PR. The orchestrator runs
// NO agent; pure `gh` over the pure `prd-graph` brain. Strictly sequential
// (ADR-0003): exactly one slice is dispatched per advance.
import { required, capture } from "../shared/process.mts";
import { addLabel, comment } from "../shared/github.mts";
import { tracerBullets, nextSlice, isComplete } from "../shared/prd-graph.mts";
import { renderProgress } from "../shared/prd-report.mts";
import { listIssues } from "../shared/prd-tracker.mts";
import { prdNumberFromBranch, issueNumberFromBranch } from "../shared/prd-context.mts";

const baseRef = required("BASE_REF");
const headRef = required("HEAD_REF");

const prd = prdNumberFromBranch(baseRef);
if (prd === null) {
  console.log(`Base ${baseRef} is not a PRD branch — nothing to advance.`);
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
const bullets = tracerBullets(prd, issues);
const closed = new Set(issues.filter((i) => i.state === "CLOSED").map((i) => i.number));
if (merged !== null) closed.add(merged); // guard against issue-list lag

// 3. Dispatch the next single slice, or open the final PR when complete.
const next = nextSlice(bullets, closed);
if (next !== null) {
  addLabel("issue", String(next), "agent:implement");
} else if (isComplete(bullets, closed)) {
  openFinalPr(prd, baseRef);
}

// 4. Refresh the dashboard on the PRD issue.
comment("issue", String(prd), renderProgress({ branch: baseRef, bullets, closed, dispatched: next }));

console.log(
  `PRD #${prd}: closed ${merged === null ? "(none)" : `#${merged}`}; ${
    next !== null
      ? `dispatched #${next}`
      : isComplete(bullets, closed)
        ? "all slices done — opened final PR"
        : "no ready slice (deadlocked)"
  }.`,
);

// The single human-review gate: a draft PR from the PRD branch to the default
// branch with `Closes #<prd>` (base IS default, so the merge auto-closes the PRD).
// Idempotent — never opens a second final PR.
function openFinalPr(prdNumber: number, prdBranch: string): void {
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
    prdBranch,
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
  const title = capture("gh", ["issue", "view", String(prdNumber), "--json", "title", "-q", ".title"]).trim();
  const body = `Automated by the implement-prd orchestrator: every tracer-bullet of PRD #${prdNumber} is merged into \`${prdBranch}\`. This is the single human-review gate for the whole feature.\n\nCloses #${prdNumber}`;
  capture("gh", [
    "pr",
    "create",
    "--draft",
    "--base",
    defaultBranch,
    "--head",
    prdBranch,
    "--title",
    title,
    "--body",
    body,
  ]);
}
