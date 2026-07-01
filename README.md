# agent-workflows

Central **Reusable GitHub Actions workflows** that drive a
label-triggered coding-agent fleet across multiple project repos. The central Workflows own only the generic, tracker-agnostic orchestration shell; every
repo- or domain-specific decision lives behind sandcastle hooks in the consuming repo.

You label an issue or PR (e.g. `agent:implement`); the matching reusable
workflow checks out your repo, spins up its toolchain, runs Claude Code against the work, pushes the result, and reports back to your tracker — all without the central YAML knowing anything about your tracker, stack, or domain.

The individual verbs work on any issue spec. The **PRD orchestrator**
(`implement-prd`), however, expects its issues to be authored by
[mattpocock/skills](https://github.com/mattpocock/skills) `/to-prd` and
`/to-issues`: it parses the exact `## Parent` / `## Blocked by` body format those
commands emit. See [Authoring PRD issues](#authoring-prd-issues) for the contract.

## Contents

- [How it works](#how-it-works)
- [The workflows](#the-workflows)
- [Authoring PRD issues](#authoring-prd-issues)
- [Labels](#labels)
- [Installation](#installation)
- [Usage](#usage)
- [Inputs](#inputs)
- [Secrets](#secrets)
- [Repo layout](#repo-layout)
- [Local checks](#local-checks)

## How it works

Three pieces collaborate:

1. **Reusable workflow** (this repo, `on: workflow_call`) — the generic shell.
   It checks out code, installs the toolchain (Node always; Ruby/Postgres/Redis
   optionally), runs Claude Code, and pushes results with plain git. It performs
   **zero** tracker I/O and contains no `if: tracker == …` branch (ADR-0001).
2. **Thin caller** (your repo) — a tiny workflow file that triggers on a label
   and `uses:` the reusable workflow with your config. One per verb.
3. **Sandcastle hooks** (the `agent-workflows` package, installed in your repo)
   — `yarn` scripts the reusable workflow calls at fixed points to do all
   tracker-aware and domain-aware work: read the spec, post comments, open PRs,
   set labels. Your `package.json` wires each script at the packaged dispatcher
   bin; you host no hook code unless you override one.

At fixed points in each run the workflow calls these hooks (your repo implements
each as a `yarn` script — see [`docs/hook-contract.md`](docs/hook-contract.md)):

| Hook | When | Does |
|---|---|---|
| `sandcastle:<verb>-guards` | first, in a light guard job | preflight; on refusal, retire the trigger label + comment why. Exit `0` = proceed, non-zero = **refused** (skip the run — not a failure) |
| `sandcastle:<verb>-status <state>` | start / success / failure | apply the tracker state (`in-progress` / `review` / `done` / `blocked`) |
| `sandcastle:<verb>-fetch-spec` | issue verbs only | write the issue spec to `$SPEC_FILE`; `implement` also emits the branch name |
| `sandcastle:<verb>` | the agent run | do the work; write the verb's output file |
| `sandcastle:<verb>-finalize` | after a successful run (post-push) | post results to the tracker (comment / review / draft PR / threaded replies) |

This repo's `src/` is the **reference GitHub-Issues implementation** of that
contract (`shared/github.mts` is the tracker adapter), distributed as the
`agent-workflows` package. A GitHub repo installs it as a git dependency; a
Linear repo swaps the adapter behind the same hook names (packaged separately —
see #33). The repo is its own first consumer — the
`.github/workflows/agent-*.yml` callers here dogfood the central workflows,
running the dispatcher against `src/` directly.

## The workflows

Five **verbs** (each runs a Claude Code agent) plus one **orchestrator** (runs
no agent — it sequences a verb over a graph of issues).

| Workflow | Trigger | Agent does | Reports back |
|---|---|---|---|
| **`explore.yml`** | `agent:explore` on an **issue** | read-only investigation of the codebase to answer the issue | posts an exploration comment |
| **`implement.yml`** | `agent:implement` on an **issue** | builds the issue on a fresh `agent/…` branch, commits, runs its own test loop | pushes the branch; opens a draft PR (`agent:review`) |
| **`implement-pr.yml`** | `agent:implement` on an open **PR** | reads the PR diff + review comments, makes the requested changes, commits | pushes (plain, never `--force`); posts threaded replies |
| **`review-pr.yml`** | `agent:review-pr` on an open **PR** | read-only review of the PR | posts a GitHub review (inline comments + summary, advisory `COMMENT`) |
| **`update-branch.yml`** | `agent:update-branch` on an open **PR** | merges the PR's base branch into the PR branch, resolving conflicts | pushes the merge; comments the outcome |
| **`implement-prd.yml`** | `agent:implement-prd` on a PRD **issue**, plus PR-merge events | orchestrator: sequences `implement` across a PRD's tracer-bullets on a shared `agent/prd-…` branch, strictly sequentially | dispatches slices; opens the final PRD→default PR |

A few details worth knowing:

- **`implement` vs `implement-pr`** share the `agent:implement` label and are told
  apart by the trigger *event*: an `issues` event runs `implement`, a
  `pull_request` event runs `implement-pr`.
- **PR verbs** (`implement-pr`, `review-pr`, `update-branch`) run the agent
  against the PR head but load the **default branch's** tooling from a detached
  worktree — so a PR branch that predates the tooling still works. They gather
  their own PR context, so they have no `fetch-spec` hook.
- **`implement-prd`** is an orchestrator, not a sixth verb: it triggers no agent,
  only `gh`/graph work (cut the PRD branch, label the next tracer-bullet, open
  PRs). It runs in two modes wired as two callers — `kickoff` (on the PRD-issue
  label) and `advance` (on a tracer-bullet PR merging into the PRD branch). See
  [`CONTEXT.md`](CONTEXT.md) and ADR-0003/0004 for the PRD model.

## Authoring PRD issues

The PRD orchestrator (`implement-prd`) is built to run on issues authored by
[mattpocock/skills](https://github.com/mattpocock/skills) `/to-prd` and
`/to-issues`. The intended end-to-end flow is:

1. **`/to-prd`** turns a request into a **PRD issue** (a problem/solution brief).
2. **`/to-issues`** breaks that PRD into **tracer-bullet issues** — thin,
   independently-buildable vertical slices, each linking back to the PRD.
3. You apply **`agent:implement-prd`** to the PRD issue; the orchestrator builds
   the tracer-bullets one at a time on a shared PRD branch and opens the final
   PRD→default PR for review (see [The workflows](#the-workflows)).

The issue **body format is a load-bearing contract** — discovery parses it
structurally, not by title or label. If the headings drift, orchestration breaks.

**PRD issue** — identified *structurally*, not by a `PRD:` title prefix or a `prd`
label (`/to-prd` adds neither):

- It has **no `## Parent` section** of its own.
- One or more tracer-bullets reference it as their `## Parent`.

```markdown
# Add CSV export to the reports page

Users need to export any report as CSV. Today there's no way to get the data out…
(problem / solution prose — no `## Parent` section)
```

**Tracer-bullet issue** — a slice of the PRD:

- A **`## Parent`** section containing the PRD's `#<number>` (the first `#N` in the
  section wins).
- An optional **`## Blocked by`** section listing `#<number>` refs to other
  tracer-bullets it depends on (used to sequence the build in topological order,
  lowest issue number first).
- Headings at **`##`** level.
- A plain issue — **not** a native GitHub sub-issue or epic (the `implement`
  shape guard refuses those; the PRD↔tracer-bullet link is textual).

```markdown
# Add a CSV serializer for report rows

## Parent
#42

## Blocked by
- #43

## What to build
A serializer that turns a report's rows into RFC-4180 CSV…
```

## Labels

The fleet is driven entirely by labels. **Trigger labels** are applied by a human
to start a run; **state labels** are set and cleared only by the fleet.

**Trigger labels** (create these in each consuming repo):

| Label | Apply to | Starts |
|---|---|---|
| `agent:explore` | issue | `explore` |
| `agent:implement` | issue | `implement` |
| `agent:implement` | open PR | `implement-pr` |
| `agent:review-pr` | open PR | `review-pr` |
| `agent:update-branch` | open PR | `update-branch` |
| `agent:implement-prd` | PRD issue | `implement-prd` (kickoff) |

The PRD **advance** step needs no label — it fires automatically when a
tracer-bullet PR merges into an `agent/prd-*` branch.

**State labels** (managed by the `<verb>-status` hook; never set these by hand):

| Label | Meaning |
|---|---|
| `agent:in-progress` | a run has started |
| `agent:review` | `implement` succeeded; a draft PR awaits human review |
| `agent:blocked` | a run failed or was aborted; see the comment for why + the run URL |

A refusal (a guard declining to run) is **not** a failure: the guard clears the
trigger label and comments why, and never sets `agent:blocked`.

## Installation

Set up a consuming repo in five steps.

**1. Add the sandcastle hooks.** Install the `agent-workflows` package as a git
dependency — no registry, no copied code. For a GitHub-Issues tracker the
packaged implementation works as-is. For Linear, swap the tracker adapter (see
#33).

```jsonc
{
  "devDependencies": { "agent-workflows": "github:michaelloistl/agent-workflows#v1" }
}
```

**2. Wire the hook scripts in `package.json`.** Point each `yarn` script at the
packaged dispatcher bin (`agent-workflows <verb> <hook>`; the agent-run script
is `<verb> run`) for every verb you use — and commit `yarn.lock` plus either a
`.node-version` file or pass `node-version` on the caller (Node and Yarn are
unconditional; the package pulls in `tsx`):

```jsonc
{
  "scripts": {
    "sandcastle:implement":            "agent-workflows implement run",
    "sandcastle:implement-guards":     "agent-workflows implement guards",
    "sandcastle:implement-fetch-spec": "agent-workflows implement fetch-spec",
    "sandcastle:implement-status":     "agent-workflows implement status",
    "sandcastle:implement-finalize":   "agent-workflows implement finalize"
    // …repeat for each verb you use; see this repo's package.json for the full set
  }
}
```

To customize a hook, drop a single file at
`.sandcastle/agent-workflows/<verb-dir>/<entry>.mts` (or `prompt.md`) — the
dispatcher resolves it override-first, else the packaged default.

**3. Create the trigger labels** listed in [Labels](#labels) for each verb you
enable (the state labels are created on first use by the hooks).

**4. Add the secrets** (repo or org level): `CLAUDE_CODE_OAUTH_TOKEN` is
required; `AGENT_PAT`, `RAILS_MASTER_KEY`, `LINEAR_API_KEY` are optional — see
[Secrets](#secrets).

**5. Add a thin caller per verb** under `.github/workflows/`. See
[Usage](#usage). Issue-triggered callers must live on the **default branch** to
fire (label events run workflows from the default branch).

## Usage

Each verb is one thin caller. Pin `@main` for the latest, or pin a tag/SHA to
freeze the version.

### Issue verbs — `explore`, `implement`

Trigger on the `issues` `labeled` event:

```yaml
# .github/workflows/agent-implement.yml
name: Agent Implement
on:
  workflow_dispatch:
  issues:
    types: [labeled]
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  implement:
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'agent:implement'
    uses: michaelloistl/agent-workflows/.github/workflows/implement.yml@main
    with:
      enable-ruby: true            # false on non-Rails repos (ADR-0002)
      git-author-email: agent@example.com
    secrets: inherit
```

`explore` is identical with `explore.yml`, the `agent:explore` label, and
read-only permissions (`contents: read`, `issues: write`, `pull-requests: read`).

### PR verbs — `implement-pr`, `review-pr`, `update-branch`

Trigger on `pull_request_target` so the run carries secrets. On a **public**
repo, gate to internal authors so an external PR can never trigger a run:

```yaml
# .github/workflows/agent-review-pr.yml
name: Agent Review PR
on:
  workflow_dispatch:
  pull_request_target:
    types: [labeled]
permissions:
  contents: read
  issues: write
  pull-requests: write
jobs:
  review-pr:
    if: >-
      (github.event_name == 'workflow_dispatch' || github.event.label.name == 'agent:review-pr')
      && (github.event_name == 'workflow_dispatch'
          || contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.pull_request.author_association))
    uses: michaelloistl/agent-workflows/.github/workflows/review-pr.yml@main
    with:
      enable-ruby: true
      git-author-email: agent@example.com
    secrets: inherit
```

`implement-pr` uses the `agent:implement` label (distinguished from the
issue-triggered `implement` by the PR event) and needs `contents: write`.
`update-branch` uses `agent:update-branch` and `contents: write`.

### PRD orchestrator — `implement-prd`

The orchestrator needs **two** callers. Kickoff fires on the PRD-issue label and
passes `mode: kickoff`:

```yaml
# .github/workflows/agent-implement-prd-kickoff.yml
name: Agent Implement PRD (kickoff)
on:
  workflow_dispatch:
  issues:
    types: [labeled]
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  kickoff:
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'agent:implement-prd'
    uses: michaelloistl/agent-workflows/.github/workflows/implement-prd.yml@main
    with:
      mode: kickoff
      git-author-email: agent@example.com
    secrets: inherit
```

Advance fires when a tracer-bullet PR merges into a PRD branch and passes
`mode: advance` (no label, plain `pull_request` — it runs no PR-head code):

```yaml
# .github/workflows/agent-implement-prd-advance.yml
name: Agent Implement PRD (advance)
on:
  pull_request:
    types: [closed]
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  advance:
    # Only a merged tracer-bullet PR into a PRD branch. The final PRD→default PR
    # has base == default branch, so it does NOT match and does NOT re-trigger.
    if: >-
      github.event.pull_request.merged == true
      && startsWith(github.event.pull_request.base.ref, 'agent/prd-')
    uses: michaelloistl/agent-workflows/.github/workflows/implement-prd.yml@main
    with:
      mode: advance
      git-author-email: agent@example.com
    secrets: inherit
```

## Inputs

The five verbs share the same inputs:

| Input | Type | Default | Notes |
|---|---|---|---|
| `git-author-email` | string | — | **required**; email for the agent git identity |
| `git-author-name` | string | `Sandcastle Agent` | name for the agent git identity |
| `enable-ruby` | boolean | `true` | install the Ruby toolchain + prepare the test DB (Rails repos). Set `false` on non-Rails repos (ADR-0002) |
| `database-url` | string | `postgres://postgres:postgres@localhost:5432/test` | `DATABASE_URL` the agent's feedback loop uses |
| `system-packages` | string | `""` | space-separated apt packages to install before the run |
| `agent-model` | string | `""` | Claude model id for the agent run; empty uses the package's pinned default |
| `node-version` | string | `""` | Node version (e.g. `"20"`, `"lts/*"`). When empty, falls back to the consuming repo's `.node-version` file |

The `implement-prd` orchestrator is lighter (no build toolchain) and takes only:

| Input | Type | Default | Notes |
|---|---|---|---|
| `git-author-email` | string | — | **required** |
| `git-author-name` | string | `Sandcastle Agent` | name for the agent git identity |
| `mode` | string | — | **required**; `kickoff` or `advance` |
| `node-version` | string | `""` | Node version (e.g. `"20"`, `"lts/*"`). When empty, falls back to the consuming repo's `.node-version` file |

## Secrets

Pass with `secrets: inherit`.

| Secret | Required | Used for |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | **yes** | authenticates the Claude Code agent |
| `AGENT_PAT` | no | a PAT used for `git push` and PR creation so the resulting PR triggers downstream CI (a `GITHUB_TOKEN` push does not). Falls back to `GITHUB_TOKEN` when unset |
| `RAILS_MASTER_KEY` | no | Rails repos that need it to prepare the test DB / run the app |
| `LINEAR_API_KEY` | no | Linear-tracker repos (consumed by the swapped tracker adapter, not the central YAML) |

## Repo layout

- **`.github/workflows/{explore,implement,implement-pr,review-pr,update-branch}.yml`**
  — the five reusable verbs (`on: workflow_call`). Tracker-agnostic; zero tracker
  I/O.
- **`.github/workflows/implement-prd.yml`** — the reusable PRD orchestrator
  (kickoff + advance modes).
- **`.github/workflows/agent-*.yml`** — this repo's own thin callers. It is its
  own first consumer (the dogfooding plumbing test), running the dispatcher
  against `src/` directly rather than installing itself.
- **`src/`** — the reference **GitHub-Issues** implementation of the hook
  contract (`shared/github.mts` is the tracker adapter), distributed as the
  `agent-workflows` package. Consuming GitHub repos install it as a git
  dependency; a Linear repo swaps the adapter (packaged separately, #33).
- **`bin/agent-workflows.mjs`** — the dispatcher: maps `<verb> <hook>` to a
  `src/` entrypoint (override-first) and runs it under `tsx`.
- **`docs/hook-contract.md`** — the interface every consuming repo implements.
- **`CONTEXT.md`** — glossary. **`PLAN.md`** — build plan + rollout.
  **`docs/adr/`** — architecture decisions (0001 thin reusable workflows; 0002
  toolchain generalization + feedback-loop boundary; 0003 PRD strictly
  sequential; 0004 no per-slice review).

## Local checks

```sh
yarn install
yarn typecheck
yarn test
```
