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
