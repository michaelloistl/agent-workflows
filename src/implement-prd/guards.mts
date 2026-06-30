// `implement-prd-guards` hook. Preflight for the orchestrator kickoff, behind the
// contract like every other guard. A refusal retires `agent:implement-prd`,
// comments why, and exits non-zero so the central workflow skips the run (NOT a
// failure — never `agent:blocked`).
//
// PRD identity is detected STRUCTURALLY, not by title/label: `/to-prd` does not
// prefix the title with `PRD:` or add a `prd` label, so neither is reliable. A PRD
// is an issue that (1) is not itself a tracer-bullet (has no `## Parent`) and (2)
// has tracer-bullets pointing at it. Plus the idempotency check (already kicked off).
import { required, capture } from "../shared/process.mts";
import { refuse } from "../shared/github.mts";
import { tracerBullets, parentRef } from "../shared/prd-graph.mts";
import { pickPrdBranch } from "../shared/prd-context.mts";
import { listIssues, remoteBranches } from "../shared/prd-tracker.mts";

const TRIGGER = "agent:implement-prd";
const number = required("ISSUE_NUMBER");
const prd = Number(number);

function gh(args: ReadonlyArray<string>): string {
  return capture("gh", args);
}

// Tracer-bullet guard — refuse if this issue has its own `## Parent` (it's a slice,
// not a PRD; run the orchestrator on its parent instead).
const body = gh(["issue", "view", number, "--json", "body", "-q", ".body"]);
if (parentRef(body) !== null) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: #${number} is itself a tracer-bullet (it has a \`## Parent\` reference), not a PRD. Run the orchestrator on its parent PRD instead. Removed the label without running.`,
  );
}

// Already-kicked-off guard — a live PRD branch means this PRD is in progress;
// re-labelling must be a no-op so a double-label can't spawn duplicate work.
const existing = pickPrdBranch(prd, remoteBranches());
if (existing) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: PRD branch \`${existing}\` already exists, so this PRD is already being orchestrated. Removed the label without re-running.`,
  );
}

// Tracer-bullet presence guard — nothing to orchestrate, and confirms PRD-ness
// (something parents to it).
const bullets = tracerBullets(prd, listIssues());
if (bullets.length === 0) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: found no tracer-bullets referencing #${number} as their \`## Parent\`. Run \`/to-issues\` on this PRD first, then re-apply the label. Removed the label without running.`,
  );
}

// Nothing refused.
process.exit(0);
