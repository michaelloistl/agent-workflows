import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { required } from "../shared/process.mts";
import { gatherPrContext, writePrContextFiles } from "../shared/pr-context.mts";
import { replyOutputSchema } from "../shared/reply-output.mts";
import { runWithExtraction } from "../shared/run-with-extraction.mts";
import { resolveAsset } from "../shared/resolve-asset.mts";

// Thin agent-invocation entrypoint for the `agent:implement` PR workflow (see
// .github/workflows/agent-implement-pr.yml). All GitHub orchestration — the
// closed-PR refusal, label transitions, the push, posting the replies — lives in
// the workflow YAML via `gh`. This file does ONE thing: gather the PR's context,
// make the requested changes and commit them, and hand back the per-comment
// replies the workflow posts.
//
// It reuses the shared PR-context gathering (the same code the read-only review
// workflow uses) and the run-with-extraction pattern: an open-ended WORK pass
// reads the diff + review comments, edits the code, runs the feedback loop, and
// commits onto the checked-out PR branch, writing a notes file; a single-shot
// EXTRACTION pass turns those notes into one validated `{ summary, replies }`
// object. Unlike review (which asserts NO commits), implement-pr REQUIRES at
// least one commit — no commit means nothing was addressed.
//
// Branch strategy is "head" (via runWithExtraction) so the agent runs in-place in
// the repo root where `node_modules`/gems are installed and commits onto the PR
// branch the runner checked out; the workflow pushes it afterward.

const PR_NUMBER = required("PR_NUMBER");
const PR_TITLE = required("PR_TITLE");
const GH_REPO = required("GH_REPO");
const REPLIES_FILE = required("REPLIES_FILE");

// Gather the PR's title, linked issue, diff, and existing review comments, and
// write them to files the prompt inlines.
const context = gatherPrContext(Number(PR_NUMBER), GH_REPO);
const files = writePrContextFiles(context, tmpdir());

// Scratch file the work pass writes its summary + per-comment replies to and the
// extraction pass reads back. Owned here so the workflow only knows REPLIES_FILE.
const NOTES_FILE = join(tmpdir(), `implement-pr-${PR_NUMBER}-notes.md`);

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
  name: `implement-pr-${PR_NUMBER}`,
  // Resolve prompt files relative to THIS script, not the process cwd: the PR
  // workflow runs this entrypoint from a separate `main` tooling checkout (so a
  // stale PR branch missing the tooling can still run it) while cwd stays the
  // PR working tree the agent edits and commits.
  workPromptFile: resolveAsset(import.meta.dirname, "prompt.md"),
  extractPromptFile: resolveAsset(import.meta.dirname, "extract.md"),
  promptArgs,
  tag: "replies",
  schema: replyOutputSchema,
});

// No commits → the agent addressed nothing. Exit non-zero so the workflow's
// failure path marks the PR `agent:blocked` rather than pushing an unchanged
// branch and claiming feedback was addressed.
if (commits.length === 0) {
  console.error(
    `PR #${PR_NUMBER}: no commits produced; nothing was changed.`,
  );
  process.exit(1);
}

// Hand the summary + replies to the workflow, which pushes the branch and posts
// the replies on the PR via `gh`.
writeFileSync(REPLIES_FILE, JSON.stringify(output, null, 2));
console.log(
  `PR #${PR_NUMBER}: ${commits.length} commit(s); ${output.replies.length} repl(ies) to post.`,
);
