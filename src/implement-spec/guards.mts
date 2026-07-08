// `implement-spec-guards` hook. Preflight for the orchestrator kickoff, behind the
// contract like every other guard. A refusal retires `agent:implement-spec`,
// comments why, and exits non-zero so the central workflow skips the run (NOT a
// failure — never `agent:blocked`).
//
// spec identity is detected STRUCTURALLY, not by title/label: `/to-spec` does not
// prefix the title with `spec:` or add a `spec` label, so neither is reliable. A spec
// is an issue that (1) is not itself a tracer-bullet (has no `## Parent`) and (2)
// has tracer-bullets pointing at it. Plus the idempotency check (already kicked off).
import { required, capture } from "../shared/process.mts";
import { refuse } from "../shared/github.mts";
import { tracerBullets, parentRef } from "../shared/spec-graph.mts";
import { pickSpecBranch } from "../shared/spec-context.mts";
import { listIssues, remoteBranches } from "../shared/spec-tracker.mts";

const TRIGGER = "agent:implement-spec";
const number = required("ISSUE_NUMBER");
const spec = Number(number);

function gh(args: ReadonlyArray<string>): string {
  return capture("gh", args);
}

// Tracer-bullet guard — refuse if this issue has its own `## Parent` (it's a slice,
// not a spec; run the orchestrator on its parent instead).
const body = gh(["issue", "view", number, "--json", "body", "-q", ".body"]);
if (parentRef(body) !== null) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: #${number} is itself a tracer-bullet (it has a \`## Parent\` reference), not a spec. Run the orchestrator on its parent spec instead. Removed the label without running.`,
  );
}

// Already-kicked-off guard — a live spec branch means this spec is in progress;
// re-labelling must be a no-op so a double-label can't spawn duplicate work.
const existing = pickSpecBranch(spec, remoteBranches());
if (existing) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: spec branch \`${existing}\` already exists, so this spec is already being orchestrated. Removed the label without re-running.`,
  );
}

// Tracer-bullet presence guard — nothing to orchestrate, and confirms spec-ness
// (something parents to it).
const bullets = tracerBullets(spec, listIssues());
if (bullets.length === 0) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: found no tracer-bullets referencing #${number} as their \`## Parent\`. Run \`/to-tickets\` on this spec first, then re-apply the label. Removed the label without running.`,
  );
}

// Nothing refused.
process.exit(0);
