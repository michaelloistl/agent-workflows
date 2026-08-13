# Tracer-bullet slices merge after build, with no per-slice agent review

The original `implement-spec` design (grilled, then built in #7) ran an autonomous per-slice review loop: under a spec, `implement` opened a ready PR and applied `agent:review-pr`, whose finalize merged a clean review or routed a commented one to `implement-pr` to address it, then merged. The #8 dogfood proved this loop unsound. We removed it: a tracer-bullet now **merges straight into the spec branch after it builds**, and the only review is the human review of the final spec→default PR.

## Status

accepted (supersedes the slice-review-loop portion of #7); amended by #114 — review
returns as a **human input at the spec boundary** (the final spec→default PR is
labelled for an advisory review), which does not revive the verdict-driven alternative.

## Context — why the loop couldn't work

Two facts about the existing verbs, surfaced by the dogfood (PR #15):

1. **`review-pr` is advisory-only.** `shared/review-output.mts` hardcodes `event: "COMMENT"` — a review is a summary plus inline comments, never `APPROVE`/`REQUEST_CHANGES`. There is **no verdict** to branch on. The loop inferred "needs changes" from "has ≥1 inline comment," but the agent attaches non-blocking *nits* as inline comments.
2. **`implement-pr` fails on a no-op.** `implement-pr.mts` exits non-zero when the agent produces zero commits ("no commit means nothing was addressed") — correct for the human flow, fatal here.

So a clean slice with a nit-level inline comment was routed to `implement-pr`, which correctly made no change, exited non-zero, and went `agent:blocked` — stalling the whole sequence. Inferring a clean/changes decision from a verdict-less review is fundamentally unsound.

## Decision

Drop per-slice review. Under a spec, `implement`'s finalize opens a ready PR to the spec branch and merges it immediately (strictly sequential, so the merge is always clean), which fires advance. `review-pr` and `implement-pr` revert to their standalone behaviour; the `BASE_REF`/`contents: write` plumbing added for the loop (#7, #16) is reverted.

The line the original conflated, drawn explicitly (amended #114): review is dropped as a **machine input** — a verdict-less `COMMENT` that nothing can route on, which is precisely why a per-slice review-driven loop was unsound and why the verdict-driven alternative below stays dead. It returns as a **human input at the spec boundary**: the orchestrator labels the final spec→default PR for an advisory `review-pr` when it opens it (#114), addressed to the human who merges. That review still has no verdict and nothing programmatic reads it — it does not revive per-slice review or the verdict-driven option; advisory is simply the correct register for a review a human, not the sequencer, consumes.

## Considered alternatives

- **Make `implement-pr` no-op-tolerant under a spec** — keeps the loop, but still runs a full extra agent pass per nit-only slice to conclude "nothing to do." Cost without benefit.
- **Give the review a real verdict (Option D)** — add `approve | request-changes` to the review output + prompt and route on it, so `implement-pr` runs only when changes are genuinely requested. This is the principled way to keep per-slice review and remains the **documented upgrade path** if catching a bad slice before the next stacks on it proves worth ~2× the agent runs per slice. Deferred: on an isolated spec branch with a final human gate and the implement agent already running the repo's tests, a second per-slice agent review is a lot of spend for marginal safety.

## Consequences

- The slice loop is simply `implement → merge → advance`. Fewer agent runs, no spurious blocks.
- The per-slice quality gate is the implement agent's own test loop; the single human gate is the final spec→default PR.
- A bad slice is caught later (final PR) rather than per-slice. Acceptable given the isolation and the building agent's own tests.
- Reverting to verdict-driven review (the deferred alternative) is additive and non-breaking when/if it lands.
