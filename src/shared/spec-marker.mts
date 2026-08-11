// The local-run marker: the label an attended slice loop holds on a spec issue for
// the length of its run, and the decision it drives — whether the unattended
// `advance` should STAND DOWN. PURE: the label string, the reading of it, the
// decision, and the sentences that explain it. No `gh`, no git — the tracker I/O
// lives in `spec-tracker.mts` (reading an issue's labels) and `github.mts`
// (adding/removing them).
//
// WHY THE MARKER EXISTS. The attended spec loop merges each tracer-bullet PR into
// the spec branch, exactly as CI does — that parity is the point (ADR-0006). But
// unattended `advance` is triggered by that MERGE, not by a label: every PR merged
// into an `agent/spec-*` branch starts it, and it responds by labelling the NEXT
// tracer-bullet `agent:implement` — which IS a trigger. So on a two-slice spec run
// locally, the loop's first merge starts CI building slice two while the loop is
// about to build slice two itself.
//
// STATE LABELS CANNOT PREVENT THIS, which is why a new marker is needed rather than
// a reuse of the existing vocabulary. `agent:in-progress` is the mutex between entry
// points on ONE issue; advance labels the NEXT slice, an issue that is not yet
// in-progress anywhere. That makes the collision a race between CI's guards and the
// loop's own start, not a mutex. The marker instead sits on the SPEC issue — the one
// thing both paths agree identifies the run — and is scoped to the run, not to a
// slice.
//
// REFUSAL, NOT FAILURE. Advance standing down is "not mine to do", the same concept
// as a guard refusal: the run job is skipped, nothing is dispatched, and nothing is
// ever marked `agent:blocked`.

// The marker itself. Deliberately NOT a state label (`agent:in-progress`/`review`/
// `blocked`) and NOT a trigger label — nothing triggers on this string, so applying
// it can never start a workflow.
export const LOCAL_RUN_LABEL = "agent:local";

// The description used when the label is created in a consuming repo on first use.
// `gh issue edit --add-label` fails on a label the repo does not have, and label
// edits are best-effort by design, so the loop creates it before claiming it.
export const LOCAL_RUN_LABEL_DESCRIPTION =
  "An attended local run owns this spec's sequencing; CI advance stands down while it is present.";

// Whether an issue's labels carry the marker. Exact match — a differently-suffixed
// label (`agent:local-something`) is a different label and does not count.
export function markerPresent(labels: readonly string[]): boolean {
  return labels.includes(LOCAL_RUN_LABEL);
}

// The state advance decides from: the spec the merged PR's base branch names (null
// when the base is not a spec branch at all, which advance already treats as a
// no-op) and whether that spec issue carries the marker.
export interface AdvanceOwnership {
  readonly spec: number | null;
  readonly marker: boolean;
}

// Should CI advance stand down? The reason when it should, null when it should
// proceed — the same `string | null` shape as the loop's other pure refusals. A
// non-spec base yields null: there is nothing to stand down from, and advance's own
// no-op path already covers it.
export function advanceStandDown(state: AdvanceOwnership): string | null {
  if (state.spec === null) return null;
  if (!state.marker) return null;
  return (
    `Standing down: spec #${state.spec} carries \`${LOCAL_RUN_LABEL}\`, so an attended local ` +
    `run owns this spec's sequencing and will build the next tracer-bullet itself. CI advance ` +
    `dispatched nothing — this is a refusal, not a failure. If no local run is active, remove ` +
    `\`${LOCAL_RUN_LABEL}\` from #${state.spec} to hand the spec back to CI.`
  );
}

// The line the loop prints when it takes the marker. A marker already present when
// the loop holds the local lock was left by a run that died (the lock proves no live
// local run holds it), so it is RECLAIMED rather than refused — a crashed loop must
// not disable CI advance for a spec forever.
export function markerAcquired(o: { spec: number; reclaimed: boolean }): string {
  return o.reclaimed
    ? `spec-loop: reclaimed a stale \`${LOCAL_RUN_LABEL}\` marker on #${o.spec} (left by a run that did not release it) — this run now owns the spec's sequencing.`
    : `spec-loop: claimed \`${LOCAL_RUN_LABEL}\` on #${o.spec} — CI advance stands down until this run releases it.`;
}

// The line the loop prints when it releases the marker — on completion, on every
// halt, and on abort, tied to the same lifecycle as the local lock.
export function markerReleased(spec: number): string {
  return `spec-loop: released \`${LOCAL_RUN_LABEL}\` on #${spec} — CI advance owns this spec again.`;
}

// The halt reason when the marker could not be verified on the spec issue after the
// loop tried to claim it. Label edits are best-effort everywhere else, but not here:
// an unclaimed marker means CI advance would race every merge this run makes, so the
// run stops BEFORE its first merge rather than proceeding into that race.
export function markerUnverified(spec: number): string {
  return (
    `spec-loop: could not apply \`${LOCAL_RUN_LABEL}\` to spec #${spec} — without it, CI advance ` +
    `would start the next tracer-bullet on every merge this run makes. Halting before the first ` +
    `merge. Create the label in this repo (or apply it by hand) and re-run.`
  );
}
