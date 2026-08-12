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
      return issues.filter((i) => i.parent === spec);
    },
    crossReferencedIssues: (spec) => {
      calls.refs.push(spec);
      return issues
        .filter((i) => i.body.includes(`#${spec}`))
        .map(({ parent: _native, ...rest }) => rest);
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
