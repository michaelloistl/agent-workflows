import { test } from "node:test";
import assert from "node:assert/strict";
import { unmetBlockers } from "./blocked-by.mts";
import type { BlockerRef, IssueState } from "./spec-tree.mts";

const OWN_REPO = "acme/widgets";
const url = (issue: number, repo = OWN_REPO) => `https://github.com/${repo}/issues/${issue}`;

// The guarded issue as the tracker hands it over: `## Blocked by` in the body, native
// dependency edges alongside it. `state` on a native edge mirrors `gh`, which serves the
// blocking issue's state in the same node as its number.
function guarded(
  textual: number[],
  native: Array<{ number: number; state?: IssueState; repo?: string }> = [],
): { body: string; url: string; blockedBy: BlockerRef[] } {
  const refs = textual.length ? textual.map((n) => `- #${n}`).join("\n") : "None";
  return {
    body: `## What to build\nA slice.\n\n## Blocked by\n${refs}`,
    url: url(1),
    blockedBy: native.map(({ number, state, repo }) => ({ number, state, url: url(number, repo) })),
  };
}

// What the caller learned from the issue list it already read; anything absent is a ref
// no read could resolve.
const states =
  (known: Record<number, IssueState>) =>
  (blocker: number): IssueState | null =>
    known[blocker] ?? null;

test("a still-open TEXTUAL blocker is unmet, exactly as before native edges existed", () => {
  const unmet = unmetBlockers(guarded([5, 6]), states({ 5: "OPEN", 6: "CLOSED" }));
  assert.deepEqual(unmet.open, [5]);
});

test("a still-open NATIVE blocker is unmet, though the body declares nothing", () => {
  const unmet = unmetBlockers(guarded([], [{ number: 7, state: "OPEN" }]), states({}));
  assert.deepEqual(unmet.open, [7]);
});

test("blockers all closed are met, whichever source declared them", () => {
  const unmet = unmetBlockers(
    guarded([5], [{ number: 7, state: "CLOSED" }]),
    states({ 5: "CLOSED" }),
  );
  assert.deepEqual(unmet.open, []);
});

// The MIXED case a migrating repo is in: one blocker declared each way. Whichever is open
// gates the slice — the union, not one source winning.
test("a mixed declaration is unmet on whichever blocker is still open", () => {
  const closedTextually = unmetBlockers(
    guarded([5], [{ number: 7, state: "OPEN" }]),
    states({ 5: "CLOSED" }),
  );
  assert.deepEqual(closedTextually.open, [7]);

  const closedNatively = unmetBlockers(
    guarded([5], [{ number: 7, state: "CLOSED" }]),
    states({ 5: "OPEN" }),
  );
  assert.deepEqual(closedNatively.open, [5]);
});

// The two sources agreeing must not name the blocker twice in the refusal.
test("a blocker declared BOTH ways is named once", () => {
  const unmet = unmetBlockers(guarded([5], [{ number: 5, state: "OPEN" }]), states({ 5: "OPEN" }));
  assert.deepEqual(unmet.open, [5]);
});

// The state rides the native edge, so it is believed over a lookup that disagrees: the
// caller's map is a page of a paged read, and a blocker past the end of it must not read
// as "unresolvable" and quietly stop gating.
test("a native blocker's own state wins over a lookup that disagrees", () => {
  const stale = unmetBlockers(guarded([], [{ number: 7, state: "OPEN" }]), states({ 7: "CLOSED" }));
  assert.deepEqual(stale.open, [7]);

  const closed = unmetBlockers(guarded([], [{ number: 7, state: "CLOSED" }]), states({ 7: "OPEN" }));
  assert.deepEqual(closed.open, []);
});

// An edge the read did not project falls through to the lookup rather than to "unknown".
test("a native blocker carrying no state falls back to the lookup", () => {
  const unmet = unmetBlockers(guarded([], [{ number: 7 }]), states({ 7: "OPEN" }));
  assert.deepEqual(unmet.open, [7]);
});

// Today's behaviour, preserved: the old guard read each ref with `gh` and treated a failed
// read — a PR number, a deleted issue, a `#12` that never was one — as not blocking.
test("a ref no read can resolve does not block", () => {
  const unmet = unmetBlockers(guarded([5, 999]), states({ 5: "CLOSED" }));
  assert.deepEqual(unmet.open, []);
});

// Numbers are per-repo, so an OPEN blocker over there must not be read as this repo's #12.
// Excluded from the decision — and named, because nothing closed here will ever clear it.
test("a native blocker in another repository does not block, and is named", () => {
  const unmet = unmetBlockers(
    guarded([], [{ number: 12, state: "OPEN", repo: "other/repo" }]),
    states({ 12: "OPEN" }),
  );
  assert.deepEqual(unmet.open, []);
  assert.deepEqual(unmet.foreign, ["other/repo#12"]);
});

// A cross-repo blocker that has closed was never a wait. Naming it anyway would put the
// same warning in the log on every run of that slice from then on.
test("a CLOSED blocker in another repository is not named", () => {
  const unmet = unmetBlockers(
    guarded([], [{ number: 12, state: "CLOSED", repo: "other/repo" }]),
    states({}),
  );
  assert.deepEqual(unmet.foreign, []);
});

// State is what decides, so an edge that did not carry one is named: an exclusion that
// cannot be ruled out is worth a line.
test("a blocker in another repository with no state is named", () => {
  const unmet = unmetBlockers(guarded([], [{ number: 12, repo: "other/repo" }]), states({}));
  assert.deepEqual(unmet.foreign, ["other/repo#12"]);
});

test("an issue with no blockers at all is met, and names nothing", () => {
  const unmet = unmetBlockers(guarded([]), states({}));
  assert.deepEqual(unmet.open, []);
  assert.deepEqual(unmet.foreign, []);
});

// The union rule takes the body alone when the read carried no native edges, which is what
// a repo on an older host — or one that has adopted nothing — looks like.
test("an unset native edge list reduces the rule to the body", () => {
  const unmet = unmetBlockers({ body: "## Blocked by\n- #5", url: url(1) }, states({ 5: "OPEN" }));
  assert.deepEqual(unmet.open, [5]);
});
