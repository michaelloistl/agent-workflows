// GitHub-backed reads the spec orchestrator hooks need. The thin `gh`/`git` shell
// around the pure `spec-graph` brain: list issues, list remote branches. Kept here
// (not in the YAML) so the central workflow stays tracker-agnostic (ADR-0001); a
// Linear repo swaps this module for its own behind the same hook names.

import { capture } from "./process.mts";
import type {
  BlockedBySources,
  BlockerRef,
  IssueRecord,
  IssueState,
  PullRequestRecord,
} from "./spec-tree.mts";

export interface RawIssue {
  number: number;
  body: string;
  state: IssueState;
  // Carried for the dependency union (issue #99), not for display: `url` says which repo
  // this issue's numbers belong to, and `blockedBy` is the native arm of the union.
  url: string;
  blockedBy: readonly BlockerRef[];
}

// `gh`'s shape for a native dependency edge: a whole issue node per blocker. Only the
// number, the URL and the state cross this boundary — the node also carries an id and a
// title, which nothing downstream should be able to reach for.
interface RawBlockedBy {
  blockedBy: { nodes: Array<{ number: number; url: string; state: IssueState }> } | null;
}

// The state comes along on every one of these reads at no cost, which is what lets the
// `implement` blocked-by guard drop its read-per-ref fan-out (issue #100).
function toBlockers(raw: RawBlockedBy): BlockerRef[] {
  return (raw.blockedBy?.nodes ?? []).map(({ number, url, state }) => ({ number, url, state }));
}

// Every issue in the repo (open and closed), with body, state and dependency edges —
// the input the hooks feed to `spec-graph` to discover a spec's tracer-bullets, which
// are done, and what gates what. `blockedBy` rides along on this one list read, so
// native ordering costs no request per slice.
export function listIssues(): RawIssue[] {
  const json = capture("gh", [
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    "500",
    "--json",
    "number,body,state,url,blockedBy",
  ]);
  return (JSON.parse(json) as Array<Omit<RawIssue, "blockedBy"> & RawBlockedBy>).map((raw) => ({
    ...raw,
    blockedBy: toBlockers(raw),
  }));
}

// The `--json` fields an `IssueRecord` needs from `gh`. `parent` and `blockedBy` are the
// NATIVE edges (gh 2.94+); both are empty in a repo that has not adopted them, which is
// exactly when `resolveParent` falls back to the body and `unionBlockers` reduces to it.
const RECORD_FIELDS = "number,title,body,state,labels,url,parent,blockedBy";

// `gh`'s shape for the fields above: labels are objects and `parent` is a whole issue,
// but only the label NAMES and the parent NUMBER cross this boundary — nothing
// downstream can reach for a colour, an id, or a parent's body.
interface RawRecord extends Omit<IssueRecord, "labels" | "parent" | "blockedBy">, RawBlockedBy {
  labels: Array<{ name: string }>;
  parent: { number: number } | null;
}

function toRecord(raw: RawRecord): IssueRecord {
  return {
    ...raw,
    labels: raw.labels.map((l) => l.name),
    parent: raw.parent?.number ?? null,
    blockedBy: toBlockers(raw),
  };
}

// Every issue with the fields the STATUS VIEW renders — title, labels, URL and native
// parent on top of what `listIssues` returns. A separate call rather than a widened
// `listIssues`, because the orchestrator's hooks need none of it and pay for every extra
// field on a 500-issue fetch.
//
// This is the FULL-REPO SCAN, and the status view now avoids it wherever native
// hierarchy answers the question instead (issue #96): it is the textual fallback's
// candidate set, nothing more.
export function listIssueRecords(): IssueRecord[] {
  const json = capture("gh", [
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    "500",
    "--json",
    RECORD_FIELDS,
  ]);
  return (JSON.parse(json) as RawRecord[]).map(toRecord);
}

// One issue by number, or null when it does not exist. The status view discovers specs
// from the live `agent/spec-*` branches and then reads exactly those issues, so a
// handful of point reads replace a scan of the whole repo — and, unlike a 500-issue
// list, a spec cannot fall off the end of the page.
export function issueRecord(issue: number): IssueRecord | null {
  try {
    const json = capture("gh", ["issue", "view", String(issue), "--json", RECORD_FIELDS], {
      quiet: true,
    });
    return toRecord(JSON.parse(json) as RawRecord);
  } catch {
    // A branch whose issue was deleted, or a number that never was one.
    return null;
  }
}

// A REST issue payload, as both endpoints below serve it. Snake-cased and
// lower-cased where `gh --json` is neither, which is the whole reason this mapping
// exists twice over rather than reusing `toRecord`.
interface RestIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  html_url: string;
  // Present only when the payload is really a PR — which is never a tracer-bullet.
  pull_request?: unknown;
  // REST's dependency projection: counts, no edges. Absent on an older host.
  issue_dependencies_summary?: { blocked_by: number };
}

