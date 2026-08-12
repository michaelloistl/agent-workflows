import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSpecTree,
  foreignBlockers,
  resolveParent,
  sameRepoBlockers,
  unionBlockers,
  type BlockerRef,
  type IssueRecord,
} from "./spec-tree.mts";

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

// A slice as a repo that has NOT adopted native hierarchy hands it over: parentage is a
// `## Parent` reference in the body. `over.body` carries the blockers, if any.
function slice(number: number, spec: number, over: Partial<IssueRecord> = {}): IssueRecord {
  const blockedBy = (over.body ?? "").trim();
  return issue({
    number,
    ...over,
    body: `## Parent\n\n#${spec}\n\n## Blocked by\n\n${blockedBy || "None"}\n`,
  });
}

// The same slice as a MIGRATED repo hands it over: the parent edge is the native
// sub-issue relationship and the body says nothing about a parent. Its blockers may be
// native too — pass `blockedBy` (issue #99) — or stay in the body, or be both.
function nativeSlice(
  number: number,
  spec: number,
  over: Partial<IssueRecord> = {},
): IssueRecord {
  const blockedBy = (over.body ?? "").trim();
  return issue({
    number,
    ...over,
    parent: spec,
    body: `## Blocked by\n\n${blockedBy || "None"}\n`,
  });
}

test("a spec is an open issue with a live spec branch", () => {
  const specs = buildSpecTree(
    [issue({ number: 94, title: "Status view" }), slice(95, 94)],
    ["main", "agent/spec-94-status-view"],
  );
  assert.equal(specs.length, 1);
  assert.equal(specs[0].number, 94);
  assert.equal(specs[0].title, "Status view");
  assert.equal(specs[0].branch, "agent/spec-94-status-view");
  assert.equal(specs[0].url, "https://github.com/o/r/issues/94");
});

// The branch outlives the issue: a finished spec's `agent/spec-*` ref lingers on the
// remote for months. Requiring the ISSUE to be open is what excludes those ghosts.
test("a closed spec whose branch lingers is not in flight", () => {
  const specs = buildSpecTree(
    [issue({ number: 94, state: "CLOSED" }), slice(95, 94, { state: "CLOSED" })],
    ["agent/spec-94-status-view"],
  );
  assert.deepEqual(specs, []);
});

// A branch only exists after kickoff, so an open spec without one has not started.
test("an open spec with no branch has not been kicked off", () => {
  const specs = buildSpecTree([issue({ number: 94 }), slice(95, 94)], ["main"]);
  assert.deepEqual(specs, []);
});

test("slices are its tracer-bullets, closed ones included", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      slice(95, 94, { state: "CLOSED" }),
      slice(96, 94),
      slice(97, 12), // another spec's slice
      issue({ number: 98 }), // no parent at all
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96],
  );
});

test("slices are ordered topologically from ## Blocked by", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      slice(96, 94, { body: "#95" }),
      slice(97, 94, { body: "#96" }),
      slice(95, 94),
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96, 97],
  );
});

test("slice state comes from issue state and agent:* labels only", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      slice(95, 94, { state: "CLOSED" }),
      slice(96, 94, { labels: ["agent:in-progress"] }),
      slice(97, 94, { labels: ["agent:review"] }),
      slice(98, 94, { labels: ["agent:blocked"] }),
      slice(99, 94, { labels: ["ready-for-agent"] }),
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.state),
    ["done", "building", "review", "blocked", "pending"],
  );
});

// A closed slice is done even if a state label was left behind on it.
test("closed beats any lingering state label", () => {
  const [spec] = buildSpecTree(
    [issue({ number: 94 }), slice(95, 94, { state: "CLOSED", labels: ["agent:in-progress"] })],
    ["agent/spec-94-x"],
  );
  assert.equal(spec.slices[0].state, "done");
});

test("a spec carries its progress count", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      slice(95, 94, { state: "CLOSED" }),
      slice(96, 94, { state: "CLOSED" }),
      slice(97, 94),
    ],
    ["agent/spec-94-x"],
  );
  assert.equal(spec.closed, 2);
  assert.equal(spec.total, 3);
  assert.equal(spec.state, "building");
});

// The moment a spec needs a human is the moment it must not disappear.
test("a spec whose slices have all closed awaits its final PR", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      slice(95, 94, { state: "CLOSED" }),
      slice(96, 94, { state: "CLOSED" }),
    ],
    ["agent/spec-94-x"],
  );
  assert.equal(spec.state, "awaiting-final-pr");
  assert.equal(spec.closed, 2);
  assert.equal(spec.total, 2);
});

