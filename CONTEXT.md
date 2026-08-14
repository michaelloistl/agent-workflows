# Agent Workflows

The central, public repo (`michaelloistl/agent-workflows`) that holds the **sequencer** driving the coding-agent fleet across multiple project repos — reachable both as reusable GitHub Actions workflows and as a local CLI. It owns only the generic, tracker-agnostic sequencing; every repo- or domain-specific decision lives in the consuming repo.

## Language

### Repos and reuse

**Central repo**:
This repo. Holds the reusable workflows and their version tags. Generic only — knows nothing about any project's tracker, stack specifics, or domain.
_Avoid_: shared repo, actions repo

**Consuming repo**:
A project repo that calls the central workflows and supplies its own config and hooks.
_Avoid_: client repo, child repo, downstream repo

**Fleet**:
The full set of five agent workflows operating in one consuming repo.

**Sequencer**:
The component that runs a *verb*'s hooks in fixed order and supplies their environment. Tracker-agnostic and domain-agnostic by construction — it knows the order of the hooks and nothing about what they do. There is exactly one sequencer, reached through two entry points: the **workflow sequencer** (GitHub Actions, unattended) and the **local sequencer** (CLI, attended). Both run the same sequence; only the surrounding environment differs.
_Avoid_: shell, driver, harness, runner (collides with the GitHub Actions runner), orchestrator (a different concept — see below)

**Reusable workflow**:
A central workflow file invoked via `uses:` with `on: workflow_call`. Provides the environment a run needs — checkout, toolchain, services — and then hands the whole verb sequence to the *sequencer*. It does not itself know the order of the hooks.

**Attended run**:
A run a human is watching and can intervene in — started from the terminal, on the human's own machine. The counterpart is an **unattended run**, started by a *trigger label* and observed only through its output. The two differ in where the work happens and what a human can do mid-flight; they do not differ in what the run *does*. "Attended" names the human's *ability* to intervene, not a promise that someone is at the keyboard: the spec loop's prompts can be pre-accepted (`--yes` for the preview, `--no-pause` for the checkpoints) so a launcher or an unattended resume can start one, and it stays attended in the sense that matters — same machine, same output on the terminal, still interruptible.
_Avoid_: local run vs remote run (describes the machine, not the property that matters), manual run

**Thin caller**:
The minimal workflow file in a consuming repo: event triggers + `workflow_dispatch` + `uses:` the central workflow + `with:` config + `secrets: inherit`. One per verb.
_Avoid_: wrapper, stub

### Agent runs

**Verb**:
One of the five agent actions: `explore`, `implement`, `implement-pr`, `review-pr`, `update-branch`.

**Orchestrator**:
Something that sequences a *verb* over a graph of issues while running **no agent of its own** — pure tracker and graph work. `implement-spec` is the first orchestrator: it drives `implement` across a spec's tracer-bullets. It is **not** a sixth verb (it triggers no agent action) and does **not** follow the 5-hook contract. Like the verbs, its tracker I/O stays behind sandcastle hooks. Reachable from either entry point: unattended it is event-driven, attended it is a *slice loop*.
_Avoid_: meta-verb, super-verb, sixth verb

**Sandcastle**:
The `@ai-hero/sandcastle` package and the per-repo `.sandcastle/` code that frames an agent run as a single `run()` call. The home of all tracker-aware and domain-aware logic.

**Hook**:
A sandcastle command the central workflow calls at a fixed point in a verb's sequence: `<verb>`, `<verb>-guards`, `<verb>-fetch-spec`, `<verb>-status`, `<verb>-finalize`. The interface between generic YAML and repo-specific logic.

**Hook contract**:
The fixed set of hook command names and their expected behaviour that the central workflow depends on. Stable across all consuming repos; only the implementations differ.

**Guard**:
A preflight check run before the agent (spec, shape, blocked-by, existing-PR for GitHub repos). Lives in the `<verb>-guards` hook. The blocked-by guard reads the same dependency rule the *spec tree* holds, so a slice is gated by a blocker declared either way; its decision is pure and lives beside the rule, while the hook itself only reads and refuses.

**Refusal**:
A guard declining to run. The guard posts its own explanation and clears the trigger label, then signals non-zero so the workflow skips the rest. A refusal is **not** a failure.
_Avoid_: rejection, error, block

### Spec orchestration

