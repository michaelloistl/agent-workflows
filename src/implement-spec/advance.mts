// `implement-spec-advance` hook. Fired when a tracer-bullet PR merges into a spec
// branch (the thin caller filters `merged && base.ref ~ agent/spec-*`). Close the
// merged tracer-bullet (merging into a non-default base does NOT auto-close it),
// recompute the spec's slice set live, then dispatch the next single slice — or,
// when the last one is done, open the final spec→default PR. The orchestrator runs
// NO agent; pure `gh` over the pure `spec-graph` brain. Strictly sequential
// (ADR-0003): exactly one slice is dispatched per advance.
import { required, capture } from "../shared/process.mts";
import { addLabel, comment } from "../shared/github.mts";
import { tracerBullets } from "../shared/spec-graph.mts";
import { specStep } from "../shared/spec-step.mts";
import { renderProgress } from "../shared/spec-report.mts";
import { listIssues } from "../shared/spec-tracker.mts";
import { specNumberFromBranch, issueNumberFromBranch } from "../shared/spec-context.mts";
import { parseCommitCheckRuns, type CheckRun } from "../shared/checks.mts";
import { awaitChecks } from "../shared/poll-checks.mts";
import { resolveConfig } from "../shared/config.mts";

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

// 3. Ask the step function what happens next. When it wants the next slice it
// first tells us to `await-checks`: gate on the spec branch's OWN CI before
// begetting the next tracer (issue #44, fix 2). The tracer just merged into
// `baseRef`; a red tip must not spawn the next slice stacked on top of the
// breakage. Belt-and-braces behind fix 1's per-PR gate: this catches consuming-repo
// checks that only run on push to the spec branch (full suite, rubocop, …) and
// breakage that predates fix 1. We re-invoke the step with the verdict, which then
// resolves to `run-slice` (green) or `halt` (red).
let action = specStep({ phase: "advance", bullets, closed });
if (action.type === "await-checks") {
  const passed = await awaitChecks(() => fetchSpecChecks(baseRef));
  action = specStep({ phase: "advance", bullets, closed, checksPassed: passed });
}

// 4. Dispatch the resolved action. On `halt` (a red spec branch) we do NOT
// dispatch — comment on the spec issue and exit non-zero so a human decides (fix
// the branch or roll back the last merge). `run-slice` labels the next tracer;
// `open-final-pr` opens the spec→base PR; `done` is a no-op (deadlock, surfaced by
// the progress comment below).
if (action.type === "halt") {
  comment("issue", String(spec), haltMessage(baseRef, action.blocked));
  console.error(
    `spec #${spec}: spec-branch \`${baseRef}\` CI did not pass — halting; #${action.blocked} NOT dispatched.`,
  );
  process.exit(1);
}
const next = action.type === "run-slice" ? action.slice : null;
if (action.type === "run-slice") {
  addLabel("issue", String(action.slice), "agent:implement");
} else if (action.type === "open-final-pr") {
  openFinalPr(spec, baseRef);
}

// 5. Refresh the dashboard on the spec issue.
comment("issue", String(spec), renderProgress({ branch: baseRef, bullets, closed, dispatched: next }));

console.log(
  `spec #${spec}: closed ${merged === null ? "(none)" : `#${merged}`}; ${
    action.type === "run-slice"
      ? `dispatched #${action.slice}`
      : action.type === "open-final-pr"
        ? "all slices done — opened final PR"
        : "no ready slice (deadlocked)"
  }.`,
);

// The single human-review gate: a draft PR from the spec branch to the configured
// base branch with `Closes #<spec>` (base IS where the spec lands, so the merge
// auto-closes the spec). The base is the configured base branch (issue #53),
// falling back to the repository default when no config file sets one — matching
// where kickoff cut the spec branch from. Idempotent — never opens a second final PR.
function openFinalPr(specNumber: number, specBranch: string): void {
  const base = resolveConfig().baseBranch || capture("gh", [
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
    base,
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
    base,
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

// The advance gate always halts with the slice it declined to dispatch, so
// `blocked` is a number on this path (the `number | null` is the shared action
// shape — the slice-merge gate, wired later, carries no next-slice).
function haltMessage(branch: string, blocked: number | null): string {
  const runUrl = process.env.RUN_URL;
  const tail = runUrl ? `\n\nSee the run: ${runUrl}` : "";
  return (
    `⛔ CI on the spec branch \`${branch}\` did not pass at its tip after the last ` +
    `tracer-bullet merged (a check failed, or none went green before the timeout), ` +
    `so the next slice (#${blocked}) was **not** dispatched. Fix the spec branch — ` +
    `or roll back the last merge — then re-run to continue.${tail}`
  );
}
