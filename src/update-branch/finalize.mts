// `update-branch-finalize` hook. Post the outcome comment. Reads $STATUS_FILE
// (`up-to-date` | `merged`, written by the agent run) to phrase it; the central
// workflow has already decided whether to push based on the same file.
import { readFileSync } from "node:fs";
import { required, capture } from "../shared/process.mts";

const number = required("PR_NUMBER");
const baseRef = required("BASE_REF");
const statusFile = required("STATUS_FILE");

const status = readFileSync(statusFile, "utf8").trim();
const body =
  status === "up-to-date"
    ? `\`agent:update-branch\`: already up to date with \`${baseRef}\`. Nothing to merge; no push.`
    : `\`agent:update-branch\`: merged \`${baseRef}\` into this branch and pushed. The PR is now up to date.`;

capture("gh", ["pr", "comment", number, "--body", body]);
console.log(`PR #${number}: posted update-branch outcome (${status}).`);
