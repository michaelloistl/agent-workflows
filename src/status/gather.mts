// Which issues the STATUS VIEW has to read, and in what order, to resolve its tree
// (issue #96). The decide half of the decide/dispatch split: `spec-tracker.mts` owns the
// `gh` calls, this owns the strategy, and `spec-tree.mts` turns the result into a tree.
// Split out of the entry point because the strategy has a real bug surface — a missed
// fallback loses slices, a missed de-duplication doubles them — and an entry point that
// runs on import cannot be tested.
//
// Native-first: discovery is by branch, so the branches come first and every issue read
// follows from them. A point read per spec, then per open spec its sub-issues — closed
// ones included, which is the whole reason the full-repo scan can be skipped at all —
// and, for a spec that has them, its cross-references, which catch the slices that are
// still only textual. The scan is what is left for a repo with no native hierarchy — and
// for a spec whose slices declare native dependency edges, since the issue-list read is
// the only one that carries them (issue #99).

import { specNumberFromBranch } from "../shared/spec-context.mts";
import type { IssueRecord } from "../shared/spec-tree.mts";

// The tracker reads this needs, named rather than imported so the strategy can be
// exercised without a network. `allIssues` is the expensive one and is called lazily.
export interface TrackerReads {
  readonly issueRecord: (number: number) => IssueRecord | null;
  readonly nativeSubIssues: (spec: number) => IssueRecord[];
  readonly crossReferencedIssues: (spec: number) => IssueRecord[];
  readonly allIssues: () => IssueRecord[];
}

export function gatherIssues(
  branches: readonly string[],
  reads: TrackerReads,
): IssueRecord[] {
  const specNumbers = [
    ...new Set(branches.map(specNumberFromBranch).filter((n): n is number => n !== null)),
  ];
  const specs = specNumbers
    .map((n) => reads.issueRecord(n))
    .filter((record): record is IssueRecord => record !== null);

  // A ghost branch outlives its spec and `buildSpecTree` drops it, so only an OPEN spec
  // is worth further reads.
  const open = specs.filter((record) => record.state === "OPEN");
  const native = open.flatMap((spec) => reads.nativeSubIssues(spec.number));
  const withNativeChildren = new Set(native.map((child) => child.parent));

  // A migrated spec still needs its TEXTUAL children — a slice added since the last sync
  // carries a `## Parent` reference and no native edge yet, and dropping it would put a
  // wrong count and a wrong "next" row on screen. Its own timeline finds them without a
  // scan: the reference is an event on the spec issue. Only migrated specs need this;
  // for the rest the scan below is a superset of it.
  const referencing = open
    .filter((spec) => withNativeChildren.has(spec.number))
    .flatMap((spec) => reads.crossReferencedIssues(spec.number));

  // A native record carries a blocker COUNT and no edges (issue #99) — REST serves no
  // more than that — so a non-zero count on a slice is the tracker telling us about edges
  // this read cannot hand over. They live on the issue-list read, so that is what pays
  // for them: one scan, never a request per slice, and only for a spec that really does
  // declare native dependencies. Unseen, they would UNDER-block the order.
  // Both REST reads, not just the sub-issue one: a textually-parented slice on a migrated
  // spec arrives through the timeline and can declare native blockers just the same.
  const edgesUnread = [...native, ...referencing].some(
    (child) => (child.blockedByCount ?? 0) > 0 && !child.blockedBy,
  );

  // The full-repo scan is otherwise the last resort, for a spec with no native hierarchy
  // at all: the timeline read is newer and less proven, so an unmigrated repo keeps the
  // path it has always rendered from rather than changing behaviour under it.
  const scanned =
    !edgesUnread && open.every((spec) => withNativeChildren.has(spec.number))
      ? []
      : reads.allIssues();

  // The later reads re-fetch what the earlier ones already have. First wins, so the
  // record that carries the native parent edge outranks the copies that do not —
  // native parentage decides membership wherever the two sources disagree.
  //
  // Dependency edges are the exception, because they are the one field the REST reads do
  // not serve at all (issue #99: they carry a blocker COUNT and no edges). They are taken
  // from the first record that HAS them instead — an empty array is an answer, `undefined`
  // is a read that never asked. Dropping them with the losing record would under-block a
  // slice, which is the failure mode the union exists to avoid.
  const byNumber = new Map<number, IssueRecord>();
  for (const record of [...specs, ...native, ...referencing, ...scanned]) {
    const seen = byNumber.get(record.number);
    if (seen === undefined) byNumber.set(record.number, record);
    else if (!seen.blockedBy && record.blockedBy) {
      byNumber.set(record.number, { ...seen, blockedBy: record.blockedBy });
    }
  }
  return [...byNumber.values()];
}
