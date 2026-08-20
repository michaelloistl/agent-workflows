// `implement-guards` hook. The four preflight checks the workflow YAML used to run
// inline, now behind the contract: spec, issue-shape, blocked-by, existing-PR. A
// refusal retires `agent:implement`, comments why, and exits non-zero (the
// central workflow reads the exit and skips the run — a refusal is NOT a
// failure, so it never applies `agent:blocked`).
import { required, capture } from "../shared/process.mts";
import { refuse } from "../shared/github.mts";
import { parentRef, tracerBullets } from "../shared/spec-graph.mts";
import { unmetBlockers } from "../shared/blocked-by.mts";
import type { IssueState } from "../shared/spec-tree.mts";
import { blockedBySources, listIssues } from "../shared/spec-tracker.mts";

const TRIGGER = "agent:implement";
const number = required("ISSUE_NUMBER");
const repo = required("GH_REPO");
const [owner, name] = repo.split("/");

function gh(args: ReadonlyArray<string>): string {
  return capture("gh", args);
}

// spec guard — a product-requirements doc is a spec, not a buildable slice. Detect
// it STRUCTURALLY (it has tracer-bullets referencing it as `## Parent`), since
// `/to-spec` may not prefix the title `spec:` or add a `spec` label; still honour
// those markers when present.
const title = gh(["issue", "view", number, "--json", "title", "-q", ".title"]).trim();
const labels = gh(["issue", "view", number, "--json", "labels", "-q", ".labels[].name"])
  .split("\n")
  .map((l) => l.trim().toLowerCase());
// The one repo-wide read this hook makes. It answers spec-ness here and, further down,
// the state of every blocker declared textually — which is why the blocked-by guard no
// longer reads one issue per ref.
const issues = listIssues();
const childCount = tracerBullets(Number(number), issues).length;
const markedSpec = title.toLowerCase().startsWith("spec:") || labels.includes("spec");
if (markedSpec || childCount > 0) {
  const why =
    childCount > 0
      ? `${childCount} tracer-bullet(s) reference it as their \`## Parent\``
      : title.toLowerCase().startsWith("spec:")
        ? "its title marks it as a spec"
        : "it carries the `spec` label";
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: ${why}, so #${number} is a spec — a spec, not a buildable slice. Run \`agent:implement-spec\` on it to orchestrate its tracer-bullets, or break it down further. Removed the label without running.`,
  );
}

// Issue-shape guard — the agent only builds standalone issues and spec tracer-bullets,
// never an epic, and never a sub-issue whose native parent contradicts its `## Parent`.
const shape = JSON.parse(
  gh([
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{number} subIssuesSummary{total}}}}",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]),
) as {
  data: {
    repository: {
      issue: { parent: { number: number } | null; subIssuesSummary: { total: number } };
    };
  };
};
const issue = shape.data.repository.issue;
if (issue.subIssuesSummary.total > 0) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: it has ${issue.subIssuesSummary.total} sub-issue(s). The agent only builds standalone issues, not epics or sub-issues. Removed the label without running.`,
  );
}
// Body, own URL and native dependency edges in one read — the body for the parent check
// just below, all three for the blocked-by check further down. It is the same single read
// the guard already made for the body, just projecting two more fields; a point read
// rather than the issue's row in `issues`, because that list is one page of 500 and this
// guard must not stop reading the body of the issue it was asked about.
const sources = blockedBySources(number);
const body = sources.body;
// A native GH sub-issue link is normally an epic/sub-issue marker (refuse), but
// tracer-bullets under a spec legitimately declare a native parent when the
// tracker sync (e.g. Linear → GH) mirrors the parent/child edge. Allow it iff
// the body's `## Parent` textual reference matches the native parent — that's
// the spec-orchestrator's tracer-bullet contract (spec-graph.mts).
if (issue.parent && parentRef(body) !== issue.parent.number) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: it is a sub-issue of #${issue.parent.number} but does not declare it as its \`## Parent\`. The agent only builds standalone issues or spec tracer-bullets, not epics or ad-hoc sub-issues. Removed the label without running.`,
  );
}

// Blocked-by guard — refuse while any blocker is open, declared under `## Blocked by`, as a
// native dependency edge, or both (`unionBlockers`, issue #99). A native edge carries its
// blocker's state, and the issue list read above carries every other one, so the read per
// blocking ref this guard used to make is gone.
//
// It is not replaced by nothing, though: that list is one page of 500, and a textual ref
// past the end of it would come back unresolvable and quietly stop gating — under-blocking,
// the failure the union exists to prevent. A ref the page cannot answer therefore falls
// back to the point read, which is what the guard always did and is now the exception
// rather than the rule.
const stateByNumber = new Map(issues.map((i) => [i.number, i.state]));
const stateOf = (blocker: number): IssueState | null => {
  const listed = stateByNumber.get(blocker);
  if (listed !== undefined) return listed;
  try {
    return gh(["issue", "view", String(blocker), "--json", "state", "-q", ".state"]).trim() ===
      "OPEN"
      ? "OPEN"
      : "CLOSED";
  } catch {
    return null; // a ref that isn't a real issue (or a PR) doesn't block.
  }
};
const unmet = unmetBlockers(sources, stateOf);
// A blocker in another repository is left out of the decision — `#12` there is not `#12`
// here — but never in silence: it is a wait no local close will clear, and the job log is
// where this path says so.
if (unmet.foreign.length > 0) {
  console.error(
    `Note: #${number} declares native blocker(s) ${unmet.foreign.join(", ")} in another repository. Issue numbers are per-repo, so they do not gate this run.`,
  );
}
if (unmet.open.length > 0) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Not starting yet: blocked by still-open issue(s) ${unmet.open.map((n) => `#${n}`).join(" ")}. Re-apply \`${TRIGGER}\` once the blocker(s) are closed.`,
  );
}

// Existing-PR guard — refuse while an open PR already cross-references the issue,
// so the agent never tramples in-progress work.
const openPrs = JSON.parse(
  gh([
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${name}`,
    "-F",
    `number=${number}`,
    "-f",
    "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{... on PullRequest{number state}}}}}}}}",
    "--jq",
    '[.data.repository.issue.timelineItems.nodes[].source | select(.state == "OPEN") | .number] | unique',
  ]),
) as number[];
if (openPrs.length > 0) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: an open pull request (${openPrs.map((n) => `#${n}`).join(", ")}) already references this issue, so the agent would risk trampling in-progress work. Removed the label without running. Re-add it once that PR is merged or closed.`,
  );
}

// Nothing refused.
process.exit(0);
