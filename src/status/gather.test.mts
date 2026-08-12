import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherIssues, type TrackerReads } from "./gather.mts";
import type { IssueRecord } from "../shared/spec-tree.mts";

function issue(over: Partial<IssueRecord> & { number: number }): IssueRecord {
  return {
    title: `issue ${over.number}`,
    body: "",
    state: "OPEN",
    labels: [],
    url: `https://github.com/o/r/issues/${over.number}`,
    ...over,
  };
}

// A tracker with the given issues, counting what was asked of it — the point of the
// native path is the reads it does NOT do. Cross-references are modelled as GitHub
// serves them: every issue whose body mentions the spec, children and bystanders alike,
// and without the native parent edge the sub-issue read carries.
function tracker(issues: IssueRecord[]) {
  const calls = { issue: [] as number[], native: [] as number[], refs: [] as number[], scans: 0 };
  const reads: TrackerReads = {
    issueRecord: (n) => {
      calls.issue.push(n);
      return issues.find((i) => i.number === n) ?? null;
    },
    nativeSubIssues: (spec) => {
      calls.native.push(spec);
      // REST serves a dependency COUNT and no edges, so the native read carries the
      // count alone — exactly as `fromRest` does.
      return issues
        .filter((i) => i.parent === spec)
        .map(({ blockedBy, ...rest }) => ({ ...rest, blockedByCount: blockedBy?.length ?? 0 }));
    },
    crossReferencedIssues: (spec) => {
      calls.refs.push(spec);
      // Also REST: no parent edge, and a dependency count in place of the edges.
      return issues
        .filter((i) => i.body.includes(`#${spec}`))
        .map(({ parent: _native, blockedBy, ...rest }) => ({
          ...rest,
          blockedByCount: blockedBy?.length ?? 0,
        }));
    },
    allIssues: () => {
      calls.scans += 1;
      return issues;
    },
  };
  return { reads, calls };
}

test("specs are read point-by-point from the live spec branches", () => {
  const { reads, calls } = tracker([issue({ number: 94 }), issue({ number: 12 })]);
  gatherIssues(["main", "agent/spec-94-x", "agent/issue-95-y", "agent/spec-12-z"], reads);
  assert.deepEqual(calls.issue, [94, 12], "only the spec branches' issues are read");
});

test("a spec branch listed twice is read once", () => {
  const { reads, calls } = tracker([issue({ number: 94 })]);
  gatherIssues(["agent/spec-94-x", "agent/spec-94-x"], reads);
  assert.deepEqual(calls.issue, [94]);
});

// The point of native-first: a migrated repo never pays for a full-repo scan, so no
// spec can fall off the end of a 500-issue page.
test("a spec with native children costs no full-repo scan", () => {
  const { reads, calls } = tracker([
    issue({ number: 94 }),
    issue({ number: 95, parent: 94 }),
    issue({ number: 96, parent: 94 }),
  ]);
  const gathered = gatherIssues(["agent/spec-94-x"], reads);

  assert.equal(calls.scans, 0);
  assert.deepEqual(calls.native, [94]);
  assert.deepEqual(
    gathered.map((i) => i.number),
    [94, 95, 96],
  );
});

// The case that decides whether the fast path can be trusted: a slice added to a
// migrated spec is textual until the sync mirrors it, and dropping it would put a wrong
// count and a wrong "next" row on screen. Its cross-reference finds it — still no scan.
test("a textual slice on a migrated spec is gathered without a scan", () => {
  const { reads, calls } = tracker([
    issue({ number: 94 }),
    issue({ number: 95, parent: 94 }),
    issue({ number: 96, body: "## Parent\n\n#94\n" }),
  ]);
  const gathered = gatherIssues(["agent/spec-94-x"], reads);

  assert.equal(calls.scans, 0);
  assert.deepEqual(calls.refs, [94]);
  assert.deepEqual(
    gathered.map((i) => i.number).sort((a, b) => a - b),
    [94, 95, 96],
  );
});

// The cross-reference read answers "who mentions this spec", not "who is a child of it".
// The bystanders it brings along are dropped downstream by the `## Parent` parse, so they
// must arrive intact rather than be mistaken for slices here.
test("an issue that merely mentions the spec is gathered, not filtered out early", () => {
  const { reads } = tracker([
    issue({ number: 94 }),
    issue({ number: 95, parent: 94 }),
    issue({ number: 99, body: "Follow-up from #94, which changed the defaults." }),
  ]);
  const gathered = gatherIssues(["agent/spec-94-x"], reads);
  assert.ok(gathered.some((i) => i.number === 99));
});

// The count is the tell (issue #99): REST says a slice HAS native blockers without
// saying which, and an unseen blocker under-blocks the order — the failure mode the
// union exists to avoid. The edges live on the issue-list read, so that is what pays for
// them: one scan, never a request per slice, and only when native dependencies are
// really in use.
test("a migrated spec whose slices declare native blockers is scanned for the edges", () => {
  const { reads, calls } = tracker([
    issue({ number: 94 }),
    issue({ number: 95, parent: 94 }),
    issue({
      number: 96,
      parent: 94,
      blockedBy: [{ number: 95, url: "https://github.com/o/r/issues/95" }],
    }),
  ]);
  const gathered = gatherIssues(["agent/spec-94-x"], reads);

  assert.equal(calls.scans, 1);
  assert.deepEqual(
    gathered.find((i) => i.number === 96)?.blockedBy?.map((b) => b.number),
    [95],
  );
});