**Spec branch**:
A single long-lived `agent/spec-<n>-…` branch cut once from the default branch by the `implement-spec` orchestrator. It is the **base** every tracer-bullet of that spec branches from and merges back into. When the last tracer-bullet lands, the spec branch holds the whole feature and one PR `spec branch → default` goes up for final human review.
_Avoid_: feature branch, epic branch, integration branch

**Tracer-bullet**:
A thin, independently-buildable vertical slice of a spec — a standalone issue carrying a textual `## Parent` reference to the spec and a `## Blocked by` section. The `implement` issue-shape guard refuses sub-issues and epics, so nothing the fleet writes is a GitHub sub-issue; where something else has made one anyway (a Linear sync, a hand edit), the *status view* reads that native parent in preference to the body (see *spec tree*), while the orchestrator still goes by the text. The *dependency* edge is read from both sources at once: a slice's blockers are its native `blockedBy` edges **unioned** with its `## Blocked by` refs, everywhere the fleet reads dependencies — the status view, the orchestrator, and the `implement` blocked-by *guard*. The graph and the guard read one rule but answer different questions: the graph orders a spec's slices among themselves and ignores a blocker that is not one of them, while the guard gates a single run on *any* open blocker, which is why a slice named directly by a human still stops at the right time.

**Stacked**:
The topology where each tracer-bullet branches from the current spec-branch HEAD and its PR targets the spec branch (not the default branch) — so each slice sees the accumulated work of the ones before it.

**Strictly sequential**:
The orchestrator runs **one tracer-bullet at a time** in topological (dependency) order, never a parallel wave. Because nothing else touches the spec branch while a slice is in flight, every merge back into the spec branch is conflict-free by construction — the deliberate trade of wall-clock speed for zero agent-generated merge conflicts.

**Kickoff**:
The orchestrator's opening move: create the spec branch, then start the topologically-first tracer-bullet. Unattended it is fired by labelling the spec issue and starts the slice by labelling it; attended it is the first turn of the *slice loop*. The spec is identified **structurally** — it has tracer-bullets and no `## Parent` of its own — not by a title prefix or a `spec` label. `/to-spec` adds only a `ready-for-agent` triage label — which tracer-bullets carry too — so no label distinguishes a spec from its slices.

**Advance**:
What happens once a tracer-bullet PR has merged into a spec branch: close that tracer-bullet issue (merging into a non-default base does **not** auto-close it), recompute the slice set live, then start the next single tracer-bullet in topological order (ties broken deterministically) — and when the last one closes, open the final spec→default PR. Posts a *progress comment* on the spec issue. Unattended it is fired by the merge and starts the next slice by labelling it; attended it is one turn of the *slice loop*. The **decision** of which slice comes next is shared; only how that slice is started differs.

**Slice loop**:
The attended form of spec orchestration: a loop that picks the next tracer-bullet, builds it, merges it, advances, and repeats — rather than each step being fired by an event. Same decisions, same per-slice PRs, same gates, same resulting history; what disappears is labelling-as-dispatch, which exists only because an unattended run needs a transport. Halts on a failed slice rather than skipping it, because every later slice assumes the earlier ones landed.
_Avoid_: batch run, spec runner

**Resume**:
Picking up an interrupted spec where it stopped. State is derived entirely from the tracker and the branches — never from a local file — so a spec can be interrupted under one entry point and continued under the other, and edits made directly in the tracker are honoured. A slice that already has an open unmerged PR resumes at its gate, not at its agent run.

**Slice merge**:
Under a spec a tracer-bullet skips per-slice review (ADR-0004): `implement`'s finalize opens a ready PR to the spec branch (detected via `base.ref ~ agent/spec-*`) and merges it straight in, which fires advance. The per-slice quality gate is the implement agent's own test loop; the single human gate is the final spec→default PR. (An earlier design ran a per-slice `review-pr`→`implement-pr` loop here — dropped because `review-pr` emits only advisory `COMMENT`s, with no approve/request-changes verdict to drive on; see ADR-0004.)

**Progress comment**:
The checkbox rollup the orchestrator posts on the *spec* issue at every kickoff and advance (`spec-report.mts`) — the slices in topological order, which are closed, which is building. It is what makes a spec readable to anyone who is not the person running it.
_Avoid_: dashboard (that word now belongs to the *status view*), progress report

### Observability

