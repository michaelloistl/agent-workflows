// `review-pr-finalize` hook. Post the review ($REVIEW_FILE, a GitHub reviews-API
// payload written by the agent run). Post inline + summary when there are inline
// comments; fall back to a summary-only review if the API rejects an inline line
// (e.g. a line outside the diff), so the summary still lands.
import { readFileSync } from "node:fs";
import { required, capture } from "../shared/process.mts";
import { addLabel } from "../shared/github.mts";
import { isPrdBranch } from "../shared/prd-context.mts";

const repo = required("GH_REPO");
const number = required("PR_NUMBER");
const reviewFile = required("REVIEW_FILE");

const payload = JSON.parse(readFileSync(reviewFile, "utf8")) as {
  body: string;
  event?: string;
  comments?: unknown[];
};
const endpoint = `repos/${repo}/pulls/${number}/reviews`;

function summaryOnly(): void {
  capture("gh", ["api", "--method", "POST", endpoint, "-f", "event=COMMENT", "-f", `body=${payload.body}`]);
}

if ((payload.comments?.length ?? 0) > 0) {
  try {
    capture("gh", ["api", "--method", "POST", endpoint, "--input", reviewFile]);
  } catch {
    summaryOnly();
  }
} else {
  summaryOnly();
}
console.log(`PR #${number}: posted review.`);

// Slice review loop (#7): when this PR targets a PRD branch, the review IS the
// gate. A clean review (no actionable comments, not REQUEST_CHANGES) merges the
// slice into the PRD branch — which fires advance. Otherwise hand the PR to
// `implement-pr` (triggered by `agent:implement` on a PR) to address the review,
// and it merges afterwards. Strictly sequential, so the merge is always clean.
const baseRef = process.env.BASE_REF ?? "";
if (isPrdBranch(baseRef)) {
  const clean = (payload.comments?.length ?? 0) === 0 && payload.event !== "REQUEST_CHANGES";
  if (clean) {
    capture("gh", ["pr", "merge", number, "--merge", "--delete-branch"]);
    console.log(`PR #${number}: clean review under a PRD — merged into ${baseRef}.`);
  } else {
    addLabel("pr", number, "agent:implement");
    console.log(`PR #${number}: review requested changes — applied agent:implement.`);
  }
}
