// `implement-fetch-spec` hook. Materialize the issue body to $SPEC_FILE for the
// prompt, and emit the `agent/…` branch name as a step output. Branch naming is
// tracker-aware (issue number here, a Linear id on a Linear repo), so it lives
// behind the hook rather than in the central workflow.
import { writeFileSync, appendFileSync } from "node:fs";
import { required, capture } from "../shared/process.mts";

const number = required("ISSUE_NUMBER");
const title = required("ISSUE_TITLE");
const specFile = required("SPEC_FILE");

writeFileSync(specFile, capture("gh", ["issue", "view", number, "--json", "body", "-q", ".body"]));

const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 40);
const branch = `agent/issue-${number}-${slug}`;

const out = process.env.GITHUB_OUTPUT;
if (out) appendFileSync(out, `branch=${branch}\n`);
console.log(`Issue #${number}: wrote spec to ${specFile}; branch=${branch}.`);
