# One sequencer, reached through two entry points

The reusable workflows were the only way to run a verb, and each one hardcoded the hook order across ~15 YAML steps. We are adding a second way in — a CLI that runs a verb on the developer's own machine — **without** adding a second implementation of that order. The verb sequence moves out of YAML into TypeScript; each workflow collapses to *provide an environment, then hand the whole sequence to the sequencer*. The workflow and the CLI become two **entry points** to one **sequencer**.

## Status

accepted

## Context

The label-triggered fleet gives a human exactly one moment of control: the click that applies the label. Everything after it — which branch to build on, whether to keep going, what the agent is doing right now — is unreachable. The concrete trigger was the base branch: every workflow hardcodes `github.event.repository.default_branch` (`implement.yml:201`, `:279`, and the tooling checkout ref in all six files), with `steps.spec.outputs.base` as the only override, and that exists solely so spec slices target the spec branch. A repo whose integration branch is `develop` has no way to say so.

That gap is a missing input. The rest of the complaint is not: an unattended run is minutes-long, unsteerable, unstoppable short of cancelling, and leaves no working tree to inspect. Fixing *those* means running the agent where the human is.

What made this cheap is a property ADR-0001 already bought: the hooks barely know they are in CI. Their entire context surface is 13 plain environment variables (`ISSUE_NUMBER`, `ISSUE_TITLE`, `PR_NUMBER`, `PR_TITLE`, `GH_REPO`, `BASE_REF`, `HEAD_REF`, `BRANCH`, `SPEC_FILE`, `COMMENT_FILE`, `REVIEW_FILE`, `REPLIES_FILE`, `STATUS_FILE`) plus `GITHUB_OUTPUT`, `RUN_URL`, `BASE`, `AGENT_MODEL` and an authenticated `gh`. Nothing reads the Actions event payload; `shared/github.mts` touches `process.env` exactly once. A local entry point therefore has to set some variables and call the hooks in order — the expensive part is everything *around* the agent, not the contract.

## Decision

**The sequencer owns the verb sequence; the workflow owns the environment.** Each reusable workflow keeps checkout, toolchain setup, and service containers, then delegates the entire hook sequence to a single sequencer invocation. `implement.yml` drops from 295 lines to roughly 90.

**One deliberate exception: the guard job stays split.** `implement.yml` currently runs guards in a separate lightweight job before spinning up Ruby and Postgres. That split is a real cost saving, so the workflow keeps two sequencer invocations — a guards-only one in the light job, the full one in the main job — rather than collapsing to a single call.

**Config is split by who can act on it.** Values only GitHub Actions can act on stay `with:` inputs, because a TypeScript sequencer cannot invoke `uses: ruby/setup-ruby@v1` or an `apt-get` step: `enable-ruby`, `system-packages`, `node-version`, `database-url`. Values the sequencer acts on move to a committed config file in the consuming repo that **both** entry points read: `base-branch`, `agent-model`, `bootstrap`, worktree root. This is the existing *essential drift* distinction cut along a sharper line — the question is no longer "does this genuinely differ per repo" but "who is capable of acting on it."

**The local entry point runs attended.** It creates a git worktree per run, invokes the consuming repo's own `bootstrap` command to make that tree runnable, and reuses the developer's existing `gh` and Claude Code credentials — no secrets on disk, and agent runs bill against a subscription rather than the API. It honours guards but suppresses their tracker announcement, printing the refusal to the terminal instead, and `--force` proceeds past one. It writes state labels like any other run. It defaults to headless with the output streamed to the terminal; `--interactive` hands the composed prompt to an interactive Claude Code session, and is meaningful only for `implement` and `implement-pr` — `explore`, `review-pr`, and `update-branch` depend on the structured extraction pass in `shared/run-with-extraction.mts`, which an interactive session cannot produce.

## Considered alternatives

- **Two sequencers with a conformance test.** Keep the YAML steps, re-implement the order in TypeScript, and assert the two match. Rejected: the drift it guards against is silent and severe (a skipped guard, a missing `status blocked` on failure), and writing a test that meaningfully compares a YAML step list to a TypeScript call sequence is most of the work of unifying them with none of the benefit.
- **A cockpit that only dispatches CI.** A local tool that chooses the ticket, base branch, verb, and model, fires `workflow_dispatch`, then streams logs. Rejected: it fixes input control and visibility but not the loop length, and loop length is the actual complaint.
- **Move every input into the config file.** Rejected as impossible for the toolchain values, as above.
- **Have the local entry point parse the thin caller's `with:` block**, for literally one source of truth. Rejected: it makes the caller a config format it was never designed to be, and breaks the first time anyone uses an expression.
- **Run the agent in place on the developer's checkout**, which is what `HEAD_STRATEGY` in `shared/agent.mts` assumes. Correct on an ephemeral runner, where in-place *is* isolated; unacceptable on a laptop, where it means editing the tree the developer is sitting in. The worktree is the head, it is simply not that tree.

## Consequences

- The hook contract grows one flag — suppress the tracker announcement on refusal — which `docs/hook-contract.md` describes as stable. Named here rather than slipped in.
- Per-step grouping in the Actions log is lost; a verb becomes one step. Sequencer output has to carry the structure the UI used to.
- The label-triggered fleet is unchanged and stays the way to start unattended work. This is a second front door, not a migration; `agent:in-progress` becomes the mutex that stops the two colliding on one issue.
- The `base-branch` gap closes for both entry points at once, since both read the same config file.
- Linear support is explicitly out. It is aspirational — no consuming repo currently references it — and building an ID resolver now means testing it against nothing.
- Terminal-multiplexer coupling is bounded rather than forbidden, and the boundary is **dependency, not contact**. The sequencer must run in CI and in a bare terminal, so it never delegates worktree creation, agent lifecycle, or scheduling to a multiplexer — even where one could do the job, as Herdr's worktree command could for the attended entry point. Emitting progress into a multiplexer's UI when one happens to be present is permitted and cheap; needing one in order to work is not. See ADR-0006 for what the survey of existing Herdr orchestrators changed.
