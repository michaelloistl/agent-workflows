// `implement-finalize` hook. Open the draft PR for the pushed `agent/…` branch
// with the tracker cross-reference (`Closes #N`). PR *creation* is a hook (not
// the central workflow) because the cross-ref is tracker-aware (ADR-0001,
// Decision 7). `--base` is omitted so `gh` targets the repo's default branch.
import { required, capture } from "../shared/process.mts";

const number = required("ISSUE_NUMBER");
const title = required("ISSUE_TITLE");
const branch = required("BRANCH");

const body = `Automated by the agent-implement workflow for #${number}.\n\nCloses #${number}`;
capture("gh", [
  "pr",
  "create",
  "--draft",
  "--head",
  branch,
  "--title",
  title,
  "--body",
  body,
]);
console.log(`Issue #${number}: opened draft PR from ${branch}.`);
