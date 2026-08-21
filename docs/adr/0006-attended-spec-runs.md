# Attended spec runs: an in-process slice loop, not webhook dispatch

`implement-spec` in CI is event-driven: `kickoff` labels the first tracer-bullet, a webhook dispatches it, its PR merges, `advance` fires and labels the next. Run from a terminal there are no webhooks, so the local entry point (ADR-0005) drives the slices itself — a plain loop over the same `spec-graph` brain. `advance` stops being a webhook handler and becomes a loop step. Everything the loop guards — per-slice PRs, CI gating, strict sequencing — survives unchanged.

## Status

accepted (extends ADR-0003 and ADR-0004 to the local entry point); the
marker-lifecycle clause under Decision is **superseded by ADR-0009** — a halted run
keeps the marker — and the "Stepwise by default" clause together with the dry-run
amendment's *on by default* are **superseded by ADR-0011** — a bare `implement-spec
<n>` now runs unattended, with `--dry-run` and `--pause` as the opt-outs. Everything
else here stands, including the dry run itself, the preview, the merge confirmation,
the graceful stop, and the run ceiling.

## Context

Spec orchestration is the case with the most to gain from running locally, and the reason is not control — it is **bootstrap amortisation**. In CI, an eight-slice spec pays checkout, toolchain setup, dependency install, and database preparation eight separate times, plus a webhook round-trip between each. Locally it is one worktree on the spec branch, bootstrapped once, with a `for` loop over the slices.

The port is cheaper than it looks because `advance.mts` is already decide/dispatch split: the pure brain (`tracerBullets`, `nextSlice`, `isComplete`) lives in `spec-graph.mts` and `advance.mts` is only the `gh` I/O wrapped around it. Only the dispatch call has to move.

## Decision

**The loop calls `nextSlice` directly and runs `implement` in process.** Labels are still written as *state*; they are no longer used as *dispatch*. Labelling-as-dispatch is a GitHub Actions transport detail and has no reason to exist locally — the decision (`nextSlice`) stays shared, the click does not.

**Per-slice PRs stay** (ADR-0004's `implement → merge → advance`), even though the reason they merge immediately — making the webhook fire — has evaporated. Divergent git topology between entry points would mean a spec started locally and finished in CI is malformed, and the PR is also what closes the tracer-bullet issue. The ceremony is cheap; the divergence is not.

**CI gating stays.** The loop reuses `shared/poll-checks.mts` unchanged: a slice cannot merge on red, and the next slice cannot start on a red spec-branch tip. These are the two gates from #44 (fixed in #46 and #47), and dropping them locally is worse than not having had them — the loop would keep stacking slices onto a broken spec branch while the developer watches. `CHECKS_TIMEOUT_SECONDS`, `CHECKS_GRACE_SECONDS`, and `CHECKS_INTERVAL_SECONDS` are already env-overridable, so local runs can tighten the wait without code changes.

**Stepwise by default, `--auto` to run straight through.** The pause between slices is where the worktree gets inspected, which is what makes a parity finalize (push and open the PR, as in CI) acceptable rather than a loss of control — the worktree survives the run, and that is what CI cannot offer. `--interactive` is a per-slice escape hatch and is mutually exclusive with `--auto`; otherwise an eight-slice spec would hand over eight separate interactive sessions. *(Superseded by ADR-0011: running straight through is the default and `--pause` is the opt-in, because the inspection this clause protects happens at the end from the final PR, not between slices. The checkpoint itself is unchanged — `--pause` still stops exactly here. `--interactive` survives too, and now implies pausing rather than contradicting it, so the mutual exclusion is narrowed to an explicitly typed `--interactive --no-pause`.)*

**One worktree per spec**, created on the spec branch and bootstrapped once, with each slice branching inside it. This mirrors the **stacked** topology exactly: a slice branching from the accumulated spec-branch HEAD is what a single worktree gives for free. It is deleted when the final PR opens, and kept on failure or abort — the failed tree is the thing worth looking at.

**A failed slice halts the run.** Under stacked and strictly-sequential building, every later slice assumes the earlier ones landed; skipping one produces a spec branch with a missing layer and slices never tested against the code they assume exists. It is also parity — in CI a failed `implement` sets `agent:blocked`, `advance` never fires, and the spec stalls. Automatic retry is rejected: a slice that fails twice fails for a reason a third attempt will not find, and on an attended run there is a human present.

**Resume derives entirely from GitHub; there is no local state file.** `advance` already recomputes the slice set live on every call so that late-added slices are picked up, and the local loop inherits that. A state file would be a second source of truth that goes stale the moment anyone touches the issues in the GitHub UI. A slice whose branch is pushed with an open unmerged PR resumes at *await checks, then merge* — it does not re-run the agent, which would be the most expensive mistake the loop could make.

**Concurrency is guarded twice.** `agent:in-progress` is the mutex between entry points; a lockfile in the worktree root keyed by spec or issue is the mutex between two local terminals, which the label cannot cover because both would see their own label. `--force` overrides both, the same override that proceeds past a guard refusal. Two *different* specs running at once is fine and stays allowed — separate worktrees, separate spec branches, no shared state.

**The local run tells CI to stand down.** Labelling-as-dispatch disappears locally, but *merging* does not — and unattended `advance` is fired by the merge, not by a label. So every slice the loop merges into the spec branch fires CI advance, which labels the next tracer-bullet `agent:implement` and starts building in CI the very slice the loop is about to build itself. This is the one place where replacing webhook dispatch with an in-process loop reaches back into the unattended path, and neither existing mutex covers it: `agent:in-progress` is a mutex on *one* issue, while advance labels the *next* slice — an issue not in progress anywhere — making it a race between CI's guards and the loop's start rather than a mutex at all. So the loop holds a run-scoped marker (`agent:local`) on the *spec* issue, and `advance` gains the guard it never had: it **refuses** while the marker is present. Refusal is the right concept — not a failure, just "not mine to do". The marker's lifecycle is the local lock's: claimed before the first merge, released on success, failure, graceful stop, and abort, and **reclaimed** by the next run when a crash left it behind — a marker nobody owns would otherwise disable CI advance for that spec forever. A dry run never merges, so it never takes one. *(Superseded by ADR-0009: the marker is no longer tied to the lock's lifecycle. It is released when the run **completes**; a halted run keeps it, because a halt means the spec is still the developer's, and the merge whose advance would build the stopped slice may still be in flight. The reason above survives — reclaim, not release-on-halt, is what keeps a marker from becoming ownerless — and the claim, the verification, the advance refusal, and the dry run's abstention are unchanged.)*

**Output is raw plus structure.** The agent's output streams to the terminal as `logging: { type: "stdout" }` already does — seeing the run is the point — framed by a per-slice header and footer and closed with a summary, because eight slices of undelimited stream is unreadable. The spec-issue dashboard comment (`advance.mts:67`, via `spec-report.mts`) is still posted each iteration: it already exists, it is what makes the spec issue readable to anyone who is not the person running it, and dropping it would make a locally-run spec look abandoned from GitHub's side.

## Amendments from surveying prior art

A survey of eight existing Herdr-based orchestrators (2026-08-11) — chiefly `sean1588/herdr-orchestrator`, `sarmientoF/herdr-pr-loop`, and `Tudor0404/dual-author` — surfaced five gaps in the above. All are small and none disturbs the decisions already recorded; they are listed here because their absence was an oversight rather than a choice.

**A dry run.** The loop supports executing its whole sequence with merges and the final PR suppressed, reporting what it would have done. The prior art ships this *on by default* and halts short of the first irreversible action. This is the only way to watch a full pass before trusting the loop with real merges into a **spec branch**, which is the highest blast-radius action in the feature and had no safety valve at all. *(The on-by-default half is superseded by ADR-0011: the trust this was there to build has been built, so `--dry-run` is now the opt-in. The dry run itself — what it suppresses and where it halts — is unchanged.)*

**The merge is confirmed, not assumed.** The survey's sharpest idea is that *GitHub is the source of truth for artifacts; an agent's reported completion is only a trigger to go and check.* Applied here it is narrower than it first appears, because the verb entrypoints already guard the obvious case — `implement` and `implement-pr` both exit non-zero when the agent produced no commits, precisely so an empty branch is never pushed. The gap is at the level this loop newly owns: on the unattended path the merge *webhook* is what proves a slice landed, and the loop replaces that webhook with its own `gh` call, giving up the proof along with it. So after merging, the loop reads the PR's merged state back and halts on anything else. It deliberately does not use the tracer-bullet's closed state as that signal, because closing is failure-tolerant by design and a merged slice can legitimately still have an open issue.

**A preview before starting.** The resolved slice list, both branches, and the mode are shown before the first agent runs. The blast radius is visible before it is incurred.

**A graceful stop.** Ctrl-C aborts immediately and abandons a half-built slice. A separate request — necessarily from a second terminal, since the running one is occupied — finishes the current slice and halts at the next checkpoint. The checkpoint already exists; only the request was missing.

**A run ceiling.** Iteration caps bound a single agent run; nothing bounded the loop. A configurable ceiling on slices or wall-clock halts cleanly, reported distinctly from a failure so nobody hunts for a bug that is not there.

Also added: an append-only **run log**, so a run that halts overnight leaves something to read. This does not contradict the no-local-state decision, and the distinction is load-bearing — nothing reads the log to decide anything. It is written, never consulted.

## Considered alternatives

- **Label the next slice and let CI pick it up.** A hybrid: local kickoff, CI slices. Rejected — it races the local run and gives up every advantage that motivated running locally.
- **Local kickoff only, slices run by hand.** Rejected: that is the current experience with extra typing.
- **Commit slices directly to the spec branch, no per-slice PR.** Faster and simpler now that no webhook needs firing, but it forks the git history between entry points and removes the trigger that closes each tracer-bullet issue.
- **Trust the implement agent's own test loop and merge without waiting for CI.** Rejected: this is precisely the bug fixed twice in #46 and #47. The honest cost of keeping the gate is a multi-minute wait between slices, which consumes a real share of the bootstrap saving.

## Consequences

- The preview and the checkpoints are gates on the *human's* attention, and both can be pre-accepted (`--yes`, `--no-pause`) — otherwise nothing without a terminal could ever start a run, since a non-interactive stdin declines. This does not weaken any of the decisions above: every CI gate, the merge read-back, the local lock, and the `agent:local` marker are unchanged, and the preview is still printed in full with the accepting flag named, so the bypass is recorded rather than silent. What it costs is the assumption used to reject automatic retry — that a human is present to see a halt — so a run started this way must be read from its log or its Herdr notification instead. *(ADR-0011 inverts this: pre-accepted is now the default and `--pause` restores both gates together. Every clause above still holds — nothing weakens, the preview still prints in full, and the retry rejection still stands — but the cost named in the last sentence is now paid on every run rather than an opted-into one, which is why the preview names the run log's path.)*
- `advance.mts` splits: the `gh` dispatch call separates from the close/recompute/report logic the loop reuses. `spec-graph.mts` is untouched.
- `advance` stops being unguarded: the reusable workflow runs the `implement-spec` guard for *both* modes, and in advance mode it reads the spec's `agent:local` marker. The decision ("should advance stand down?") is a pure function of the spec state and the marker, tested beside the other step-function decisions.
- A local spec run and a CI spec run produce identical git history and identical tracker state. Either can resume the other.
- The wall-clock win over CI is real but smaller than bootstrap amortisation alone suggests, because CI gating reintroduces a wait per slice.
- `implement-spec` is no longer only a workflow, so `CONTEXT.md`'s definitions of *Orchestrator*, *Kickoff*, and *Advance* — all phrased as workflows or webhook-fired entry points — are updated alongside this ADR.
