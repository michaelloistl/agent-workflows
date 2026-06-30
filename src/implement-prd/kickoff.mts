// `implement-prd-kickoff` hook. Fired by labelling a PRD issue `agent:implement-prd`
// (after guards pass). Cut the PRD branch off the default branch, dispatch the
// topologically-first tracer-bullet, post the progress dashboard, and retire the
// trigger label. The orchestrator runs NO agent — pure `gh`/`git` over the pure
// `prd-graph` brain.
import { required, capture } from "../shared/process.mts";
import { addLabel, removeLabel, comment } from "../shared/github.mts";
import { tracerBullets, nextSlice } from "../shared/prd-graph.mts";
import { renderProgress } from "../shared/prd-report.mts";
import { listIssues } from "../shared/prd-tracker.mts";
import { slugify } from "../shared/text.mts";

const TRIGGER = "agent:implement-prd";
const number = required("ISSUE_NUMBER");
const title = required("ISSUE_TITLE");
const prd = Number(number);

// 1. Cut + push the PRD branch off the default branch (the checked-out HEAD). No
// commit, so no identity needed; it just gives the tracer-bullets a base to stack
// on. Naming parallels the tracer-bullet branch and is a parsed contract.
const branch = `agent/prd-${prd}-${slugify(title)}`;
capture("git", ["checkout", "-B", branch]);
capture("git", ["push", "-u", "origin", branch]);

// 2. Discover + order the tracer-bullets, and which are already closed.
const issues = listIssues();
const bullets = tracerBullets(prd, issues);
const closed = new Set(
  issues.filter((i) => i.state === "CLOSED").map((i) => i.number),
);

// 3. Dispatch the next single slice (topologically-first ready one). Labelling it
// `agent:implement` triggers the implement verb, whose fetch-spec derives its base
// as this PRD branch (#5).
const next = nextSlice(bullets, closed);
if (next !== null) addLabel("issue", String(next), "agent:implement");

// 4. Post the progress dashboard on the PRD issue and retire the trigger label.
comment("issue", number, renderProgress({ branch, bullets, closed, dispatched: next }));
removeLabel("issue", number, TRIGGER);

console.log(
  `PRD #${prd}: created ${branch}; ${bullets.length} tracer-bullet(s); dispatched ${
    next === null ? "none" : `#${next}`
  }.`,
);
