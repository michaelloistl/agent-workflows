import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./process.mts";

// PR-context gathering shared by the PR-triggered agent-workflow entrypoints
// (the first consumer is `agent-review-pr`). It collects everything the agent
// needs to judge a pull request — its title, the issue it closes, the diff
// against the base branch, and the review/inline comments already on it — by
// shelling out to `gh`, so the entrypoint stays thin.

// The issue a PR closes (resolved from the PR's closing references), with the
// title and body the review agent needs to judge intent.
export interface LinkedIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

// Everything gathered about a pull request for a review pass.
export interface PrContext {
  readonly number: number;
  readonly title: string;
  // The base branch the diff is taken against.
  readonly baseRef: string;
  // The closing issue, or null when the PR closes none.
  readonly linkedIssue: LinkedIssue | null;
  // Unified diff of the PR against its base branch.
  readonly diff: string;
  // The PR's existing reviews and inline review comments, as a JSON string.
  readonly comments: string;
}

// On-disk paths the prompt inlines via `cat`. Kept here so the entrypoint only
// has to forward them as prompt args.
export interface PrContextFiles {
  readonly diffFile: string;
  readonly commentsFile: string;
  readonly linkedIssueFile: string;
}

function gh(args: ReadonlyArray<string>): string {
  return capture("gh", args);
}

// Gather the review context for `prNumber` in `repo` (owner/name). Reads the PR
// metadata and its closing issue, the diff against the base, and existing
// reviews + inline comments — all via `gh`, with no checkout required.
export function gatherPrContext(prNumber: number, repo: string): PrContext {
  const meta = JSON.parse(
    gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "number,title,baseRefName,closingIssuesReferences",
    ]),
  ) as {
    number: number;
    title: string;
    baseRefName: string;
    closingIssuesReferences: ReadonlyArray<{ number: number }>;
  };

  // `closingIssuesReferences` only carries the number, so fetch the linked
  // issue's title and body separately.
  let linkedIssue: LinkedIssue | null = null;
  const linkedRef = meta.closingIssuesReferences[0];
  if (linkedRef) {
    linkedIssue = JSON.parse(
      gh([
        "issue",
        "view",
        String(linkedRef.number),
        "--repo",
        repo,
        "--json",
        "number,title,body",
      ]),
    ) as LinkedIssue;
  }

  // Compute the diff locally. The PR-verb workflows check out the PR head with
  // fetch-depth: 0 and fetch the base, so `origin/<baseRef>...HEAD` matches
  // what `gh pr diff` would return — without the API's 300-file cap that
  // 406s on large PRs (`PullRequest.diff too_large`).
  const diff = capture("git", ["diff", `origin/${meta.baseRefName}...HEAD`]);

  // Existing reviews and inline review comments, so the agent does not repeat
  // points already raised.
  const reviews = JSON.parse(gh(["api", `repos/${repo}/pulls/${prNumber}/reviews`]));
  const inlineComments = JSON.parse(
    gh(["api", `repos/${repo}/pulls/${prNumber}/comments`]),
  );
  const comments = JSON.stringify({ reviews, inlineComments }, null, 2);

  return {
    number: meta.number,
    title: meta.title,
    baseRef: meta.baseRefName,
    linkedIssue,
    diff,
    comments,
  };
}

// Write the gathered context to files under `dir` and return their paths. The
// prompt inlines these; keeping the layout here means the entrypoint only knows
// the returned paths.
export function writePrContextFiles(context: PrContext, dir: string): PrContextFiles {
  const diffFile = join(dir, `pr-${context.number}-diff.patch`);
  const commentsFile = join(dir, `pr-${context.number}-comments.json`);
  const linkedIssueFile = join(dir, `pr-${context.number}-linked-issue.md`);

  writeFileSync(diffFile, context.diff);
  writeFileSync(commentsFile, context.comments);
  writeFileSync(
    linkedIssueFile,
    context.linkedIssue
      ? `#${context.linkedIssue.number} — ${context.linkedIssue.title}\n\n${context.linkedIssue.body}`
      : "No linked issue found for this PR.",
  );

  return { diffFile, commentsFile, linkedIssueFile };
}
