// `implement-guards` hook. The four preflight checks the ldf YAML used to run
// inline, now behind the contract: PRD, issue-shape, blocked-by, existing-PR. A
// refusal retires `agent:implement`, comments why, and exits non-zero (the
// central workflow reads the exit and skips the run — a refusal is NOT a
// failure, so it never applies `agent:blocked`).
import { required, capture } from "../shared/process.mts";
import { refuse } from "../shared/github.mts";
import { section } from "../shared/markdown.mts";

const TRIGGER = "agent:implement";
const number = required("ISSUE_NUMBER");
const repo = required("GH_REPO");
const [owner, name] = repo.split("/");

function gh(args: ReadonlyArray<string>): string {
  return capture("gh", args);
}

// PRD guard — a product-requirements doc (titled `PRD:` or carrying a `prd`
// label) is a spec, not a buildable slice.
const title = gh(["issue", "view", number, "--json", "title", "-q", ".title"]).trim();
const labels = gh(["issue", "view", number, "--json", "labels", "-q", ".labels[].name"])
  .split("\n")
  .map((l) => l.trim().toLowerCase());
if (title.toLowerCase().startsWith("prd:") || labels.includes("prd")) {
  const why = title.toLowerCase().startsWith("prd:")
    ? "its title marks it as a PRD"
    : "it carries the `prd` label";
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: ${why}. PRDs are specs, not buildable slices — break it down into smaller issues and run the agent on those. Removed the label without running.`,
  );
}

// Issue-shape guard — the agent only builds standalone issues, never an epic or
// a sub-issue.
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
if (issue.parent) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Skipping \`${TRIGGER}\`: it is a sub-issue of #${issue.parent.number}. The agent only builds standalone issues, not epics or sub-issues. Removed the label without running.`,
  );
}

// Blocked-by guard — refuse while any issue named under `## Blocked by` is open.
const body = gh(["issue", "view", number, "--json", "body", "-q", ".body"]);
const blockedSection = section(body, "blocked by");
const refs = [...new Set([...blockedSection.matchAll(/#(\d+)/g)].map((m) => m[1]))];
const unmet = refs.filter((n) => {
  try {
    return gh(["issue", "view", n, "--json", "state", "-q", ".state"]).trim() === "OPEN";
  } catch {
    return false; // a ref that isn't a real issue (or a PR) doesn't block.
  }
});
if (unmet.length > 0) {
  refuse(
    "issue",
    number,
    TRIGGER,
    `Not starting yet: blocked by still-open issue(s) ${unmet.map((n) => `#${n}`).join(" ")}. Re-apply \`${TRIGGER}\` once the blocker(s) are closed.`,
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
