import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { required } from "../shared/process.mts";
import { standardSchema } from "../shared/json.mts";
import { isPresent } from "../shared/text.mts";
import { runWithExtraction } from "../shared/run-with-extraction.mts";

// Thin agent-invocation entrypoint for the `agent:explore` GitHub Actions
// workflow (see .github/workflows/agent-explore.yml). All GitHub orchestration —
// label transitions, gathering the issue, posting the comment — lives in the
// workflow YAML via `gh`. This file does ONE thing: explore the issue read-only
// and produce the exploration comment for the workflow to post.
//
// It runs directly on the ephemeral runner (noSandbox) with branch strategy
// "head" — strictly read-only: the prompts never edit or commit, and the
// workflow never pushes. See ../shared/ for the agent factory, helpers, and the
// run-with-extraction pattern this is the first consumer of.

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
// Written by the `explore-fetch-spec` hook — the central workflow does no tracker
// I/O, so the spec is materialized by a hook and inlined by the prompt.
const SPEC_FILE = required("SPEC_FILE");
const COMMENT_FILE = required("COMMENT_FILE");

// Scratch file the work pass writes its exploration to and the extraction pass
// reads back. Owned here so the workflow only has to know about COMMENT_FILE.
const NOTES_FILE = join(tmpdir(), `explore-${ISSUE_NUMBER}-notes.md`);

// The structured output the extraction pass emits: a single non-empty comment.
const commentSchema = standardSchema<{ comment: string }>((value) => {
  if (typeof value !== "object" || value === null) {
    return { issues: [{ message: "expected a JSON object" }] };
  }
  const comment = (value as Record<string, unknown>).comment;
  if (!isPresent(comment)) {
    return { issues: [{ message: "`comment` must be a non-empty string" }] };
  }
  return { value: { comment } };
});

const promptArgs = {
  ISSUE_NUMBER,
  ISSUE_TITLE,
  SPEC_FILE,
  NOTES_FILE,
};

const { output, commits } = await runWithExtraction({
  name: `explore-${ISSUE_NUMBER}`,
  workPromptFile: "./.sandcastle/agent-workflows/explore/prompt.md",
  extractPromptFile: "./.sandcastle/agent-workflows/explore/extract.md",
  promptArgs,
  tag: "comment",
  schema: commentSchema,
});

// Exploration is read-only: a commit means a prompt misbehaved. Fail rather than
// let the workflow proceed as if nothing was written.
if (commits.length > 0) {
  console.error(
    `Exploration is read-only but produced ${commits.length} commit(s); refusing to continue.`,
  );
  process.exit(1);
}

// Hand the comment to the workflow, which posts it on the issue via `gh`.
writeFileSync(COMMENT_FILE, output.comment);
console.log(`Issue #${ISSUE_NUMBER}: wrote exploration comment to ${COMMENT_FILE}.`);
