// The `implement` blocked-by guard's decision (issue #100): given one issue's dependency
// declarations and a way to learn a blocker's state, which blockers are still open. PURE —
// no `gh`; `guards.mts` reads and refuses, this decides.
//
// It exists so the guard stops re-parsing `## Blocked by` with a private copy of the ref
// regex. That private parse was the last place dependency edges were read a second way, so
// a slice blocked NATIVELY but not textually walked straight past the gate. This is defence
// in depth rather than an open hole — `nextSlice` already declines to hand out a natively
// blocked slice — but the guard is the only thing in front of a run a human names directly,
// on the attended and manual paths, and it is the only reader that honours a blocker which
// is not a tracer-bullet of the same spec (ADR-0007).

import {
  foreignBlockerLabel,
  foreignBlockers,
  sameRepoBlockers,
  unionBlockers,
} from "./spec-tree.mts";
import type { BlockedBySources, IssueState } from "./spec-tree.mts";

// Both halves are blockers this issue is still waiting on; what separates them is whether
// this repo can do anything about it.
export interface UnmetBlockers {
  // Blockers in this repo that are still open — the reason to refuse, named for it.
  readonly open: readonly number[];
  // Still-open blockers the union declined to gate on because they live in another
  // repository, as `owner/name#12`. Not a refusal: nothing closed here would ever clear
  // them, so the guard says so and lets the run start rather than parking the slice
  // forever. A foreign blocker that has already CLOSED is not here — it is not a wait, and
  // reporting it would make the note noise on every run of the slice from then on.
  readonly foreign: readonly string[];
}

// `stateOf` returns null for a ref no read could resolve — a PR number, a deleted issue, a
// `#12` that never was one. Such a ref does NOT block, which is what the per-ref `gh` read
// this replaced did with a failure, and the behaviour a body full of loose refs relies on.
//
// A native edge carries its blocker's state, so it is believed ahead of the lookup: the
// caller's state map comes from a paged issue list, and a blocker past the end of that page
// must not read as "unresolvable" and quietly stop gating.
export function unmetBlockers(
  issue: BlockedBySources,
  stateOf: (blocker: number) => IssueState | null,
): UnmetBlockers {
  const carried = new Map<number, IssueState>();
  for (const ref of sameRepoBlockers(issue)) {
    if (ref.state) carried.set(ref.number, ref.state);
  }
  return {
    open: unionBlockers(issue).filter((n) => (carried.get(n) ?? stateOf(n)) === "OPEN"),
    // Named the way every other surface names one, not a second spelling. A blocker whose
    // state the edge did not carry is reported: an exclusion that cannot be ruled out is
    // worth a line, which is the same conservative side the union itself takes.
    foreign: foreignBlockers(issue)
      .filter((ref) => ref.state !== "CLOSED")
      .map(foreignBlockerLabel),
  };
}