// `parent` is the caller's to supply: REST carries no parent edge, so only an endpoint
// that IS the edge (`sub_issues`) knows one. Dependency edges are left UNSET rather than
// empty — REST serves a blocker count and no edges, so this read has nothing to say about
// them and the gatherer takes them from the issue-list read instead.
function fromRest(issue: RestIssue, parent: number | null): IssueRecord {
  return {
    number: issue.number,
    title: issue.title,
    // REST omits an empty body; the ordering parse needs a string either way.
    body: issue.body ?? "",
    state: issue.state === "closed" ? "CLOSED" : "OPEN",
    labels: issue.labels.map((l) => l.name),
    url: issue.html_url,
    parent,
    // The edges themselves stay unset; the count is what says whether that silence means
    // "none declared" or "this read cannot see them" (issue #99). Left UNDEFINED — not
    // defaulted to zero — when the host omits `issue_dependencies_summary` altogether: a
    // missing summary is an unknown count, and reading it as "no blockers" would let a
    // fully-migrated repo skip the scan and under-block. The gatherer treats undefined as
    // "cannot rule blockers out" and scans, so the failure mode is a slower read.
    blockedByCount: issue.issue_dependencies_summary?.blocked_by,
  };
}

// The issues that REFERENCE `spec` anywhere in their body, from the spec's own timeline —
// the textual arm of the union without a full-repo scan. GitHub records a `#N` in a body
// as a cross-reference event on issue N, and serves the referencing issue live (current
// state and labels, not a snapshot), so one call per spec finds every candidate child.
//
// Candidates only: a follow-up issue that merely mentions the spec in prose comes back
// too, and is dropped by the caller's `## Parent` parse. PRs are dropped here — a PR
// referencing the spec is never a tracer-bullet. The records carry no native parent
// (the payload has none), so a slice that is natively parented elsewhere must be
// resolved from its sub-issue record instead; the gatherer orders the two accordingly.
export function crossReferencedIssues(repo: string, spec: number): IssueRecord[] {
  let json: string;
  try {
    json = capture("gh", ["api", "--paginate", "--slurp", `repos/${repo}/issues/${spec}/timeline`], {
      quiet: true,
    });
  } catch {
    return [];
  }
  const pages = JSON.parse(json) as Array<
    Array<{ event: string; source?: { issue?: RestIssue } }>
  >;
  return pages
    .flat()
    .filter((event) => event.event === "cross-referenced")
    .map((event) => event.source?.issue)
    .filter((issue): issue is RestIssue => issue !== undefined && !issue.pull_request)
    .map((issue) => fromRest(issue, null));
}

// A spec's tracer-bullets through the NATIVE sub-issue relationship — one call per spec,
// returning closed slices as readily as open ones, which is the whole reason the scan can
// be skipped. Empty in a repo (or on a spec) with no native hierarchy: the caller reads
// that as "fall back to the textual scan", never as "this spec has no slices".
//
// REST rather than `gh issue view --json subIssues`, because that projection carries only
// number/title/state/url — no body (so no `## Blocked by`, so no order) and no labels (so
// no per-slice state). `--paginate --slurp` returns one array per page, so a spec sliced
// past the 30-item default page still arrives whole.
export function nativeSubIssues(repo: string, spec: number): IssueRecord[] {
  let json: string;
  try {
    json = capture(
      "gh",
      ["api", "--paginate", "--slurp", `repos/${repo}/issues/${spec}/sub_issues`],
      { quiet: true },
    );
  } catch {
    // A host that does not serve the endpoint answers like a repo with no hierarchy:
    // empty, so the textual scan takes over and the view renders as it did before #96.
    // A failure that matters — no auth, no such repo — resurfaces on that scan.
    return [];
  }
  const pages = JSON.parse(json) as RestIssue[][];
  // The edge the endpoint itself IS: these came back as children of `spec`.
  return pages.flat().map((issue) => fromRest(issue, spec));
}

// Everything the dependency rules need about ONE issue, in one read: its body (the textual
// arm), its own URL (which repo a bare `#N` means), and its native edges with their states.
// The `implement` guard reads its issue's body here rather than on its own — the body it
// checks for a `## Parent` and the body the union parses must be the same body, and one
// read is also one fewer than the guard used to make.
export function blockedBySources(issue: number | string): BlockedBySources {
  const raw = JSON.parse(
    capture("gh", ["issue", "view", String(issue), "--json", "body,url,blockedBy"]),
  ) as { body: string; url: string } & RawBlockedBy;
  return { body: raw.body, url: raw.url, blockedBy: toBlockers(raw) };
}