**Status view**:
The read-only terminal view of specs currently building and their tracer-bullets' states — `agent-workflows status`, a third entry point to the package alongside the workflow and local sequencers. Runs no agent, follows no hook contract, and writes nothing: a label write would be a dispatch. Scoped to the repo it is standing in. Reads the tracker for the tree and the local Claude Code CLI for *quota headroom*, and nothing else — the second source is what the tracker structurally cannot answer. See ADR-0007.
_Avoid_: dashboard (ambiguous while the *progress comment* was also called one), monitor, TUI

**Quota headroom**:
The share of the account's rolling session and weekly limits still unconsumed — what the status view leads with, above the tree. Account-global rather than per-spec, so it is a line and never a column. It is the fleet's bound too, not just the operator's: every verb runs under a subscription token, so CI drains the same windows interactive work does — and drains them invisibly, since consuming a week's headroom moves no label and closes no issue. Distinct from the **run ceiling**, which bounds one run; headroom bounds all work everywhere.
_Avoid_: usage (consumption already incurred, which points at the opposite decision), cost, spend, budget, quota (bare — the limit, not what is left of it)

**Spec tree**:
The shared reader (`shared/spec-tree.mts`) that resolves a repo's specs and their tracer-bullets with states. It holds both edge rules, and they are deliberately different rules (ADR-0007). Membership is **native-first**: a slice's spec is GitHub's sub-issue `parent` where that edge exists and the body's textual `## Parent` otherwise. Dependencies are a **union**, not a fallback: `unionBlockers` merges the native `blockedBy` edges with the `## Blocked by` refs, because a parent is one value while blockers are a set — over-blocking is a deadlocked row a human clears, under-blocking builds on a dependency that has not landed. Both make adopting native hierarchy gradual and per-repo rather than a flag day. A native blocker in another repository is excluded from the order and shown instead, since issue numbers are per-repo; the native sub-issue priority order is never displayed. The orchestrator takes the union too, and still resolves membership textually — it adopts that rule when native parents are written rather than merely read.

### Tracker

**Tracker**:
The system of record for the work an agent acts on — GitHub Issues or Linear. GitHub Issues always serve as the workflow *trigger* even when Linear is the tracker.

**Tracker-agnostic**:
The defining property of the central **workflow**: the YAML performs zero tracker reads or writes and contains no `if: tracker == …` branch. It is **not** a property of the package — since the hooks moved in, twenty-odd files under `src/` shell out to `gh`, and the *status view* reads the tracker too. The package ships GitHub as the **default** tracker and keeps it replaceable behind the hook and override seams; the workflow knows nothing either way.

**Trigger label**:
An `agent:<verb>` label on an issue or PR that **starts** a run — the counterpart of a *state label*, which **reports** one. What distinguishes the two is what the label does, not who writes it: a human applies one by hand, and the *orchestrator* applies one when it dispatches work (both *kickoff* and *advance* label the next tracer-bullet `agent:implement`; *advance* also labels the final spec→default PR `agent:review-pr` when it opens it, so the whole feature gets one advisory review at the spec boundary — ADR-0004). Retired by the run's own `<verb>-status` hook as it goes in-progress, so a trigger label still sitting on an issue means nothing picked it up.

**State label**:
A label the fleet sets and clears, never a human: `agent:in-progress`, `agent:review`, `agent:blocked`. For Linear repos the equivalent is a Linear state, written by the `<verb>-status` hook.

**Local-run marker**:
`agent:local` on a *spec* issue: an attended local run owns that spec's sequencing, so unattended **advance** stands down while it is present. Neither a trigger label (nothing triggers on it) nor a state label (it is scoped to a run, not to an issue's progress) — it exists because advance is fired by a *merge* rather than a label, and a local run merges too. Held for the length of a real run and released with the local lock; a marker found while holding that lock was left by a crashed run and is *reclaimed*, never refused.
_Avoid_: lock (that is the local, filesystem mutex), `agent:in-progress` (the between-entry-points mutex on one issue)

### Config

**Bootstrap**:
The consuming repo's own command for making a freshly-created working tree runnable — dependencies installed, database prepared, whatever the stack needs. The *sequencer* invokes it and knows nothing about its contents; on an unattended run the workflow environment does the same job with toolchain steps and service containers. The seam that keeps stack-specific setup out of the central repo, the same way *hooks* keep tracker-specific work out of it.
_Avoid_: setup, provision, install

**Essential drift**:
A value that genuinely differs between repos for a real reason — kept as a `with:` input (`system-packages`, `database-url`, `git-author-email`).

**Accidental drift**:
A value that differs only because the copies fell out of sync (action pin versions, postgres image, workflow names). Standardized to one value in the central repo; not config.
