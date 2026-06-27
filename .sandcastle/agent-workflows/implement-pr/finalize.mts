// `implement-pr-finalize` hook. After the workflow pushes, reply to each
// addressed review comment as a threaded reply and post the summary. Reads
// $REPLIES_FILE ({ summary, replies: [{ commentId, body }] }) from the agent run.
import { readFileSync } from "node:fs";
import { required, capture } from "../shared/process.mts";
import { isPrdBranch } from "../shared/prd-context.mts";

const repo = required("GH_REPO");
const number = required("PR_NUMBER");
const repliesFile = required("REPLIES_FILE");

const out = JSON.parse(readFileSync(repliesFile, "utf8")) as {
  summary: string;
  replies: ReadonlyArray<{ commentId: number; body: string }>;
};

for (const reply of out.replies ?? []) {
  try {
    capture("gh", [
      "api",
      "--method",
      "POST",
      `repos/${repo}/pulls/${number}/comments/${reply.commentId}/replies`,
      "-f",
      `body=${reply.body}`,
    ]);
  } catch {
    /* a reply to a since-deleted comment must not fail the run */
  }
}
capture("gh", ["pr", "comment", number, "--body", out.summary]);
console.log(`PR #${number}: posted ${out.replies?.length ?? 0} repl(ies) + summary.`);

// Slice review loop (#7): under a PRD, this is the last step before the slice
// lands — the review has been addressed, so merge into the PRD branch (which fires
// advance). Strictly sequential, so the merge is always clean.
const baseRef = process.env.BASE_REF ?? "";
if (isPrdBranch(baseRef)) {
  capture("gh", ["pr", "merge", number, "--merge", "--delete-branch"]);
  console.log(`PR #${number}: review addressed under a PRD — merged into ${baseRef}.`);
}