// The same tell on the OTHER REST read: a slice that is textual on a migrated spec comes
// back through the timeline, and it can declare native blockers just as readily.
test("a textual slice on a migrated spec is scanned for its native edges too", () => {
  const { reads, calls } = tracker([
    issue({ number: 94 }),
    issue({ number: 95, parent: 94 }),
    issue({
      number: 96,
      body: "## Parent\n\n#94\n",
      blockedBy: [{ number: 95, url: "https://github.com/o/r/issues/95" }],
    }),
  ]);
  const gathered = gatherIssues(["agent/spec-94-x"], reads);

  assert.equal(calls.scans, 1);
  assert.deepEqual(
    gathered.find((i) => i.number === 96)?.blockedBy?.map((b) => b.number),
    [95],
  );
});

// Native dependency edges ride the issue-list read alone (issue #99) — the REST reads
// serve a count and no more. So the two records are merged field by field rather than
// first-wins wholesale: losing the edges to the record that outranks it on parentage
// would silently UNDER-block a slice, which is the failure this union exists to avoid.
test("a slice keeps its native parent and its native blockers, from different reads", () => {
  const { reads } = tracker([
    issue({ number: 94 }),
    issue({ number: 95, parent: 94 }),
    issue({
      number: 96,
      parent: 94,
      blockedBy: [{ number: 95, url: "https://github.com/o/r/issues/95" }],
    }),
    // An unmigrated spec alongside it, which is what makes the scan run at all.
    issue({ number: 12 }),
    issue({ number: 13, body: "## Parent\n\n#12\n" }),
  ]);
  const gathered = gatherIssues(["agent/spec-94-x", "agent/spec-12-y"], reads);
  const slice = gathered.find((i) => i.number === 96);

  assert.equal(slice?.parent, 94, "the native record still decides parentage");
  assert.deepEqual(
    slice?.blockedBy?.map((b) => b.number),
    [95],
    "and the scan's record supplies the edges it alone carries",
  );
});

// A cross-reference carries no native parent, so a slice re-parented in GitHub would fall
// back to its stale body if that record won. The sub-issue record has to outrank it.
test("the native record outranks the cross-referenced copy of the same slice", () => {
  const { reads } = tracker([
    issue({ number: 12 }),
    issue({ number: 94 }),
    issue({ number: 95, parent: 94, body: "## Parent\n\n#12\n" }),
    issue({ number: 13, parent: 12 }),
  ]);
  const gathered = gatherIssues(["agent/spec-12-x", "agent/spec-94-y"], reads);
  assert.equal(gathered.find((i) => i.number === 95)?.parent, 94);
});

// …and an unmigrated one still gets its slices, exactly as it did before issue #96.
test("a spec with no native children falls back to the scan", () => {
  const { reads, calls } = tracker([
    issue({ number: 94 }),
    issue({ number: 95, body: "## Parent\n\n#94\n" }),
  ]);
  const gathered = gatherIssues(["agent/spec-94-x"], reads);

  assert.equal(calls.scans, 1);
  assert.deepEqual(
    gathered.map((i) => i.number),
    [94, 95],
  );
});

test("one unmigrated spec among migrated ones brings the scan back for everyone", () => {
  const { reads, calls } = tracker([
    issue({ number: 12 }),
    issue({ number: 13, parent: 12 }),
    issue({ number: 94 }),
    issue({ number: 95, body: "## Parent\n\n#94\n" }),
  ]);
  const gathered = gatherIssues(["agent/spec-12-x", "agent/spec-94-y"], reads);

  assert.equal(calls.scans, 1);
  assert.deepEqual(
    gathered.map((i) => i.number).sort((a, b) => a - b),
    [12, 13, 94, 95],
  );
});

// The scan returns the natively-fetched children too; a doubled slice would render twice.
test("records fetched twice are gathered once", () => {
  const { reads } = tracker([
    issue({ number: 12 }),
    issue({ number: 13, parent: 12 }),
    issue({ number: 94 }),
    issue({ number: 95, body: "## Parent\n\n#94\n" }),
  ]);
  const gathered = gatherIssues(["agent/spec-12-x", "agent/spec-94-y"], reads);
  assert.equal(new Set(gathered.map((i) => i.number)).size, gathered.length);
});

// A branch outlives its spec by months. Its issue is still read — `buildSpecTree` needs
// the closed state to reject it — but its slices are not worth fetching.
test("a ghost branch's closed spec costs no sub-issue call", () => {
  const { reads, calls } = tracker([issue({ number: 94, state: "CLOSED" })]);
  gatherIssues(["agent/spec-94-x"], reads);

  assert.deepEqual(calls.issue, [94]);
  assert.deepEqual(calls.native, []);
  assert.equal(calls.scans, 0, "a repo whose only spec is finished reads nothing further");
});

test("a branch whose issue was deleted is skipped, not fatal", () => {
  const { reads } = tracker([]);
  assert.deepEqual(gatherIssues(["agent/spec-94-x"], reads), []);
});

test("a repo with no spec branches reads nothing at all", () => {
  const { reads, calls } = tracker([issue({ number: 94 })]);
  assert.deepEqual(gatherIssues(["main", "feat/x"], reads), []);
  assert.deepEqual(calls.issue, []);
  assert.equal(calls.scans, 0);
});