// The repo's OPEN pull requests, with what the status view needs to state each one: its
// head and base branches (which is how a final PR is identified — see `attachFinalPr`),
// whether it is still a draft, and the review decision. One list read for the whole repo
// rather than one `gh pr list --head` per spec, and the caller only makes it when some
// spec has finished its slices (`needsFinalPrRead`).
//
// `--limit 500` matches the issue reads above rather than trimming the page, because the
// PR this is looking for is the one most likely to be trimmed: `gh` lists newest first,
// so a smaller page drops the OLDEST open PRs — and a final PR left open for weeks is
// exactly the case this read exists to surface. Beyond 500 open PRs the row degrades to
// `awaiting final PR`, which is the pre-existing behaviour rather than a wrong one.
export function openPullRequests(): PullRequestRecord[] {
  const json = capture("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,title,url,headRefName,baseRefName,isDraft,reviewDecision",
  ]);
  return JSON.parse(json) as PullRequestRecord[];
}

// The label names on one issue. The read behind the local-run marker
// (`spec-marker.mts`): the advance guard asks whether the spec issue is claimed by
// an attended local run, and the loop asks whether a marker it finds is one it must
// reclaim. Throws when `gh` fails — the caller decides how tolerant to be.
export function issueLabels(issue: number | string): string[] {
  return capture("gh", ["issue", "view", String(issue), "--json", "labels", "-q", ".labels[].name"])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

// Has anything about the repo's issues changed since the last probe? The cheap half of a
// `--watch` tick (issue #106): the status view asks this before deciding whether to do the
// expensive full pass. It is an INVALIDATION SIGNAL and never a source of display data —
// the full pass remains the only thing that produces a frame.
//
// The probe is the repo's issues ordered by most-recently-updated, a single item, replayed
// with the previous ETag. Any label write, close, reopen, body edit or new issue makes that
// issue the head of an updated-descending list and changes the payload; a `304 Not Modified`
// then costs nothing against the primary rate limit, so an idle watch can run indefinitely.
// It OVER-triggers, by design: the issues endpoint includes pull requests, so an unrelated
// PR comment causes one extra full pass — the cheap side of the trade.
//
// Returns `false` when the tracker is verified unchanged, `true` when it changed, and `null`
// when the probe cannot tell — a `gh` failure, a missing ETag, an unparseable response, or
// the first probe with nothing to compare against. The caller fails open on `null`. The
// ETag is held in memory for the life of the process; there is no cache file.
let issuesEtag: string | null = null;

export function issuesChanged(repo: string): boolean | null {
  // `state=all` so a CLOSE is caught too: a close bumps the issue's `updated_at`, which
  // makes it the head of the list only if closed issues are in it — an `open`-only list
  // would drop the closed issue and leave an unrelated head unchanged.
  const path = `/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=1`;
  const conditional = issuesEtag ? ["-H", `If-None-Match: ${issuesEtag}`] : [];
  // `-i` prints the status line and headers, so both the 304 and the new ETag can be read
  // off the response — and `ghResponse` reads that status line whether `gh` treats the 304
  // as a clean exit or a non-zero one (the observed behaviour varies by `gh` version), so
  // the probe does not depend on which.
  const response = ghResponse(["api", "-i", ...conditional, path]);
  if (response === null) return null;

  const status = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(response);
  if (status?.[1] === "304") return false;
  if (status?.[1] !== "200") return null;

  const etag = /^etag:\s*(.+)$/im.exec(response)?.[1]?.trim();
  if (etag === undefined) return null;
  // A 200 despite `If-None-Match` means the payload really did change; without a prior ETag
  // there is nothing to compare, so the first probe primes the ETag and defers to the full
  // pass the first tick performs anyway.
  const changed = issuesEtag !== null;
  issuesEtag = etag;
  return changed ? true : null;
}

// Run `gh` and return its stdout whether it exits zero or not. `gh api -i` writes the status
// line to stdout even when it reports a 304 as a non-zero exit (`gh: HTTP 304`) — the exit
// code for a 304 has varied by `gh` version, so reading stdout from a thrown error as
// readily as from a clean 200 keeps the probe robust to either. Null only when there is no
// output at all to parse (a spawn failure, an auth error with an empty stdout).
function ghResponse(args: readonly string[]): string | null {
  try {
    return capture("gh", args, { quiet: true });
  } catch (error) {
    const stdout = (error as { stdout?: Buffer | string | null }).stdout;
    return stdout ? stdout.toString() : null;
  }
}

// Short names of the repo's remote branches (no `refs/heads/` prefix). Used to
// detect a live spec branch (`pickSpecBranch`).
export function remoteBranches(): string[] {
  return capture("git", ["ls-remote", "--heads", "origin"])
    .split("\n")
    .map((line) => line.replace(/^.*\trefs\/heads\//, "").trim())
    .filter(Boolean);
}
