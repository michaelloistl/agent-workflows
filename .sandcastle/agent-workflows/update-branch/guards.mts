// `update-branch-guards` hook. Refuse a stray label on a closed PR.
import { required, capture } from "../shared/process.mts";
import { refuse } from "../shared/github.mts";

const TRIGGER = "agent:update-branch";
const number = required("PR_NUMBER");
const state =
  process.env.PR_STATE ||
  capture("gh", ["pr", "view", number, "--json", "state", "-q", ".state"]).trim();

if (state.toLowerCase() === "closed") {
  refuse(
    "pr",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: this PR is closed. Removed the label without running.`,
  );
}
process.exit(0);
