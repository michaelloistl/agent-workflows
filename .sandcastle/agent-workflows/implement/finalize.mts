// `implement-finalize` hook. Open the PR for the pushed `agent/…` branch with the
// tracker cross-reference (`Closes #N`) and apply the terminal label. PR *creation*
// is a hook (not the central workflow) because the cross-ref and base are
// tracker-aware (ADR-0001, Decision 7).
//
// Two shapes, keyed on whether the base is a PRD branch (the stacked topology):
//   standalone → DRAFT PR to the default branch + `agent:review` (human gate).
//   under PRD  → READY PR to the PRD branch + `agent:review-pr` — handing the slice
//                to the autonomous review loop (#7); no human gate per slice, the
//                in-progress label is cleared (`done`).
import { required, capture } from "../shared/process.mts";
import { addLabel, setState } from "../shared/github.mts";
import { isPrdBranch } from "../shared/prd-context.mts";

const number = required("ISSUE_NUMBER");
const title = required("ISSUE_TITLE");
const branch = required("BRANCH");
const base = process.env.BASE ?? "";
const underPrd = isPrdBranch(base);

const body = `Automated by the agent-implement workflow for #${number}.\n\nCloses #${number}`;
const args = ["pr", "create", "--head", branch, "--title", title, "--body", body];
if (base) args.push("--base", base);
if (!underPrd) args.push("--draft");
const url = capture("gh", args).trim();

if (underPrd) {
  // Hand off to the slice review loop: the agent reviews its own PR. The base ref
  // matches `agent/prd-*`, so review-pr's finalize knows it's inside a PRD.
  const pr = url.match(/\/pull\/(\d+)/)?.[1];
  if (pr) addLabel("pr", pr, "agent:review-pr");
  // No human gate under a PRD — clear in-progress, leave no review state on the issue.
  setState("issue", number, "done");
} else {
  // Standalone: a draft PR awaiting human review.
  setState("issue", number, "review");
}

console.log(
  `Issue #${number}: opened ${underPrd ? "ready" : "draft"} PR from ${branch} → ${
    base || "(default)"
  }${underPrd ? "; applied agent:review-pr" : ""}.`,
);
