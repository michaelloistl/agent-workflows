// `agent-workflows status` — the STATUS VIEW entry point (ADR-0007). A third entry
// point to the package alongside the workflow and local sequencers: it runs no agent,
// follows no hook contract, and writes NOTHING. A label write would be a dispatch —
// one stray keypress would start a real, billed agent run — so this reads and prints.
//
// One pass: list the remote branches, gather the issues they imply (`gather.mts`,
// native-first), resolve the tree (`shared/spec-tree.mts`), print it (`render.mts`).
// That is the whole command by default; `--watch` (`watch.mts`) repeats the same pass on
// an interval, redrawing in place until Ctrl-C.
//
// This file is the DISPATCH half throughout: it owns `process.argv`, `process.stdout`
// and the `gh` calls, and every decision it makes lives in a tested module next door.

import { repoFromRemoteUrl, resolveRepoSlug } from "../shared/github.mts";
import { capture } from "../shared/process.mts";
import {
  crossReferencedIssues,
  issueRecord,
  issuesChanged,
  listIssueRecords,
  nativeSubIssues,
  remoteBranches,
} from "../shared/spec-tracker.mts";
import { buildSpecTree } from "../shared/spec-tree.mts";
import { freshRender } from "./freshness.mts";
import { gatherIssues } from "./gather.mts";
import { parseStatusArgs } from "./options.mts";
import { renderStatus } from "./render.mts";
import { terminalScreen, watchStatus } from "./watch.mts";

// Colour follows the output device: `isTTY` is undefined when stdout is a pipe or a
// file, so a redirected view is clean text with nothing to strip.
const parsed = parseStatusArgs(process.argv.slice(2), process.stdout.isTTY === true);
if (!parsed.ok) {
  console.error(`agent-workflows status: ${parsed.message}`);
  process.exit(2);
}
const { colour, hyperlinks, watchIntervalMs } = parsed.options;

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
// Compared case-insensitively: GitHub slugs are case-insensitive, and `GH_REPO` may
// carry a casing the `origin` remote does not (or vice versa), so a difference in case
// alone is the same repo — not a reason to warn. `spec-tree.mts` lower-cases repo slugs
// for the same reason.
if (originRepo && originRepo.toLowerCase() !== repo.toLowerCase()) {
  console.error(
    `agent-workflows status: GH_REPO is ${repo} but this checkout's origin is ${originRepo} — branches are read from origin, so specs in ${repo} will look as though none has started.`,
  );
}

// One full pass: the issues the branches imply, the tree, the frame. Given the branch list
// rather than reading it, so a `--watch` tick reads the branches ONCE and hands the same
// list to both its change probe and this pass (issue #106). The whole read is in here so
// `--watch` repeats exactly what the one-shot run prints, never a cheaper approximation.
function pass(branches: readonly string[]): string {
  const issues = gatherIssues(branches, {
    issueRecord,
    nativeSubIssues: (spec) => nativeSubIssues(repo, spec),
    crossReferencedIssues: (spec) => crossReferencedIssues(repo, spec),
    allIssues: listIssueRecords,
  });
  return renderStatus({ repo, specs: buildSpecTree(issues, branches) }, { colour, hyperlinks });
}

if (watchIntervalMs === null) {
  // The one-shot path is unchanged: it always performs a full pass. A failure has to read
  // differently from an empty view: "nothing is building" is the renderer's job and a good
  // outcome, while an unauthenticated `gh` or a missing remote is an error with its own
  // message. A watch, by contrast, keeps going and shows it.
  try {
    console.log(pass(remoteBranches()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-workflows status: could not read ${repo}: ${message}`);
    process.exit(1);
  }
} else {
  // Ctrl-C is the terminal's own SIGINT — nothing here reads stdin, so there is no input
  // loop and no raw mode to undo. It aborts the wait, the loop falls out, and the
  // `finally` restores the screen on the way, so the exit is an ordinary one.
  const stopping = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => stopping.abort());
  }

  // The redraw loop is unchanged: it still calls one `() => string` per interval. What it
  // calls now decides whether the tick is worth a full pass — a cheap change probe against
  // the last frame's state — and only then fetches. An unchanged tracker redraws the frame
  // it already has (issue #106).
  await watchStatus({
    render: freshRender({
      branches: remoteBranches,
      changed: () => issuesChanged(repo),
      pass,
      now: () => Date.now(),
    }),
    screen: terminalScreen(process.stdout),
    intervalMs: watchIntervalMs,
    signal: stopping.signal,
  });
}
