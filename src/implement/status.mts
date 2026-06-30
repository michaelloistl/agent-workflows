// `implement-status <state>` hook. Reports the run's state to the tracker; the
// trigger label retired on `in-progress` is `agent:implement`.
import { runStatus } from "../shared/github.mts";
import { required } from "../shared/process.mts";

runStatus({
  kind: "issue",
  number: required("ISSUE_NUMBER"),
  triggerLabel: "agent:implement",
});
