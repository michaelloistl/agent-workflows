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
import { statusFrame, type RunningVersion } from "./frame.mts";
import { freshRender } from "./freshness.mts";
import { gatherIssues } from "./gather.mts";
import { parseStatusArgs } from "./options.mts";
import { formatQuota, parseQuota, throttled, withQuota } from "./quota.mts";
import { renderStatus } from "./render.mts";
import { runningVersion } from "./version.mts";
import { terminalScreen, watchStatus } from "./watch.mts";

// The RUNNING PACKAGE VERSION the footer states, read ONCE before anything else runs and
// held for the life of the process (`version.mts` owns the read, `frame.mts` the wording):
// a `--watch` left open across a `yarn install` keeps the version of the code it is actually
// still running rather than one that changed underneath it.
const version: RunningVersion = runningVersion();

// Colour follows the output device: `isTTY` is undefined when stdout is a pipe or a
// file, so a redirected view is clean text with nothing to strip. The environment goes in
// too, because hyperlinks need more than a TTY — a multiplexer can own the terminal and
// swallow the escape (see `options.mts`), and this is the dispatch half that owns `process`.
const parsed = parseStatusArgs(process.argv.slice(2), process.stdout.isTTY === true, process.env);
if (!parsed.ok) {
  console.error(`agent-workflows status: ${parsed.message}`);
  process.exit(2);
}
const { colour, headroom, hyperlinks, watchIntervalMs } = parsed.options;

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

// How long the quota read gets before it is abandoned. Measured at ~1.4s of wall clock with
// MCP off, so this is roughly 3x slack for a cold start. Note the figure the command REPORTS
// of itself (`duration_ms`, ~280ms) is not this: it excludes process startup, which is nearly
// all of the real cost. This is the one read here that is worth nothing if it is slow — it
// decorates the view rather than being the view.
//
// It is NOT bounded by the watch interval, and the worst case is worth stating rather than
// implying otherwise: 4s is twice the 2s `--interval` floor, so on a machine where `claude`
// is installed but wedged — a hung keychain prompt, a stalled call during startup — one tick
// in every `QUOTA_TTL_MS` blocks for 4s before sleeping the interval on top, and a
// `--watch --interval 2` pane visibly hitches while its footer still says 2s. Accepted over
// the alternative: a timeout under the floor would be ~2s against a 1.4s measured read,
// which is not slack at all — a cold start on a slow disk would time out and blank the line
// on exactly the machines least able to spare the confusion. The hitch is rare, bounded, and
// the throttle's one-window carry (`quota.mts`) keeps the number on screen through it.
const QUOTA_TIMEOUT_MS = 4000;

// The quota read has no use for MCP servers, and loading a consumer's — a Linear plugin, a
// database server — to ask the local account about its own rate limits is pure startup cost
// on every render. Measured: ~3.4s with them, ~1.4s without, for byte-identical output.
const QUOTA_ARGS = [
  "--strict-mcp-config",
  "--print",
  "--output-format",
  "json",
  "/usage",
] as const;

// The quota line, or `null` for every way this can fail to produce one: `claude` not
// installed, not authenticated, authenticated to something with no subscription windows
// (an API key, Bedrock, Vertex), timed out, or prose this release no longer recognises.
// Silent in all of them — the view degrades to exactly what it printed before this existed,
// because headroom is context for the tree and never a reason to withhold it.
//
// `quiet` because the failure is expected and handled: a machine without `claude` on its
// PATH must not have the status view spraying stderr at it on every redraw.
function quotaLine(): string | null {
  if (!headroom) return null;
  try {
    const stdout = capture("claude", QUOTA_ARGS, {
      quiet: true,
      timeoutMs: QUOTA_TIMEOUT_MS,
    });
    const quota = parseQuota(stdout);
    return quota === null ? null : formatQuota(quota, { colour });
  } catch {
    return null;
  }
}

if (watchIntervalMs === null) {
  // The one-shot path is unchanged: it always performs a full pass. A failure has to read
  // differently from an empty view: "nothing is building" is the renderer's job and a good
  // outcome, while an unauthenticated `gh` or a missing remote is an error with its own
  // message. A watch, by contrast, keeps going and shows it.
  // The footer goes on the SUCCESS path only, and through the same formatter the watch frames
  // use: a failed read below keeps its concise error and its non-zero exit rather than being
  // dressed up as a completed view.
  try {
    console.log(statusFrame(withQuota(pass(remoteBranches()), quotaLine()), version));
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
  // The quota read sits OUTSIDE the freshness gate, deliberately: that gate exists to spend
  // the GitHub rate limit the fleet's agent runs share, and this read touches neither GitHub
  // nor a token. It matters that it is ungated, because the number moves precisely when the
  // tree does NOT — a CI run eating the weekly window changes no label — so a tick that
  // reused the frame would otherwise show a frozen bar for up to the five-minute ceiling.
  //
  // It gets its own throttle instead, because the read costs ~1.4s of wall clock and a
  // default tick is 5s. Half a minute of reuse is invisible on a window that moves in
  // fractions of a percent per minute; blocking a quarter of every redraw would not be. The
  // throttle also carries the last good line across one failed window, so a single timeout
  // does not blank the line and shift the tree up two rows mid-watch.
  const quota = throttled(quotaLine);

  const tree = freshRender({
    branches: remoteBranches,
    changed: () => issuesChanged(repo),
    pass,
    now: () => Date.now(),
  });

  await watchStatus({
    render: () => withQuota(tree(), quota()),
    screen: terminalScreen(process.stdout),
    intervalMs: watchIntervalMs,
    version,
    signal: stopping.signal,
  });
}
