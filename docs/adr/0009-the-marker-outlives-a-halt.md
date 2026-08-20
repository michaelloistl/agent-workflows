# The local-run marker outlives a halt

ADR-0006 gave the local-run marker (`agent:local`) the local lock's lifecycle: claimed before the first merge, released on success, failure, graceful stop, and abort. That tied a claim on a *spec's sequencing* to the lifetime of a *process*, and the two are not the same thing. A halted run is still waiting for the developer it halted for, so the marker now survives every halt and is released only when the run **completes**.

## Status

accepted (supersedes the marker-lifecycle clause of ADR-0006 — that clause only; every other decision in ADR-0006 stands unchanged)

## Context

The attended slice loop merges each tracer-bullet PR into the spec branch, and that merge is exactly what fires unattended **advance**. ADR-0006 added the marker for that reason and gave advance the guard it never had: refuse while the marker is present. None of that is in question here.

The lifecycle was. Releasing on *every* exit means a run that halts seconds after a merge — a slice failed, a merge came back unconfirmed, a checkpoint was declined, a ceiling was reached, a graceful stop was requested, Ctrl-C was pressed — takes the marker off the spec issue while that merge's advance run is still in flight. Advance then reads a spec with no marker, finds nothing standing in its way, and labels the next tracer-bullet `agent:implement`: CI starts building the very slice the developer just stopped. The window is small and the loss is not — a halt is the one moment when the developer's decision is furthest from CI's default.

The modelling error is visible in ADR-0006's own phrasing, "the marker's lifecycle is the local lock's". The lock is a mutex on a live process: when the process is gone, nothing is being protected and holding it would be a bug. The marker is a claim on a spec's sequencing, and a halt does not end that claim — it is the moment the claim matters most.

## Decision

**A completed run releases the marker; a halted run keeps it.** "The run ended" now means the run *completed* — its final PR is open — not that the process exited. Every halt keeps the marker, so advance keeps standing down on the spec the developer stopped, whether or not the last merge's advance run has read the issue yet.

**ADR-0006's reason for releasing is preserved, because it is still right.** A marker nobody owns would disable CI advance for that spec forever, and that must not happen. A marker retained by a halt is not ownerless. It has an owner — the developer the run halted for — and three things keep it from turning into abandonment: the loop prints, on its way out, that the marker is still on the spec, what it suppresses, and the single action that clears it (remove the label); the run log records the retention; and the **reclaim** path from ADR-0006 is untouched, so a run that died without releasing anything is still recovered by the next run, which holds the local lock and therefore knows no live local run owns the marker. The ownerless case ADR-0006 was defending against is a *crash*, and it is still covered by reclaim rather than by releasing on halt.

Everything else about the marker stands as ADR-0006 wrote it: claimed before the first merge, verified after claiming, read by the advance guard as a refusal rather than a failure, and never taken by a dry run, which merges nothing and so fires no advance.

The release decision is a pure function of the run's terminal state (`markerReleasedOnExit` in `shared/spec-marker.mts`), tested beside the rest of the marker vocabulary — the same decide/dispatch split the advance guard's decision already uses.

## Considered alternatives

- **Release after the in-flight advance settles.** Keep releasing on halt, but order it correctly: wait for the merge's advance run to finish before taking the label off. Rejected — the loop would have to poll GitHub Actions for a webhook-triggered workflow's *read* of a label, which is a new network dependency, a new failure mode (what does the loop do when the poll times out, or the run never appears?), and a delay on every exit including the ones that had no merge in flight at all. It buys correctness in one window at the cost of making the exit path the least reliable part of the loop.
- **A second label, or a stored halt state.** Distinguish "halted, still mine" from "running" with another label or a file in the worktree. Rejected — resume derives entirely from the tracker and the branches (ADR-0006), and a stored halt state is exactly the local second source of truth that rule exists to prevent. A second label would be no better: two labels that must agree, where one already answers the only question advance asks.

## Consequences

- A halted attended run leaves `agent:local` on the spec issue, so that spec is out of CI's hands until a human acts. That is the point, and it is the cost: a developer who abandons a local run and wants CI to carry on must remove the label. The loop's exit line names that action, and the next attended run reclaims the marker if they resume locally instead.
- ADR-0006's marker-lifecycle clause is superseded and points here. Its per-slice PRs, CI gating, one-worktree topology, halt-on-failure, no-local-state resume, and double concurrency guard are unaffected.
- The README's run-marker row and attended-spec-loop prose, and `CONTEXT.md`'s *local-run marker* entry, describe the retained-on-halt rule and the hand-back action.