// Vacuous truth would otherwise report a spec that has no slices at all as finished.
test("a spec with no slices is building, not awaiting its final PR", () => {
  const [spec] = buildSpecTree([issue({ number: 94 })], ["agent/spec-94-x"]);
  assert.equal(spec.state, "building");
  assert.deepEqual(spec.slices, []);
});

test("slices in a dependency cycle are surfaced, not dropped", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      slice(95, 94),
      slice(96, 94, { body: "#97" }),
      slice(97, 94, { body: "#96" }),
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96, 97],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.cycle),
    [false, true, true],
  );
});

test("every node carries its issue URL and title", () => {
  const [spec] = buildSpecTree(
    [issue({ number: 94 }), slice(95, 94, { title: "Walking skeleton" })],
    ["agent/spec-94-x"],
  );
  assert.equal(spec.slices[0].title, "Walking skeleton");
  assert.equal(spec.slices[0].url, "https://github.com/o/r/issues/95");
});

// --- Native-first parent resolution (issue #96) ---------------------------------
//
// Membership resolves as `native parent ?? textual ## Parent`, per slice. That makes
// adopting GitHub's sub-issue hierarchy gradual and per-repo rather than a flag day:
// a migrated repo, an unmigrated one, and one partway through all render one tree.

test("a slice claims its spec through the native parent alone, with no ## Parent section", () => {
  const [spec] = buildSpecTree(
    [issue({ number: 94 }), nativeSlice(95, 94), nativeSlice(96, 94)],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96],
  );
  assert.equal(spec.total, 2);
});

// The point of "native-first": where the two disagree, the tracker's own edge is the
// truth and the body is the stale copy — a slice re-parented in GitHub moves.
test("a native parent wins over a disagreeing ## Parent", () => {
  const specs = buildSpecTree(
    [
      issue({ number: 94 }),
      issue({ number: 12 }),
      { ...slice(95, 12), parent: 94 },
    ],
    ["agent/spec-94-x", "agent/spec-12-y"],
  );
  assert.deepEqual(
    specs.map((s) => [s.number, s.slices.map((sl) => sl.number)]),
    [
      [12, []],
      [94, [95]],
    ],
  );
});

// Mid-migration: some slices carry the native edge, others only the body. One tree.
test("native and textual slices of one spec resolve into a single tree", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      nativeSlice(95, 94),
      slice(96, 94, { body: "#95" }),
      nativeSlice(97, 94, { body: "#96" }),
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96, 97],
  );
});

// The native sub-issue PRIORITY order is never displayed: order comes from the
// dependency edges even when every membership edge is native, and a spec that declares
// none natively keeps ordering from `## Blocked by` alone. Input order here is the
// reverse of the build order.
test("native membership does not change where the build order comes from", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      nativeSlice(97, 94, { body: "#96" }),
      nativeSlice(96, 94, { body: "#95" }),
      nativeSlice(95, 94),
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96, 97],
  );
});

test("resolveParent prefers the native edge and falls back to the body", () => {
  assert.equal(resolveParent(nativeSlice(95, 94)), 94);
  assert.equal(resolveParent(slice(95, 94)), 94);
  assert.equal(resolveParent({ ...slice(95, 12), parent: 94 }), 94);
  assert.equal(resolveParent(issue({ number: 95 })), null);
  // An explicit "no native parent" is a fallback, not an answer.
  assert.equal(resolveParent({ ...slice(95, 94), parent: null }), 94);
});

// --- Dependency edges: native `blockedBy` ∪ textual `## Blocked by` (issue #99) -----
//
// Deliberately NOT the parent rule above. A parent is a single value, so preferring the
// native one is safe. Blockers are a SET, and the two ways of getting it wrong are not
// symmetric: over-blocking surfaces as a deadlocked row a human reads and clears, while
// under-blocking silently builds a slice on top of a dependency that has not landed. So
// the two sources are unioned, and neither ever overrides the other.

function nativeBlockers(...numbers: number[]): BlockerRef[] {
  return numbers.map((number) => ({
    number,
    url: `https://github.com/o/r/issues/${number}`,
  }));
}

test("a fully-textual slice's blockers are its ## Blocked by refs, as before", () => {
  assert.deepEqual(unionBlockers(slice(97, 94, { body: "#95 #96" })), [95, 96]);
  assert.deepEqual(unionBlockers(slice(97, 94)), []);
});

