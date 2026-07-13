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
import { parseCommitCheckRuns, type CheckRun } from "../shared/checks.mts";
import { awaitChecks } from "../shared/poll-checks.mts";

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
  // Gate on the spec branch's OWN CI before begetting the next tracer (issue #44,
  // fix 2). The tracer just merged into `baseRef`; a red tip must not spawn the
  // next slice stacked on top of the breakage. Belt-and-braces behind fix 1's
  // per-PR gate: this catches consuming-repo checks that only run on push to the
  // spec branch (full suite, rubocop, …) and breakage that predates fix 1. If CI
  // is red (or never goes green in time) we do NOT dispatch — halt with a comment
  // on the spec issue and exit non-zero so a human decides (fix the branch or roll
  // back the last merge).
  const passed = await awaitChecks(() => fetchSpecChecks(baseRef));
  if (!passed) {
    comment("issue", String(spec), haltMessage(baseRef, next));
    console.error(
      `spec #${spec}: spec-branch \`${baseRef}\` CI did not pass — halting; #${next} NOT dispatched.`,
    );
    process.exit(1);
  }
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

// Read the check-runs on the spec branch's tip. The branch has no open PR (the
// final PR opens only once every slice is done), so `gh pr checks` doesn't apply —
// resolve the branch to its tip SHA, then read that commit's check-runs over the
// REST API. Two calls because a branch name can contain slashes (`agent/spec-…`):
// `git/ref/heads/<branch>` takes the full multi-segment ref, but the SHA it
// returns is the slash-free key `commits/{ref}/check-runs` needs. Tolerant of a gh
// error the same way finalize tolerates `gh pr checks`: an empty parse → verdict
// "none", which the poll loop's grace window resolves rather than hanging.
function fetchSpecChecks(branch: string): CheckRun[] {
  try {
    const sha = capture("gh", [
      "api",
      `repos/{owner}/{repo}/git/ref/heads/${branch}`,
      "--jq",
      ".object.sha",
    ]).trim();
    if (!sha) return [];
    return parseCommitCheckRuns(
      capture("gh", ["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`]),
    );
  } catch (err) {
    return parseCommitCheckRuns((err as { stdout?: string }).stdout ?? "");
  }
}

function haltMessage(branch: string, blocked: number): string {
  const runUrl = process.env.RUN_URL;
  const tail = runUrl ? `\n\nSee the run: ${runUrl}` : "";
  return (
    `⛔ CI on the spec branch \`${branch}\` did not pass at its tip after the last ` +
    `tracer-bullet merged (a check failed, or none went green before the timeout), ` +
    `so the next slice (#${blocked}) was **not** dispatched. Fix the spec branch — ` +
    `or roll back the last merge — then re-run to continue.${tail}`
  );
}
