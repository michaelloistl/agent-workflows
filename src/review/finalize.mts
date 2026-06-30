// `review-pr-finalize` hook. Post the review ($REVIEW_FILE, a GitHub reviews-API
// payload written by the agent run). Post inline + summary when there are inline
// comments; fall back to a summary-only review if the API rejects an inline line
// (e.g. a line outside the diff), so the summary still lands.
import { readFileSync } from "node:fs";
import { required, capture } from "../shared/process.mts";

const repo = required("GH_REPO");
const number = required("PR_NUMBER");
const reviewFile = required("REVIEW_FILE");

const payload = JSON.parse(readFileSync(reviewFile, "utf8")) as {
  body: string;
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
