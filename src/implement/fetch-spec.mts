// `implement-fetch-spec` hook. Materialize the issue body to $SPEC_FILE for the
// prompt, and emit the `agent/…` branch name plus the `base` branch as step
// outputs. Branch naming and base derivation are tracker-aware (issue number here,
// a Linear id on a Linear repo; the spec branch resolved from `## Parent`), so they
// live behind the hook rather than in the central workflow (ADR-0001).
import { writeFileSync, appendFileSync } from "node:fs";
import { required, capture } from "../shared/process.mts";
import { parentRef } from "../shared/spec-graph.mts";
import { pickSpecBranch } from "../shared/spec-context.mts";
import { remoteBranches } from "../shared/spec-tracker.mts";
import { slugify } from "../shared/text.mts";

const number = required("ISSUE_NUMBER");
const title = required("ISSUE_TITLE");
const specFile = required("SPEC_FILE");

const body = capture("gh", ["issue", "view", number, "--json", "body", "-q", ".body"]);
writeFileSync(specFile, body);

const branch = `agent/issue-${number}-${slugify(title)}`;

// Derive the base branch. When this issue is a tracer-bullet whose parent spec has
// a live spec branch, build on top of it (the stacked topology); otherwise emit an
// empty `base` and the central workflow falls back to the default branch. A
// standalone issue (no `## Parent`) never touches git here — base stays "" and the
// existing single-issue flow is unchanged.
let base = "";
const spec = parentRef(body);
if (spec !== null) {
  base = pickSpecBranch(spec, remoteBranches()) ?? "";
}

const out = process.env.GITHUB_OUTPUT;
if (out) appendFileSync(out, `branch=${branch}\nbase=${base}\n`);
console.log(
  `Issue #${number}: wrote spec to ${specFile}; branch=${branch}; base=${base || "(default)"}.`,
);
