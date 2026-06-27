// `explore-finalize` hook. Post the exploration comment ($COMMENT_FILE, written
// by the agent run) to the issue.
import { commentFile } from "../shared/github.mts";
import { required } from "../shared/process.mts";

const issueNumber = required("ISSUE_NUMBER");
commentFile("issue", issueNumber, required("COMMENT_FILE"));
console.log(`Issue #${issueNumber}: posted exploration comment.`);
