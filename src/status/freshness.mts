// Whether a `--watch` tick has to do real work (issue #106). The redraw loop asks for a
// frame once per interval; most intervals nothing has changed, and re-fetching a whole
// spec tree to redraw the same picture spends the rate limit the fleet's agent runs share.
// This wraps the full pass in one cheap question — has anything changed since the last
// frame? — and computes a new frame only when the answer is yes or cannot be trusted.
//
// The freshness decision is a PURE function (`needsFullPass`) over three injected things —
// a change probe, the full pass, and a clock — so it is unit-tested with no network and no
// wall-clock. `freshRender` is the thin stateful shell that wires them and holds the frame
// and the last-pass state between ticks. ADR-0007 records that a tick and a fetch are now
// separately-costed.

// The state carried from one FULL PASS to the next — never from tick to tick, because the
// staleness ceiling and the branch comparison both measure against the last frame the user
// actually saw, not the last time the loop woke up.
export interface PassState {
  readonly branches: readonly string[];
  readonly at: number;
}

// A change the probes cannot witness — a body edit the issues probe races past, say —
// costs latency rather than a permanently frozen screen: a full pass runs at least this
// often no matter what the probe says. Held here as a constant, injected in tests.
export const STALENESS_CEILING_MS = 5 * 60 * 1000;

// The whole decision, and every reason it fails open to a full pass:
//   - no prior pass (the first tick has nothing to reuse),
//   - the probe says changed, OR could not tell (`null`) — over-refreshing costs a handful
//     of calls, under-refreshing is invisible and is the failure this view exists to avoid,
//   - the branch list moved (a spec started, or a branch vanished) — a git read the pass
//     already makes, so it costs nothing extra here,
//   - the staleness ceiling elapsed since the last pass.
// Only a positively-verified-unchanged tick within the ceiling reuses the frame.
export function needsFullPass(
  prev: PassState | null,
  now: PassState,
  changed: boolean | null,
  ceilingMs: number,
): boolean {
  if (prev === null) return true;
  if (changed !== false) return true;
  if (!sameBranches(prev.branches, now.branches)) return true;
  if (now.at - prev.at >= ceilingMs) return true;
  return false;
}

// Order-insensitive: `git ls-remote` does not promise an order, and only the set of
// branches is a signal — a reordering is not a change.
function sameBranches(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((branch) => seen.has(branch));
}

export interface FreshRenderDeps {
  // The remote branch list, read ONCE per tick and handed to both the change decision and
  // the pass — the probe no longer reads it separately from the pass (issue #106).
  readonly branches: () => readonly string[];
  // The conditional GitHub read: `false` = verified unchanged, `true` = changed, `null` =
  // could not tell (a probe error, a missing ETag, an unparseable response). Never a source
  // of display data — only an invalidation signal.
  readonly changed: () => boolean | null;
  // The full pass — fetch, resolve, render — over the tick's branch list. The ONLY thing
  // that produces a frame, so what `--watch` shows stays exactly what a one-shot run prints.
  readonly pass: (branches: readonly string[]) => string;
  readonly now: () => number;
  readonly ceilingMs?: number;
}

// The render function the redraw loop calls once per interval. The loop's contract is
// unchanged — a `() => string` allowed to throw — so a full pass that fails still surfaces
// through its "could not read the tracker" handling, and the watch survives it.
export function freshRender(deps: FreshRenderDeps): () => string {
  const ceilingMs = deps.ceilingMs ?? STALENESS_CEILING_MS;
  let prev: PassState | null = null;
  let frame = "";
  return () => {
    const now: PassState = { branches: deps.branches(), at: deps.now() };
    // Probed every tick, even one that will full-pass for another reason: the conditional
    // read's ETag has to track the latest state, or the next tick compares against a stale
    // ETag and refreshes when it need not.
    const changed = probe(deps.changed);
    if (needsFullPass(prev, now, changed, ceilingMs)) {
      frame = deps.pass(now.branches);
      prev = now;
    }
    return frame;
  };
}

// A probe that throws is a probe that could not answer: it fails open to `null` (→ a full
// pass), never a crash that tears the watch down. A probe error is exactly the "fails open"
// rule the ticket names.
function probe(changed: () => boolean | null): boolean | null {
  try {
    return changed();
  } catch {
    return null;
  }
}
