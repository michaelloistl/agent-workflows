// GitHub-backed reads the spec orchestrator hooks need. The thin `gh`/`git` shell
// around the pure `spec-graph` brain: list issues, list remote branches. Kept here
// (not in the YAML) so the central workflow stays tracker-agnostic (ADR-0001); a
// Linear repo swaps this module for its own behind the same hook names.

import { capture } from "./process.mts";
import type { BlockerRef, IssueRecord } from "./spec-tree.mts";

export interface RawIssue {
  number: number;
  body: string;
  state: "OPEN" | "CLOSED";
  // Carried for the dependency union (issue #99), not for display: `url` says which repo
  // this issue's numbers belong to, and `blockedBy` is the native arm of the union.
  url: string;
  blockedBy: readonly BlockerRef[];
}

// `gh`'s shape for a native dependency edge: a whole issue node per blocker. Only the
// number and the URL cross this boundary.
interface RawBlockedBy {
  blockedBy: { nodes: Array<{ number: number; url: string }> } | null;
}

function toBlockers(raw: RawBlockedBy): BlockerRef[] {
  return (raw.blockedBy?.nodes ?? []).map(({ number, url }) => ({ number, url }));
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
    // "none declared" or "this read cannot see them" (issue #99).
    blockedByCount: issue.issue_dependencies_summary?.blocked_by ?? 0,
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

// Short names of the repo's remote branches (no `refs/heads/` prefix). Used to
// detect a live spec branch (`pickSpecBranch`).
export function remoteBranches(): string[] {
  return capture("git", ["ls-remote", "--heads", "origin"])
    .split("\n")
    .map((line) => line.replace(/^.*\trefs\/heads\//, "").trim())
    .filter(Boolean);
}
