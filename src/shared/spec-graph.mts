// The decision core of the `implement-spec` orchestrator (CONTEXT.md). Pure
// functions over raw issue bodies and numbers — no `gh`, no GitHub. The
// guards/kickoff/advance hooks are thin shells: they fetch raw bodies via `gh`,
// call in here, and act on the result.
//
// A tracer-bullet links to its spec via a textual `## Parent` reference and to its
// blockers via `## Blocked by`; nothing the fleet writes is a native sub-issue, because
// the `implement` issue-shape guard refuses those. The body is this module's DEFAULT for
// both edges, not its only rule: `tracerBullets` takes a resolver for each, so a caller
// reading the tracker's own relationships supplies them (`spec-tree.resolveParent`,
// `spec-tree.unionBlockers`) and the two edges are wired the same way rather than one
// being special. Orchestration is strictly sequential (ADR-0003): only `nextSlice`
// matters operationally, and `topologicalOrder` is just `nextSlice` applied until done.

import { section } from "./markdown.mts";

export interface IssueInput {
  number: number;
  body: string;
}

export interface TracerBullet {
  number: number;
  blockedBy: number[];
  // Blockers the rules DECLINED to order on, already named (`owner/name#12`, GitHub's own
  // cross-repo reference syntax — not a rendering choice, the only unambiguous way to
  // write an issue from another number space). Present only when there are any, so the
  // common bullet keeps its two-field shape. Every surface shows them: an edge dropped in
  // silence is the one thing a build order must not do.
  foreignBlockers?: readonly string[];
}

// Every `#N` reference within a section, in order, de-duplicated.
function refsIn(body: string, heading: string): number[] {
  const refs = [...section(body, heading).matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  return [...new Set(refs)];
}

// The spec number referenced in a tracer-bullet's `## Parent` section, or null.
export function parentRef(body: string): number | null {
  return refsIn(body, "parent")[0] ?? null;
}

// The issue numbers referenced in a tracer-bullet's `## Blocked by` section.
export function blockedByRefs(body: string): number[] {
  return refsIn(body, "blocked by");
}

// How a candidate's two edges are resolved. Each defaults to the body — the
// orchestrator's original rule — and each is overridable on its own, so a repo partway
// through adopting the tracker's native relationships is described by the pair rather
// than by a mode.
export interface EdgeRules<T> {
  // Membership: which spec this candidate belongs to. Defaults to `## Parent`.
  readonly parentOf?: (candidate: T) => number | null;
  // Ordering: which issues gate it. Defaults to `## Blocked by`.
  readonly blockersOf?: (candidate: T) => number[];
  // What `blockersOf` left out and why the caller could not order on it. Defaults to
  // nothing, since a body parse excludes nothing.
  readonly foreignBlockersOf?: (candidate: T) => string[];
}

// The tracer-bullets of `spec`: the candidates parented to it, with their blocked-by
// edges. Order follows the input.
//
// Both surfaces call this — the status view and the orchestrator — so there is ONE
// implementation of membership-plus-edges and the rules are what differ. The status view
// passes the native-first parent (`spec-tree.resolveParent`); both pass the blocker union
// (`spec-tree.unionBlockers`), because a slice blocked natively is blocked for the
// orchestrator too.
export function tracerBullets<T extends IssueInput>(
  spec: number,
  candidates: readonly T[],
  edges: EdgeRules<T> = {},
): TracerBullet[] {
  const parentOf = edges.parentOf ?? ((c: T) => parentRef(c.body));
  const blockersOf = edges.blockersOf ?? ((c: T) => blockedByRefs(c.body));
  const foreignBlockersOf = edges.foreignBlockersOf ?? (() => []);
  return candidates
    .filter((c) => parentOf(c) === spec)
    .map((c) => {
      const foreign = foreignBlockersOf(c);
      return {
        number: c.number,
        blockedBy: blockersOf(c),
        ...(foreign.length > 0 ? { foreignBlockers: foreign } : {}),
      };
    });
}

// The next single tracer-bullet to dispatch: the lowest-numbered slice not yet in
// `closed` whose in-set blockers are all closed. null when none is ready (the spec
// is complete, or the remaining slices are deadlocked).
export function nextSlice(bullets: readonly TracerBullet[], closed: Set<number>): number | null {
  const members = new Set(bullets.map((b) => b.number));
  const ready = bullets
    .filter((b) => !closed.has(b.number))
    // Only blockers that are themselves tracer-bullets of this spec gate the slice.
    // A stray ref (a non-member issue) is the `implement` blocked-by guard's job,
    // not ours — so the pure module can't deadlock on it.
    .filter((b) => b.blockedBy.every((n) => !members.has(n) || closed.has(n)))
    .map((b) => b.number);
  return ready.length ? Math.min(...ready) : null;
}

// True when every tracer-bullet is closed.
export function isComplete(bullets: readonly TracerBullet[], closed: Set<number>): boolean {
  return bullets.every((b) => closed.has(b.number));
}

// The strict topological build order — `nextSlice` applied repeatedly. Stops if
// the remaining slices deadlock (so a cycle yields a partial order, never a hang).
export function topologicalOrder(bullets: readonly TracerBullet[]): number[] {
  const order: number[] = [];
  const closed = new Set<number>();
  for (let next = nextSlice(bullets, closed); next !== null; next = nextSlice(bullets, closed)) {
    order.push(next);
    closed.add(next);
  }
  return order;
}

// The build order plus what it could not reach: the slices left out are in a
// dependency cycle, so the orchestrator will never dispatch them. Every surface that
// shows a spec's slices needs both halves — the progress comment and the status view
// each render the leftovers rather than silently dropping them — so the split lives
// here, in the brain, and not once per renderer. `deadlocked` keeps the input's order.
export interface BuildOrder {
  readonly ordered: number[];
  readonly deadlocked: number[];
}

export function orderWithDeadlocked(bullets: readonly TracerBullet[]): BuildOrder {
  const ordered = topologicalOrder(bullets);
  const inOrder = new Set(ordered);
  const deadlocked = bullets.filter((b) => !inOrder.has(b.number)).map((b) => b.number);
  return { ordered, deadlocked };
}
