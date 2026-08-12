// The shared reader behind the STATUS VIEW (ADR-0007): given a repo's issues and its
// remote branch names, which specs are in flight and what state each of their
// tracer-bullets is in. Pure — no `gh`, no `git`. `spec-tracker.mts` fetches the raw
// records; this decides what they mean, and `status/render.mts` decides how they look.
//
// It is deliberately NOT private to the status view. The orchestrator resolves the same
// tree today through `spec-graph`, and when native sub-issue parents are WRITTEN rather
// than merely read (issue #96 pilots the read) it migrates onto this reader — a pilot
// running on its own private reader would prove nothing about the code that matters.
//
// Discovery is by BRANCH, not by label: `kickoff` removes `agent:implement-spec` the
// moment it fires, so no label distinguishes a running spec, and walking up from
// labelled slices cannot see a spec whose slices have ALL closed — which is precisely
// the state most in need of a human. An open spec issue with a live `agent/spec-*`
// branch is exactly the in-flight set; requiring the ISSUE to be open excludes the
// ghost branches that outlive a finished spec.

import { blockedByRefs, orderWithDeadlocked, parentRef, tracerBullets } from "./spec-graph.mts";
import { pickSpecBranch } from "./spec-context.mts";

// One NATIVE dependency edge as the tracker serves it: the blocking issue's number and
// its URL. The URL is not decoration — it is the only thing in the payload that says
// which REPOSITORY the number belongs to, and numbers are per-repo.
export interface BlockerRef {
  readonly number: number;
  readonly url: string;
}

// One issue as the tracker hands it over. `labels` is label NAMES only — the view
// never reads a triage label (`ready-for-agent` here, `ready-for-afk` elsewhere), so
// that drift cannot reach it.
export interface IssueRecord {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
  readonly labels: readonly string[];
  readonly url: string;
  // The NATIVE sub-issue parent, where the tracker has one. Absent (or null) in a repo
  // that has not adopted the hierarchy — which is what `resolveParent` falls back for.
  readonly parent?: number | null;
  // The NATIVE dependency edges, where the tracker has them. Absent on a read that does
  // not ask for them; empty on an issue that declares none.
  readonly blockedBy?: readonly BlockerRef[] | null;
  // How many native edges the tracker says there are, from a read that serves the COUNT
  // but not the edges (REST does exactly that). It is what tells an unset `blockedBy`
  // apart: "not read" rather than "none declared".
  readonly blockedByCount?: number;
}

// What the blocker rules need to see, which is less than a full record: the slim issue
// list the orchestrator makes satisfies it as readily as the status view's record, so
// both consumers pass their own reads straight in.
export interface BlockedBySources {
  readonly body: string;
  // The issue's OWN url, i.e. the repo a bare `#N` means here.
  readonly url: string;
  readonly blockedBy?: readonly BlockerRef[] | null;
}

// The MEMBERSHIP rule (issue #96): a slice's spec is its native sub-issue parent where
// that edge exists, and its textual `## Parent` reference otherwise. Native wins per slice,
// so a repo can adopt the hierarchy gradually instead of on a flag day, and the view is
// never silently empty in a repo that has not caught up.
//
// It lives here, in the shared reader, rather than in the status view: the orchestrator
// resolves the same tree textually today (`spec-graph.tracerBullets`) and adopts this
// rule when native parents are WRITTEN rather than merely read — a second implementation
// is exactly what that migration must not need.
//
// The native sub-issue PRIORITY order is never displayed; ordering is the dependency
// rule below, which is a union rather than a fallback.
export function resolveParent(issue: IssueRecord): number | null {
  return issue.parent ?? parentRef(issue.body);
}

// The dependency rule (issue #99): a slice's blockers are the UNION of its native
// `blockedBy` edges and the refs in its body's `## Blocked by`. Deliberately not the
// `native ?? textual` fallback above, and named so it cannot be read as one.
//
// Parent is a single value, so preferring the native one is safe. Blockers are a set,
// and the two ways of being wrong are not symmetric: over-blocking surfaces as a
// deadlocked row a human reads and clears, while under-blocking silently builds a slice
// on top of a dependency that has not landed. The union is the conservative side of that
// asymmetry, so a spec fully native, fully textual, or partway between all yield one
// correct build order and adopting native dependencies stays gradual and per-repo.
export function unionBlockers(issue: BlockedBySources): number[] {
  const { sameRepo } = partitionBlockers(issue);
  return [...new Set([...blockedByRefs(issue.body), ...sameRepo.map((ref) => ref.number)])];
}

// The native blockers that live in ANOTHER repository. They are excluded from the union
// because issue numbers are per-repo — `#12` over there is a different issue from `#12`
// here, and gating this spec's slice 12 on it would reorder the build around a
// coincidence. Excluded is not dropped: a slice waiting on another repo is waiting on
// something no local close will ever clear, so the caller surfaces these.
export function foreignBlockers(issue: BlockedBySources): BlockerRef[] {
  return partitionBlockers(issue).foreign;
}

// The dependency half of the edge rules, ready to hand to `tracerBullets`: the union and
// the exclusions it made. Every ordering consumer passes this — the status view adds
// native membership on top of it, the orchestrator keeps the textual parent — so the two
// cannot drift into different rules.
export const DEPENDENCY_EDGES = {
  blockersOf: unionBlockers,
  foreignBlockersOf: (issue: BlockedBySources) => foreignBlockers(issue).map(foreignBlockerLabel),
};

