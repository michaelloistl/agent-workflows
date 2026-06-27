import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { required } from "../shared/process.mts";
import { gatherPrContext, writePrContextFiles } from "../shared/pr-context.mts";
import { reviewOutputSchema, reviewPayload } from "../shared/review-output.mts";
import { runWithExtraction } from "../shared/run-with-extraction.mts";

// Thin agent-invocation entrypoint for the `agent:review-pr` GitHub Actions
// workflow (see .github/workflows/agent-review-pr.yml). All GitHub orchestration
// — label transitions, the closed-PR refusal, posting the review — lives in the
// workflow YAML via `gh`. This file does ONE thing: gather the PR's context,
// review it read-only, and write the structured review the workflow posts.
//
// It runs directly on the ephemeral runner (noSandbox) with branch strategy
// "head" — strictly read-only: the prompts never edit or commit, and the
// workflow never pushes. PR-context gathering and the review-output schema/
// filters live in ../shared/; this just wires them to the run-with-extraction
// pattern.

const PR_NUMBER = required("PR_NUMBER");
const PR_TITLE = required("PR_TITLE");
const GH_REPO = required("GH_REPO");
const REVIEW_FILE = required("REVIEW_FILE");

// Gather the PR's title, linked issue, diff, and existing comments, and write
// them to files the prompt inlines.
const context = gatherPrContext(Number(PR_NUMBER), GH_REPO);
const files = writePrContextFiles(context, tmpdir());

// Scratch file the work pass writes its review to and the extraction pass reads
// back. Owned here so the workflow only has to know about REVIEW_FILE.
const NOTES_FILE = join(tmpdir(), `review-${PR_NUMBER}-notes.md`);

const promptArgs = {
  PR_NUMBER,
  PR_TITLE,
  BASE_REF: context.baseRef,
  DIFF_FILE: files.diffFile,
  COMMENTS_FILE: files.commentsFile,
  LINKED_ISSUE_FILE: files.linkedIssueFile,
  NOTES_FILE,
};

const { output, commits } = await runWithExtraction({
  name: `review-${PR_NUMBER}`,
  // Resolve prompt files relative to THIS script, not the process cwd: the PR
  // workflow runs this entrypoint from a separate `main` tooling checkout (so a
  // stale PR branch missing the tooling can still run it) while cwd stays the
  // PR working tree being reviewed.
  workPromptFile: join(import.meta.dirname, "prompt.md"),
  extractPromptFile: join(import.meta.dirname, "extract.md"),
  promptArgs,
  tag: "review",
  schema: reviewOutputSchema,
});

// Review is read-only: a commit means a prompt misbehaved. Fail rather than let
// the workflow proceed as if nothing happened.
if (commits.length > 0) {
  console.error(
    `Review is read-only but produced ${commits.length} commit(s); refusing to continue.`,
  );
  process.exit(1);
}

// Hand the review to the workflow, which posts it on the PR via `gh`.
const payload = reviewPayload(output);
writeFileSync(REVIEW_FILE, JSON.stringify(payload, null, 2));
console.log(
  `PR #${PR_NUMBER}: wrote summary + ${payload.comments.length} inline comment(s) to ${REVIEW_FILE}.`,
);
