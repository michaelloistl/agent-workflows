// `implement-spec-guards` hook. Preflight for BOTH orchestrator entry points, behind
// the contract like every other guard. A refusal exits non-zero so the central
// workflow skips the run (NOT a failure — never `agent:blocked`); on kickoff it also
// retires `agent:implement-spec` and comments why.
//
// KICKOFF (`SPEC_MODE=kickoff`, the spec issue was labelled). spec identity is
// detected STRUCTURALLY, not by title/label: `/to-spec` does not prefix the title
// with `spec:` or add a `spec` label, so neither is reliable. A spec is an issue that
// (1) is not itself a tracer-bullet (has no `## Parent`) and (2) has tracer-bullets
// pointing at it. Plus the idempotency check (already kicked off).
//
// ADVANCE (`SPEC_MODE=advance`, a tracer-bullet PR merged into a spec branch). This
// entry point long had no guard at all — it reacts to a merge, and a merge was
// assumed to be CI's own. The attended slice loop breaks that assumption: it merges
// each slice PR into the spec branch too, so every local merge fires CI advance,
// which then labels the NEXT tracer-bullet `agent:implement` and starts building a
// slice the loop is about to build itself. The local-run marker on the spec issue is
// what settles the ownership, and this guard is where advance reads it
// (`spec-marker.mts` holds the decision).
import { required, capture } from "../shared/process.mts";
import { refuse } from "../shared/github.mts";
import { tracerBullets, parentRef } from "../shared/spec-graph.mts";
import { pickSpecBranch, specNumberFromBranch } from "../shared/spec-context.mts";
import { listIssues, remoteBranches, issueLabels } from "../shared/spec-tracker.mts";
import { advanceStandDown, markerPresent } from "../shared/spec-marker.mts";

function gh(args: ReadonlyArray<string>): string {
  return capture("gh", args);
}

// The advance guard. It derives the spec from the merged PR's base branch — advance
// has no ISSUE_NUMBER, only BASE_REF/HEAD_REF — and refuses when the spec is claimed
// by an attended local run. NOTHING is written to the tracker on this path: there is
// no trigger label to retire (the trigger was a merge event), and a comment on every
// local slice merge would spam a spec issue the local loop is already narrating with
// its own progress comments. The refusal reason goes to the job log. An unreadable
// label list throws, which the guard job reads as a refusal — failing CLOSED on
// purpose: a skipped advance is recoverable by re-running, whereas dispatching over
// a live local run duplicates the slice.
if ((process.env.SPEC_MODE ?? "kickoff") === "advance") {
  // A missing/foreign BASE_REF is NOT refused here: this guard's only question is
  // ownership, and there is no owner to read without a spec. advance itself requires
  // BASE_REF and fails loudly on its absence — one place, not two.
  const baseRef = process.env.BASE_REF ?? "";
  const advanceSpec = specNumberFromBranch(baseRef);
  const labels = advanceSpec === null ? [] : issueLabels(advanceSpec);
  const standDown = advanceStandDown({
    spec: advanceSpec,
    marker: markerPresent(labels),
  });
  if (standDown) {
    console.error(standDown);
    process.exit(1);
  }
  process.exit(0);
}

const TRIGGER = "agent:implement-spec";
const number = required("ISSUE_NUMBER");
const spec = Number(number);

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
