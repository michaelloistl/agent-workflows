// `implement-prd-guards` hook. Preflight for the orchestrator kickoff, behind the
// contract like every other guard. A refusal retires `agent:implement-prd`,
// comments why, and exits non-zero so the central workflow skips the run (NOT a
// failure — never `agent:blocked`). Three checks: it must BE a PRD, it must not be
// already kicked off, and it must have tracer-bullets to orchestrate.
import { required, capture } from "../shared/process.mts";
import { refuse } from "../shared/github.mts";
import { tracerBullets } from "../shared/prd-graph.mts";
import { pickPrdBranch } from "../shared/prd-context.mts";
import { listIssues, remoteBranches } from "../shared/prd-tracker.mts";

const TRIGGER = "agent:implement-prd";
const number = required("ISSUE_NUMBER");
const prd = Number(number);

function gh(args: ReadonlyArray<string>): string {
  return capture("gh", args);
}

// PRD guard — inverse of the `implement` PRD guard: this orchestrator runs ONLY on
// a PRD (titled `PRD:` or carrying the `prd` label).
const title = gh(["issue", "view", number, "--json", "title", "-q", ".title"]).trim();
const labels = gh(["issue", "view", number, "--json", "labels", "-q", ".labels[].name"])
  .split("\n")
  .map((l) => l.trim().toLowerCase());
if (!title.toLowerCase().startsWith("prd:") && !labels.includes("prd")) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: #${number} isn't a PRD (no \`prd\` label and the title doesn't start with \`PRD:\`). This orchestrator runs on a PRD issue and builds its tracer-bullets. Removed the label without running.`,
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

// Tracer-bullet guard — nothing to orchestrate without slices parented to the PRD.
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