test("a fully-native slice's blockers are its blockedBy edges, with no section to parse", () => {
  assert.deepEqual(unionBlockers(nativeSlice(97, 94, { blockedBy: nativeBlockers(95, 96) })), [
    95, 96,
  ]);
  assert.deepEqual(unionBlockers(nativeSlice(97, 94)), []);
});

test("where the two sources disagree, both edges are kept", () => {
  const both = slice(97, 94, { body: "#95", blockedBy: nativeBlockers(96) });
  assert.deepEqual([...unionBlockers(both)].sort(), [95, 96]);
});

test("a blocker declared in both sources is one edge, not two", () => {
  assert.deepEqual(unionBlockers(slice(97, 94, { body: "#95", blockedBy: nativeBlockers(95) })), [
    95,
  ]);
});

// Issue numbers are per-repo: `#96` over there is a different issue from `#96` here, so
// ordering around one would reorder the build on a coincidence.
test("a native blocker in another repository is excluded from the union, and surfaced", () => {
  const elsewhere: BlockerRef = {
    number: 96,
    url: "https://github.com/other/repo/issues/96",
  };
  const waiting = slice(95, 94, { blockedBy: [elsewhere, ...nativeBlockers(93)] });
  assert.deepEqual(unionBlockers(waiting), [93]);
  assert.deepEqual(foreignBlockers(waiting), [elsewhere]);
  assert.deepEqual(foreignBlockers(slice(95, 94, { blockedBy: nativeBlockers(93) })), []);
});

// The same partition read the other way round, whole rather than reduced to numbers: what
// a native edge carries beyond its number — the blocker's state — reaches the `implement`
// guard only through the rule that decided the edge was ours in the first place.
test("the same-repo native blockers are the union's native arm, with what they carry", () => {
  const elsewhere: BlockerRef = { number: 96, url: "https://github.com/other/repo/issues/96" };
  const open: BlockerRef = { number: 93, url: "https://github.com/o/r/issues/93", state: "OPEN" };
  assert.deepEqual(sameRepoBlockers(slice(95, 94, { blockedBy: [elsewhere, open] })), [open]);
  assert.deepEqual(sameRepoBlockers(slice(95, 94)), []);
});

// GitHub slugs are case-insensitive, and two reads can disagree on the casing. Reading
// that as another repository would drop a local blocker from the order.
test("a blocker whose URL differs only in case is the same repository", () => {
  const shouty: BlockerRef = { number: 96, url: "https://github.com/O/R/issues/96" };
  const waiting = slice(95, 94, { blockedBy: [shouty] });
  assert.deepEqual(unionBlockers(waiting), [96]);
  assert.deepEqual(foreignBlockers(waiting), []);
});

test("slices order from native blockedBy alone", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      nativeSlice(97, 94, { blockedBy: nativeBlockers(96) }),
      nativeSlice(96, 94, { blockedBy: nativeBlockers(95) }),
      nativeSlice(95, 94),
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96, 97],
  );
});

// The migration is per-slice, so a spec partway through it has both kinds of edge in one
// chain — and it has to come out as ONE sequence, not two half-orders.
test("a spec partway through the migration orders as one sequence", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      slice(98, 94, { body: "#97" }),
      nativeSlice(97, 94, { blockedBy: nativeBlockers(96) }),
      slice(96, 94, { body: "#95" }),
      nativeSlice(95, 94),
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96, 97, 98],
  );
});

// The number-space collision, ordered: `other/repo#96` must not gate this repo's #96.
test("a foreign blocker leaves the build order alone and shows on the row", () => {
  const [spec] = buildSpecTree(
    [
      issue({ number: 94 }),
      slice(95, 94, {
        blockedBy: [{ number: 96, url: "https://github.com/other/repo/issues/96" }],
      }),
      slice(96, 94),
    ],
    ["agent/spec-94-x"],
  );
  assert.deepEqual(
    spec.slices.map((s) => s.number),
    [95, 96],
  );
  assert.deepEqual(spec.slices[0].foreignBlockers, ["other/repo#96"]);
  assert.deepEqual(spec.slices[1].foreignBlockers, []);
});

test("specs are listed in issue-number order", () => {
  const specs = buildSpecTree(
    [issue({ number: 94 }), issue({ number: 12 })],
    ["agent/spec-94-x", "agent/spec-12-y"],
  );
  assert.deepEqual(
    specs.map((s) => s.number),
    [12, 94],
  );
});
