// `review-pr-status <state>` hook.
import { runStatus } from "../shared/github.mts";
import { required } from "../shared/process.mts";

runStatus({
  kind: "pr",
  number: required("PR_NUMBER"),
  triggerLabel: "agent:review-pr",
});