function partitionBlockers(issue: BlockedBySources): {
  sameRepo: BlockerRef[];
  foreign: BlockerRef[];
} {
  const own = repoOfIssueUrl(issue.url);
  const sameRepo: BlockerRef[] = [];
  const foreign: BlockerRef[] = [];
  for (const ref of issue.blockedBy ?? []) {
    const repo = repoOfIssueUrl(ref.url);
    // Only a repo that is legibly DIFFERENT is foreign. A URL neither side can parse
    // says nothing either way, and the union is the conservative reading of nothing.
    if (own !== null && repo !== null && repo !== own) foreign.push(ref);
    else sameRepo.push(ref);
  }
  return { sameRepo, foreign };
}

// The `owner/name` in an issue URL (`https://host/owner/name/issues/12`), or null. Not
// `repoFromRemoteUrl`: that parses a git REMOTE, which ends at the repo. Lower-cased,
// because GitHub slugs are case-insensitive and two reads can disagree on the casing —
// which would otherwise read as another repo and drop a local blocker from the order.
function repoOfIssueUrl(url: string): string | null {
  const slug = /^https?:\/\/[^/]+\/(?<slug>[^/]+\/[^/]+)\/issues\/\d+/.exec(url)?.groups?.slug;
  return slug?.toLowerCase() ?? null;
}

// How a foreign blocker is named once it leaves the number space it came from: bare
// `#12` would read as this repo's #12, which is the confusion the exclusion exists for.
function foreignBlockerLabel(ref: BlockerRef): string {
  const repo = repoOfIssueUrl(ref.url);
  return repo === null ? ref.url : `${repo}#${ref.number}`;
}

// A tracer-bullet's state, from its issue state and `agent:*` labels ONLY — no PR or
// check-run join (ADR-0007).
export type SliceState = "done" | "building" | "review" | "blocked" | "pending";

export interface SliceNode {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: SliceState;
  // Left out of the topological order, i.e. in a dependency cycle. Orthogonal to
  // `state`, which stays what the tracker says; the renderer flags it either way.
  readonly cycle: boolean;
  // Native blockers in another repository, as `owner/name#12` (see `foreignBlockers`).
  // Left out of the ordering and shown instead, because nothing in this repo will ever
  // close them.
  readonly foreignBlockers: readonly string[];
}

// `awaiting-final-pr`: every slice closed while the spec issue is still open — the
// spec branch holds the whole feature and the one human gate is the final
// spec→default PR.
export type SpecState = "building" | "awaiting-final-pr";

export interface SpecNode {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly branch: string;
  readonly state: SpecState;
  readonly closed: number;
  readonly total: number;
  readonly slices: readonly SliceNode[];
}

// Loudest first: a slice that is both closed and still carrying a stale state label is
// done, and `agent:blocked` outranks the rest because it is the one state that means
// stop and look.
function sliceState(issue: IssueRecord): SliceState {
  if (issue.state === "CLOSED") return "done";
  if (issue.labels.includes("agent:blocked")) return "blocked";
  if (issue.labels.includes("agent:in-progress")) return "building";
  if (issue.labels.includes("agent:review")) return "review";
  return "pending";
}

export function buildSpecTree(
  issues: readonly IssueRecord[],
  branches: readonly string[],
): SpecNode[] {
  const byNumber = new Map(issues.map((i) => [i.number, i]));

  return issues
    .filter((i) => i.state === "OPEN")
    .map((i) => ({ issue: i, branch: pickSpecBranch(i.number, branches) }))
    .filter((c): c is { issue: IssueRecord; branch: string } => c.branch !== null)
    .sort((a, b) => a.issue.number - b.issue.number)
    .map(({ issue, branch }) => {
      const bullets = tracerBullets(issue.number, issues, {
        parentOf: resolveParent,
        ...DEPENDENCY_EDGES,
      });
      // Deadlocked slices go last rather than vanishing: the orchestrator will never
      // dispatch them, which is exactly why they have to show.
      const { ordered, deadlocked } = orderWithDeadlocked(bullets);
      const inOrder = new Set(ordered);
      const cycled = [...deadlocked].sort((a, b) => a - b);
      const edgesOf = new Map(bullets.map((b) => [b.number, b]));

      const slices = [...ordered, ...cycled].map((n): SliceNode => {
        const bullet = byNumber.get(n)!;
        return {
          number: n,
          title: bullet.title,
          url: bullet.url,
          state: sliceState(bullet),
          cycle: !inOrder.has(n),
          // Taken from the edge rules rather than recomputed, so the row can only ever
          // name what the ordering actually left out.
          foreignBlockers: edgesOf.get(n)?.foreignBlockers ?? [],
        };
      });

      const closed = slices.filter((s) => s.state === "done").length;
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        branch,
        // Guarded against vacuous truth: a spec with no slices at all has not finished
        // them, it has none.
        state: slices.length > 0 && closed === slices.length ? "awaiting-final-pr" : "building",
        closed,
        total: slices.length,
        slices,
      } satisfies SpecNode;
    });
}
