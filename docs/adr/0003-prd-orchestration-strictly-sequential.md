# Spec orchestration is strictly sequential, not parallel waves

<!-- Filename retains `prd` as the historical ADR identifier; the concept was
renamed spec (PRD → spec) when tracking mattpocock/skills v1.1 (`/to-spec`). -->

The `implement-spec` orchestrator drives `implement` across a spec's tracer-bullets on a shared spec branch (the stacked topology). We decided it processes **one tracer-bullet at a time in topological order** — never a parallel wave of independent slices — trading wall-clock speed for the elimination of an entire class of failure: agent-generated merge conflicts on the spec branch.

## Status

accepted

## Context

A spec's tracer-bullets form a dependency graph via their `## Blocked by` sections. The obvious optimisation is to dispatch every currently-unblocked slice at once (parallel waves), gated by the existing `implement` blocked-by guard. The graph makes this look safe.

It isn't. The `## Blocked by` graph encodes **logical** dependencies ("slice 3 needs the API slice 1 built"), not **file-overlap** dependencies. Two slices the graph calls independent can still touch the same seam — and tracer-bullets are *vertical* slices cutting through shared layers (schema, router, shared types), so overlap is the norm, not the exception. In a stacked topology, two such siblings each branch off the same spec-branch commit and both target the spec branch; the first merges clean, the second conflicts. Nothing in this system resolves agent-generated merge conflicts.

## Considered options

- **Parallel waves + conflict recovery.** Dispatch all unblocked slices; on a conflicting merge, route the loser through the existing `agent:update-branch` verb to rebase onto the new spec HEAD and re-attempt, with `agent:blocked` as the backstop. Faster, but adds a synchronous-merge-for-detection requirement, an `update-branch` recovery path, asynchronous conflict-detection edge cases, and forfeits per-slice CI gating to keep detection clean.
- **Strictly sequential (chosen).** One slice in flight at a time, topologically ordered. Each slice branches off the *current* spec HEAD (which already contains every previously-merged slice). Because nothing else touches the spec branch while a slice is in flight, **every merge is conflict-free by construction.**

## Decision

Strictly sequential. *Kickoff* dispatches the topologically-first tracer-bullet; *advance* (on each tracer-bullet PR merging into the spec branch) dispatches the next single slice in topological order, ties broken deterministically. The blocked-by guard remains as a correctness backstop, but the orchestrator owns ordering by picking the next valid slice.

## Consequences

- **The conflict-recovery machinery is deleted, not deferred.** No synchronous-merge-for-detection, no `agent:update-branch`-on-conflict path, no conflict backstop. The merge step is a trivial direct merge in `finalize`.
- **Per-slice CI gating is dropped** as a free choice (clean merges no longer need async detection): the agent runs the repo's tests in its own loop behind the `<verb>` hook, and the real CI + human gate is the final spec→default PR.
- **Cost is wall-clock**: an N-slice spec is N sequential slice-loops. Accepted deliberately.
- **Hooks come to depend on single-in-flight** (advance dispatches exactly one slice; merges are assumed clean). Reversing to parallel later means re-introducing the whole conflict-recovery design — hence this ADR.
