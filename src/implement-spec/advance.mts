// `implement-spec-advance` hook. Fired when a tracer-bullet PR merges into a spec
// branch (the thin caller filters `merged && base.ref ~ agent/spec-*`). Close the
// merged tracer-bullet (merging into a non-default base does NOT auto-close it),
// recompute the spec's slice set live, then dispatch the next single slice — or,
// when the last one is done, open the final spec→default PR. The orchestrator runs
// NO agent; pure `gh` over the pure `spec-graph` brain. Strictly sequential
// (ADR-0003): exactly one slice is dispatched per advance.
import { required } from "../shared/process.mts";
import { addLabel, comment } from "../shared/github.mts";
import { tracerBullets } from "../shared/spec-graph.mts";
import { specStep } from "../shared/spec-step.mts";
import { renderProgress } from "../shared/spec-report.mts";
import { listIssues } from "../shared/spec-tracker.mts";
import { specNumberFromBranch, issueNumberFromBranch } from "../shared/spec-context.mts";
import { awaitChecks } from "../shared/poll-checks.mts";
import {
  closeTracerBullet,
  openFinalPr,
  fetchSpecChecks,
  specBranchHaltMessage,
} from "../shared/spec-advance.mts";

const baseRef = required("BASE_REF");
const headRef = required("HEAD_REF");

const spec = specNumberFromBranch(baseRef);
if (spec === null) {
  console.log(`Base ${baseRef} is not a spec branch — nothing to advance.`);
  process.exit(0);
}

// 1. Close the merged tracer-bullet.
const merged = issueNumberFromBranch(headRef);
if (merged !== null) closeTracerBullet(merged, baseRef);

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
  comment("issue", String(spec), specBranchHaltMessage(baseRef, action.blocked));
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

// 5. Refresh the progress comment on the spec issue.
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
