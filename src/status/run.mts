// `agent-workflows status` — the STATUS VIEW entry point (ADR-0007). A third entry
// point to the package alongside the workflow and local sequencers: it runs no agent,
// follows no hook contract, and writes NOTHING. A label write would be a dispatch —
// one stray keypress would start a real, billed agent run — so this reads and prints.
//
// One shot: list the remote branches, gather the issues they imply (`gather.mts`,
// native-first), resolve the tree (`shared/spec-tree.mts`), print it (`render.mts`).
// `--watch` (issue #98) will redraw this same pass on an interval.

import { repoFromRemoteUrl, resolveRepoSlug } from "../shared/github.mts";
import { capture } from "../shared/process.mts";
import {
  crossReferencedIssues,
  issueRecord,
  listIssueRecords,
  nativeSubIssues,
  remoteBranches,
} from "../shared/spec-tracker.mts";
import { buildSpecTree } from "../shared/spec-tree.mts";
import { gatherIssues } from "./gather.mts";
import { renderStatus } from "./render.mts";

// The view takes no options yet — `--watch` arrives with issue #98. Rejected rather
// than ignored, so a flag that does nothing says so instead of appearing to work.
const options = process.argv.slice(2).filter(Boolean);
if (options.length > 0) {
  console.error(
    `agent-workflows status: unknown option(s): ${options.join(" ")} — the status view takes none.`,
  );
  process.exit(2);
}

// The repo you are standing in, from `GH_REPO` or the checkout's own origin remote —
// no argument, because the view is scoped to the repo it runs in.
const repo = resolveRepoSlug();
if (!repo) {
  console.error(
    "agent-workflows status: could not resolve the repo — run this inside a checkout with a GitHub `origin` remote, or set GH_REPO.",
  );
  process.exit(1);
}
process.env.GH_REPO = repo;

// Discovery joins issues (from `GH_REPO`) to branches (from the local `origin`), so the
// two disagreeing yields a silently empty view rather than an error: every spec issue
// is there, none of them matches a branch. Say so instead.
const originRepo = (() => {
  try {
    return repoFromRemoteUrl(capture("git", ["remote", "get-url", "origin"]));
  } catch {
    return null;
  }
})();
if (originRepo && originRepo !== repo) {
  console.error(
    `agent-workflows status: GH_REPO is ${repo} but this checkout's origin is ${originRepo} — branches are read from origin, so specs in ${repo} will look as though none has started.`,
  );
}

// A failure has to read differently from an empty view: "nothing is building" is the
// renderer's job and a good outcome, while an unauthenticated `gh` or a missing remote
// is an error with its own message.
try {
  const branches = remoteBranches();
  const issues = gatherIssues(branches, {
    issueRecord,
    nativeSubIssues: (spec) => nativeSubIssues(repo, spec),
    crossReferencedIssues: (spec) => crossReferencedIssues(repo, spec),
    allIssues: listIssueRecords,
  });
  console.log(renderStatus({ repo, specs: buildSpecTree(issues, branches) }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agent-workflows status: could not read ${repo}: ${message}`);
  process.exit(1);
}
