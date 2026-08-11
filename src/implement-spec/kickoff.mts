// `implement-spec-kickoff` hook. Fired by labelling a spec issue `agent:implement-spec`
// (after guards pass). Cut the spec branch off the default branch, dispatch the
// topologically-first tracer-bullet, post the progress dashboard, and retire the
// trigger label. The orchestrator runs NO agent — pure `gh`/`git` over the pure
// `spec-graph` brain.
import { required, capture } from "../shared/process.mts";
import { addLabel, removeLabel, comment } from "../shared/github.mts";
import { tracerBullets } from "../shared/spec-graph.mts";
import { specStep } from "../shared/spec-step.mts";
import { renderProgress } from "../shared/spec-report.mts";
import { listIssues } from "../shared/spec-tracker.mts";
import { resolveConfig } from "../shared/config.mts";
import { slugify } from "../shared/text.mts";

const TRIGGER = "agent:implement-spec";
const number = required("ISSUE_NUMBER");
const title = required("ISSUE_TITLE");
const spec = Number(number);

// 1. Cut + push the spec branch off the configured base branch (issue #53) — the
// default branch when no config file sets one, matching the checked-out HEAD. No
// commit, so no identity needed; it just gives the tracer-bullets a base to stack
// on. Naming parallels the tracer-bullet branch and is a parsed contract.
const branch = `agent/spec-${spec}-${slugify(title)}`;
const base = resolveConfig().baseBranch;
if (base) {
  capture("git", ["fetch", "origin", base]);
  capture("git", ["checkout", "-B", branch, `origin/${base}`]);
} else {
  capture("git", ["checkout", "-B", branch]);
}
capture("git", ["push", "-u", "origin", branch]);

// 2. Discover + order the tracer-bullets, and which are already closed.
const issues = listIssues();
const bullets = tracerBullets(spec, issues);
const closed = new Set(
  issues.filter((i) => i.state === "CLOSED").map((i) => i.number),
);

// 3. Ask the step function what happens next, then dispatch it. At kickoff that is
// either `run-slice` (label the topologically-first ready slice) or `done` (nothing
// ready). Labelling `agent:implement` triggers the implement verb, whose fetch-spec
// derives its base as this spec branch (#5).
const action = specStep({ phase: "kickoff", bullets, closed });
const next = action.type === "run-slice" ? action.slice : null;
if (next !== null) addLabel("issue", String(next), "agent:implement");

// 4. Post the progress dashboard on the spec issue and retire the trigger label.
comment("issue", number, renderProgress({ branch, bullets, closed, dispatched: next }));
removeLabel("issue", number, TRIGGER);

console.log(
  `spec #${spec}: created ${branch}; ${bullets.length} tracer-bullet(s); dispatched ${
    next === null ? "none" : `#${next}`
  }.`,
);
