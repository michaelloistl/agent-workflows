// The decision core of the `implement-spec` orchestrator (CONTEXT.md). Pure
// functions over raw issue bodies and numbers — no `gh`, no GitHub. The
// guards/kickoff/advance hooks are thin shells: they fetch raw bodies via `gh`,
// call in here, and act on the result.
//
// A tracer-bullet links to its spec via a textual `## Parent` reference and to its
// blockers via `## Blocked by` (NOT native sub-issues — the `implement`
// issue-shape guard refuses those). Orchestration is strictly sequential
// (ADR-0003): only `nextSlice` matters operationally, and `topologicalOrder` is
// just `nextSlice` applied until done.

import { section } from "./markdown.mts";

export interface IssueInput {
  number: number;
  body: string;
}

export interface TracerBullet {
  number: number;
  blockedBy: number[];
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

// The tracer-bullets of `spec`: the candidates whose `## Parent` references it,
// with their in-section blocked-by edges. Order follows the input.
export function tracerBullets(spec: number, candidates: IssueInput[]): TracerBullet[] {
  return candidates
    .filter((c) => parentRef(c.body) === spec)
    .map((c) => ({ number: c.number, blockedBy: blockedByRefs(c.body) }));
}

// The next single tracer-bullet to dispatch: the lowest-numbered slice not yet in
// `closed` whose in-set blockers are all closed. null when none is ready (the spec
// is complete, or the remaining slices are deadlocked).
export function nextSlice(bullets: TracerBullet[], closed: Set<number>): number | null {
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
export function isComplete(bullets: TracerBullet[], closed: Set<number>): boolean {
  return bullets.every((b) => closed.has(b.number));
}

// The strict topological build order — `nextSlice` applied repeatedly. Stops if
// the remaining slices deadlock (so a cycle yields a partial order, never a hang).
export function topologicalOrder(bullets: TracerBullet[]): number[] {
  const order: number[] = [];
  const closed = new Set<number>();
  for (let next = nextSlice(bullets, closed); next !== null; next = nextSlice(bullets, closed)) {
    order.push(next);
    closed.add(next);
  }
  return order;
}
