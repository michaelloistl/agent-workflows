# Agent Workflows

The central, public repo (`michaelloistl/agent-workflows`) that holds the **reusable GitHub Actions workflows** driving the label-triggered coding-agent fleet across multiple project repos. It owns only the generic, tracker-agnostic orchestration shell; every repo- or domain-specific decision lives in the consuming repo.

## Language

### Repos and reuse

**Central repo**:
This repo. Holds the reusable workflows and their version tags. Generic only — knows nothing about any project's tracker, stack specifics, or domain.
_Avoid_: shared repo, actions repo

**Consuming repo**:
A project repo (e.g. lauza_loistl, ldf, on-vantage) that calls the central workflows and supplies its own config and hooks.
_Avoid_: client repo, child repo, downstream repo

**Fleet**:
The full set of five agent workflows operating in one consuming repo.

**Reusable workflow**:
A central workflow file invoked via `uses:` with `on: workflow_call`. Holds jobs, services, and steps.

**Thin caller**:
The minimal workflow file in a consuming repo: event triggers + `workflow_dispatch` + `uses:` the central workflow + `with:` config + `secrets: inherit`. One per verb.
_Avoid_: wrapper, stub

### Agent runs

**Verb**:
One of the five agent actions: `explore`, `implement`, `implement-pr`, `review-pr`, `update-branch`.

**Orchestrator**:
A workflow that sequences a *verb* over a graph of issues but runs **no agent of its own** — pure tracker/graph work (`gh` reads, label and state changes, branch and PR creation). `implement-prd` is the first orchestrator: it drives `implement` across a PRD's tracer-bullets. It is **not** a sixth verb (it triggers no agent action) and does **not** follow the 5-hook contract. Like the verbs, its tracker I/O stays behind sandcastle hooks; the central YAML is a lightweight shell (node + `gh`, no postgres/redis/ruby).
_Avoid_: meta-verb, super-verb, sixth verb

**Sandcastle**:
The `@ai-hero/sandcastle` package and the per-repo `.sandcastle/` code that frames an agent run as a single `run()` call. The home of all tracker-aware and domain-aware logic.

**Hook**:
A sandcastle command the central workflow calls at a fixed point in a verb's sequence: `<verb>`, `<verb>-guards`, `<verb>-fetch-spec`, `<verb>-status`, `<verb>-finalize`. The interface between generic YAML and repo-specific logic.

**Hook contract**:
The fixed set of hook command names and their expected behaviour that the central workflow depends on. Stable across all consuming repos; only the implementations differ.

**Guard**:
A preflight check run before the agent (PRD, shape, blocked-by, existing-PR for GitHub repos). Lives in the `<verb>-guards` hook.

**Refusal**:
A guard declining to run. The guard posts its own explanation and clears the trigger label, then signals non-zero so the workflow skips the rest. A refusal is **not** a failure.
_Avoid_: rejection, error, block

### PRD orchestration

**PRD branch**:
A single long-lived `agent/prd-<n>-…` branch cut once from the default branch by the `implement-prd` orchestrator. It is the **base** every tracer-bullet of that PRD branches from and merges back into. When the last tracer-bullet lands, the PRD branch holds the whole feature and one PR `PRD branch → default` goes up for final human review.
_Avoid_: feature branch, epic branch, integration branch

**Tracer-bullet**:
A thin, independently-buildable vertical slice of a PRD — a standalone issue carrying a textual `## Parent` reference to the PRD and a `## Blocked by` section. **Not** a GitHub sub-issue (the `implement` issue-shape guard refuses sub-issues and epics), so the PRD↔tracer-bullet link is textual, not native.

**Stacked**:
The topology where each tracer-bullet branches from the current PRD-branch HEAD and its PR targets the PRD branch (not the default branch) — so each slice sees the accumulated work of the ones before it.

**Strictly sequential**:
The orchestrator runs **one tracer-bullet at a time** in topological (dependency) order, never a parallel wave. Because nothing else touches the PRD branch while a slice is in flight, every merge back into the PRD branch is conflict-free by construction — the deliberate trade of wall-clock speed for zero agent-generated merge conflicts.

**Kickoff**:
The orchestrator entry point fired by labelling the PRD issue: create the PRD branch, then label the topologically-first tracer-bullet `agent:implement`. The PRD is identified **structurally** — it has tracer-bullets and no `## Parent` of its own — not by a title prefix or a `prd` label, since `/to-prd` adds neither.

**Advance**:
The orchestrator entry point fired when a tracer-bullet PR merges into a PRD branch: close that tracer-bullet issue (merging into a non-default base does **not** auto-close it), then label the next single tracer-bullet in topological order (ties broken deterministically) — and when the last one closes, open the final PRD→default PR. Posts a progress comment on the PRD issue so it reads as the dashboard.

**Slice review loop**:
The autonomous per-slice review a tracer-bullet PR runs in place of a human gate when it targets a PRD branch: `implement` (opens the PR) → `agent:review-pr` (agent reviews it) → `agent:implement-pr` (agent addresses the review) → auto-merge into the PRD branch. Self-propelling — each verb's `finalize` hook detects PRD context (`base.ref ~ agent/prd-*`) and applies the next label; no central conductor. Only the final PRD→default PR gets a human gate.

### Tracker

**Tracker**:
The system of record for the work an agent acts on. GitHub Issues (lauza, ldf) or Linear (on-vantage). GitHub Issues always serve as the workflow *trigger* even when Linear is the tracker.

**Tracker-agnostic**:
The defining property of the central workflow: it performs zero tracker reads or writes and contains no `if: tracker == …` branch. All tracker I/O is behind hooks.

**Trigger label**:
A human-applied `agent:<verb>` label on an issue or PR that starts a workflow.

**State label**:
A label the fleet sets and clears, never a human: `agent:in-progress`, `agent:review`, `agent:blocked`. For Linear repos the equivalent is a Linear state, written by the `<verb>-status` hook.

### Config

**Essential drift**:
A value that genuinely differs between repos for a real reason — kept as a `with:` input (`system-packages`, `database-url`, `git-author-email`).

**Accidental drift**:
A value that differs only because the copies fell out of sync (action pin versions, postgres image, workflow names). Standardized to one value in the central repo; not config.
