// GitHub-backed reads the spec orchestrator hooks need. The thin `gh`/`git` shell
// around the pure `spec-graph` brain: list issues, list remote branches. Kept here
// (not in the YAML) so the central workflow stays tracker-agnostic (ADR-0001); a
// Linear repo swaps this module for its own behind the same hook names.

import { capture } from "./process.mts";
import type { IssueRecord } from "./spec-tree.mts";

export interface RawIssue {
  number: number;
  body: string;
  state: "OPEN" | "CLOSED";
}

// Every issue in the repo (open and closed), with body and state — the input the
// hooks feed to `spec-graph` to discover a spec's tracer-bullets and which are done.
export function listIssues(): RawIssue[] {
  const json = capture("gh", [
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    "500",
    "--json",
    "number,body,state",
  ]);
  return JSON.parse(json) as RawIssue[];
}

// Every issue with the fields the STATUS VIEW renders — title, labels and URL on top of
// what `listIssues` returns. A separate call rather than a widened `listIssues`, because
// the orchestrator's hooks need none of it and pay for every extra field on a 500-issue
// fetch. Labels come back as objects; only the names cross this boundary, so nothing
// downstream can reach for a colour or an id.
export function listIssueRecords(): IssueRecord[] {
  const json = capture("gh", [
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    "500",
    "--json",
    "number,title,body,state,labels,url",
  ]);
  const raw = JSON.parse(json) as Array<
    Omit<IssueRecord, "labels"> & { labels: Array<{ name: string }> }
  >;
  return raw.map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }));
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
