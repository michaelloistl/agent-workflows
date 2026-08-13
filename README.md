# agent-workflows

Central **Reusable GitHub Actions workflows** that drive a
label-triggered coding-agent fleet across multiple project repos. The central Workflows own only the generic, tracker-agnostic orchestration shell; every
repo- or domain-specific decision lives behind sandcastle hooks in the consuming repo.

You label an issue or PR (e.g. `agent:implement`); the matching reusable
workflow checks out your repo, spins up its toolchain, runs Claude Code against the work, pushes the result, and reports back to your tracker — all without the central YAML knowing anything about your tracker, stack, or domain.

The individual verbs work on any issue spec. The **spec orchestrator**
(`implement-spec`), however, expects its issues to be authored by
[mattpocock/skills](https://github.com/mattpocock/skills) `/to-spec` and
`/to-tickets`: it parses the exact `## Parent` / `## Blocked by` body format those
commands emit. See [Authoring spec issues](#authoring-spec-issues) for the contract.

## Contents

- [How it works](#how-it-works)
- [The workflows](#the-workflows)
- [Authoring spec issues](#authoring-spec-issues)
- [Labels](#labels)
- [Installation](#installation)
- [Usage](#usage)
- [Status view](#status-view)
- [Inputs](#inputs)
- [Secrets](#secrets)
- [Repo layout](#repo-layout)
- [Local checks](#local-checks)
- [Releasing](#releasing)

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
| **`implement-spec.yml`** | `agent:implement-spec` on a spec **issue**, plus PR-merge events | orchestrator: sequences `implement` across a spec's tracer-bullets on a shared `agent/spec-…` branch, strictly sequentially | dispatches slices; opens the final spec→default PR and labels it `agent:review-pr` for an advisory review |

A few details worth knowing:

- **`implement` vs `implement-pr`** share the `agent:implement` label and are told
  apart by the trigger *event*: an `issues` event runs `implement`, a
  `pull_request` event runs `implement-pr`.
- **PR verbs** (`implement-pr`, `review-pr`, `update-branch`) run the agent
  against the PR head but load the **default branch's** tooling from a detached
  worktree — so a PR branch that predates the tooling still works. They gather
  their own PR context, so they have no `fetch-spec` hook.
- **`implement-spec`** is an orchestrator, not a sixth verb: it triggers no agent,
  only `gh`/graph work (cut the spec branch, label the next tracer-bullet, open
  PRs). It runs in two modes wired as two callers — `kickoff` (on the spec-issue
  label) and `advance` (on a tracer-bullet PR merging into the spec branch). See
  [`CONTEXT.md`](CONTEXT.md) and ADR-0003/0004 for the spec model.

## Authoring spec issues

The spec orchestrator (`implement-spec`) is built to run on issues authored by
[mattpocock/skills](https://github.com/mattpocock/skills) `/to-spec` and
`/to-tickets`. The intended end-to-end flow is:

1. **`/to-spec`** turns a request into a **spec issue** (a problem/solution brief).
2. **`/to-tickets`** breaks that spec into **tracer-bullet issues** — thin,
   independently-buildable vertical slices, each linking back to the spec.
3. You apply **`agent:implement-spec`** to the spec issue; the orchestrator builds
   the tracer-bullets one at a time on a shared spec branch and opens the final
   spec→default PR for review (see [The workflows](#the-workflows)).

The issue **body format is a load-bearing contract** — discovery parses it
structurally, not by title or label. If the headings drift, orchestration breaks.

**Spec issue** — identified *structurally*, not by a `spec:` title prefix or a `spec`
label (`/to-spec` applies only the `ready-for-agent` triage label, which
tracer-bullets carry too, so no label distinguishes a spec from its slices):

- It has **no `## Parent` section** of its own.
- One or more tracer-bullets reference it as their `## Parent`.

```markdown
# Add CSV export to the reports page

Users need to export any report as CSV. Today there's no way to get the data out…
(problem / solution prose — no `## Parent` section)
```

**Tracer-bullet issue** — a slice of the spec:

- A **`## Parent`** section containing the spec's `#<number>` (the first `#N` in the
  section wins).
- An optional **`## Blocked by`** section listing `#<number>` refs to other
  tracer-bullets it depends on (used to sequence the build in topological order,
  lowest issue number first). GitHub's native **blocked-by** relationship counts
  too: the two are unioned, so a repo can declare dependencies either way, or
  half each while it migrates. `agent:implement` refuses on a still-open blocker
  from either source, so a slice started by hand stops at the same point the
  orchestrator would have.
- Headings at **`##`** level.
- A plain issue — **not** a native GitHub sub-issue or epic (the `implement`
  shape guard refuses those; the spec↔tracer-bullet link is textual).

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
to start a run — or by the orchestrator when it dispatches work; **state labels**
are set and cleared only by the fleet.

**Trigger labels** (create these in each consuming repo):

| Label | Apply to | Starts |
|---|---|---|
| `agent:explore` | issue | `explore` |
| `agent:implement` | issue | `implement` |
| `agent:implement` | open PR | `implement-pr` |
| `agent:review-pr` | open PR | `review-pr` |
| `agent:update-branch` | open PR | `update-branch` |
| `agent:implement-spec` | spec issue | `implement-spec` (kickoff) |

The spec **advance** step needs no label — it fires automatically when a
tracer-bullet PR merges into an `agent/spec-*` branch. When the last tracer-bullet
lands, advance opens the final spec→default PR and applies `agent:review-pr` to it,
so the whole feature gets one advisory review at the spec boundary (ADR-0004). It
creates the label first if the repo lacks it, and applies it only on the PR it just
opened — a run that finds the final PR already open leaves it alone. Turn that review
off with `finalPrReview: false` in the config file (or `FINAL_PR_REVIEW=false` per run).

**State labels** (managed by the `<verb>-status` hook; never set these by hand):

| Label | Meaning |
|---|---|
| `agent:in-progress` | a run has started |
| `agent:review` | `implement` succeeded; a draft PR awaits human review |
| `agent:blocked` | a run failed or was aborted; see the comment for why + the run URL |

A refusal (a guard declining to run) is **not** a failure: the guard clears the
trigger label and comments why, and never sets `agent:blocked`.

**Run marker** (managed by the attended spec loop; never set this by hand):

| Label | Applied to | Meaning |
|---|---|---|
| `agent:local` | spec issue | an attended local run owns this spec's sequencing; CI **advance** stands down while it is present |

Nothing triggers on `agent:local` — it is read, never reacted to. The loop creates
it on first use, claims it before its first merge, and releases it when the run
ends (see the attended spec loop below).

## Installation

Set up a consuming repo in five steps. The tracker reads need **`gh` 2.94 or
newer** — that is where the `parent` and `blockedBy` JSON projections landed, and
both the orchestrator and the status view ask for them. GitHub-hosted runners
have been past that for a while; a local install that is not will fail the read
with an unknown-field error rather than degrading.

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

**Optional: tune sequencer behaviour with a config file.** Values the sequencer
itself acts on live in an optional `.sandcastle/agent-workflows/config.json`
committed to the consuming repo — separate from the toolchain values (Ruby
enablement, system packages, Node version, database URL) that stay `with:` inputs
because only GitHub Actions can act on them. Every value resolves per-run override
→ file → default, so absent the file behaviour is unchanged:

```jsonc
{
  // Integration branch every verb bases on and targets (agent branch, PR base,
  // PR-verb tooling ref, spec branch). Absent → the repository default branch. A
  // tracer-bullet under a spec still bases on its spec branch.
  "baseBranch": "develop",
  // Model the fleet's agents run on. Absent → the packaged default.
  "agentModel": "claude-opus-4-8",
  // CI check-poll timings for the merge gates, in seconds (env overrides win:
  // CHECKS_INTERVAL_SECONDS / CHECKS_TIMEOUT_SECONDS / CHECKS_GRACE_SECONDS).
  "checks": { "intervalSeconds": 15, "timeoutSeconds": 1200, "graceSeconds": 180 },
  // Attended local runs only (see below). Root the per-run worktree is created
  // under (WORKTREE_ROOT overrides; absent → an OS-temp dir), and the opaque
  // command that makes a fresh worktree runnable (BOOTSTRAP overrides; absent →
  // no bootstrap step).
  "worktreeRoot": "/Users/you/.agent-worktrees",
  "bootstrap": "yarn install",
  // Attended spec loop only. Ceiling on what one run may spend before you see it
  // again — slices attempted, wall-clock (seconds), or both (env overrides win:
  // RUN_CEILING_MAX_SLICES / RUN_CEILING_MAX_WALLCLOCK_SECONDS). Absent → no ceiling.
  "runCeiling": { "maxSlices": 4, "maxWallClockSeconds": 3600 },
  // Whether the orchestrator labels the final spec→default PR `agent:review-pr` for
  // an advisory review when it opens it (FINAL_PR_REVIEW overrides). Absent → on.
  // Set to `false` to skip that review and its agent run; only an explicit `false`
  // (a real boolean here, the exact string "false" in the env) disables it.
  "finalPrReview": true
}
```

**Attended runs — start a verb from your terminal.** Alongside the label-triggered
fleet (the *unattended* path), you can run a verb on your own machine:

```sh
agent-workflows explore 55            # run `explore` locally against issue #55
agent-workflows implement 57          # build issue #57 end to end (--finalize=ask|never)
agent-workflows implement 57 --interactive   # steer a live agent session
```

Each run gets its own git **worktree** under `worktreeRoot` — never the checkout
you are sitting in — created detached at the configured base branch. The
`bootstrap` command runs on that fresh tree (a non-zero exit fails the run before
the agent starts), the agent's output streams to your terminal, and Ctrl-C aborts.
Credentials come from your already-authenticated `gh` and existing agent
credentials — the sequencer reads and writes no secret material. A `read-only`
run's clean worktree is removed on success; an `implement` worktree is **retained**
(it is what you inspect), and every run retains its tree on failure or abort. Each
verb runs the SAME sequence the unattended path hands the sequencer, so the two
paths cannot drift.

**Attended spec loop — build a whole spec from your terminal.** `implement-spec`
with a spec issue number drives the entire spec as a **slice loop**: it builds the
tracer-bullets one at a time, in topological order, on **one** worktree created on
the spec branch and bootstrapped once — each slice branching inside it from the
accumulated spec-branch HEAD (the stacked topology, setup paid once).

```sh
agent-workflows implement-spec 48              # DRY RUN (the default): preview + one pass
agent-workflows implement-spec 48 --execute    # real merges into the spec branch
agent-workflows implement-spec 48 --execute --force      # also overrule the local lock
agent-workflows implement-spec 48 --execute --no-pause   # run straight through, no checkpoints
agent-workflows implement-spec 48 --execute --interactive # steer a live session per slice
agent-workflows implement-spec 48 --execute --yes --no-pause # fully non-interactive
agent-workflows implement-spec 48 --stop       # from a SECOND terminal: graceful stop
```

Before the first agent runs it prints a **preview** — the resolved slice list in
topological order, the spec branch, the base branch, and whether this is a dry run
— and does not begin until you accept it. A **dry run** (the safer default) runs the
loop with every irreversible action suppressed, reports what a real run would do,
and halts where it would first merge — leaving no merge, no closed issue, and no
final PR behind; watch one pass before trusting it with real merges. An `--execute`
run merges each slice into the spec branch exactly as CI does, then **reads the PR's
merged state back from GitHub** before advancing — a queued, blocked, or stale merge
halts the run rather than being mistaken for a landed slice. Both CI gates are kept
(a slice cannot merge on red; the next slice cannot start on a red spec-branch tip),
a failed slice halts the whole run with no skip and no retry, the spec issue's
progress comment is posted each iteration, and the final spec→base PR opens — labelled
`agent:review-pr` for an advisory review — when the last slice lands. A spec run this
way produces the same git history and tracker state as the same spec run in CI,
because both paths open (and label) the final PR through the same shared routine.

**CI stands down while a local run owns the spec.** Merging a slice PR into the spec
branch is exactly the event the unattended **advance** workflow triggers on — and
advance responds by labelling the next tracer-bullet `agent:implement`, which would
start CI building the very slice the loop is about to build itself. So an `--execute`
run claims `agent:local` on the spec issue before its first merge, and the advance
guard **refuses** (stands down; not a failure, nothing is dispatched) while that
marker is present. The marker is released when the run ends — on completion, on any
halt, on a graceful stop, and on Ctrl-C. If a run dies hard and leaves the marker
behind, the next local run **reclaims** it rather than refusing to start (holding the
local lock proves no live local run owns it); to hand the spec straight back to CI
instead, remove the label by hand. A **dry run** never merges, so it never fires
advance and never takes the marker.

**Checkpoints, stopping, and resume (a long run made controllable).** The loop
**pauses at a checkpoint between slices by default** — the moment to inspect the
accumulated spec branch before the next slice stacks on it — and continues on
confirmation. `--no-pause` runs the whole spec straight through for a well-understood
spec; `--interactive` instead hands *each* slice's build to a live agent session, and
because that is per-slice it is rejected together with `--no-pause` (one stops at
every slice, the other never stops).

**Running without a human at the terminal.** Both the preview and the checkpoints are
read from stdin, and a non-interactive stdin **declines** — the safe default, but it
also means a launcher script, an unattended resume, or a command run from an agent
prompt can never start a run. `--yes` pre-accepts the *preview*; `--no-pause` covers
the *checkpoints*, so `--execute --yes --no-pause` is the fully non-interactive
combination. `--yes` does not suppress the preview: the whole blast radius is still
printed, followed by a line naming the flag that accepted it, so a run started this
way says so in its own log. It also does not weaken any gate — both CI gates, the
merge confirmation, the local lock, and the `agent:local` marker behave identically.

There are **two ways to stop**, and they are different:

- **Ctrl-C** in the running terminal **aborts immediately** — mid-slice it abandons a
  half-built tracer-bullet, leaving work for resume to untangle.
- **`agent-workflows implement-spec <spec> --stop`**, run from a **second terminal**
  (the running one is occupied), asks for a **graceful stop**: the loop finishes the
  slice it is on and halts at the next checkpoint, leaving a clean between-slices
  boundary. It finds the live run through the pid its local lock records.

**Run ceiling (a walk-away bound).** A slice loop over a whole spec is the longest,
most expensive thing you can start, so you can cap what one run spends before it
halts for you: `runCeiling.maxSlices`, `runCeiling.maxWallClockSeconds`, or both in
the config file (env overrides `RUN_CEILING_MAX_SLICES` / `RUN_CEILING_MAX_WALLCLOCK_SECONDS`
win per run). The ceiling is evaluated at each checkpoint, so a reached ceiling halts
**cleanly between slices, never mid-slice** — the same clean stop as a graceful stop,
reported distinctly from a failure, with what the run consumed against the ceiling
printed in the exit summary. A ceiling-halted spec **resumes** on re-run just like any
other clean halt. Absent configuration there is no ceiling — today's unbounded
behaviour.

**Resume derives entirely from the tracker and the branches — no local file is
consulted.** Re-running the same command picks up where the run stopped: closed
tracer-bullets are skipped, tracer-bullets **added after the run started** are picked
up (the slice set is recomputed every iteration), and a slice whose branch has an
**open unmerged PR resumes at its gate** — await checks, then merge — rather than
re-running the agent (the most expensive mistake the loop could make). Because state
is external, a spec interrupted under this local loop can be resumed by the unattended
orchestrator, and the reverse. The **worktree is removed once the final spec PR
opens** (the run is complete and the branch lives on the remote); every halt — a
failure, a Ctrl-C abort, a graceful stop, a checkpoint decline, a dry run — **retains**
it for inspection and resume.

**Run log and Herdr progress (a long run made legible).** Two optional, independent
surfaces make a run readable while it happens and after it ends — neither is a
dependency and both are strictly best-effort. An **append-only run log** at
`<worktreeRoot>/spec-<n>-run.log` records every transition the loop makes — slice,
action, outcome, timestamp, tab-separated — so a spec that halts at 2am leaves
something to read in the morning; the summary prints its path. It lives under the
worktree *root* (not inside the per-spec worktree, which is removed on completion),
so it survives both a halt and a completed run's cleanup. The log is **written, never
consulted**: nothing reads it to decide what happens next, so resume still derives
entirely from the tracker and the branches — it does not reintroduce local state.
When the loop runs inside a **Herdr-managed pane** (detected by the `HERDR_PANE`
environment variable Herdr sets), it also emits best-effort progress into the UI
already on screen — it renames the pane to the slice being built and fires a
notification on halt and on completion, via the `herdr` CLI. Outside a Herdr pane
**nothing is emitted and no warning is printed**, and a failed rename, notification,
or log write **never fails or delays the run** — the sequencer gains no required
dependency and still runs unchanged in CI and a bare terminal.

**3. Create the trigger labels** listed in [Labels](#labels) for each verb you
enable (the state labels are created on first use by the hooks).

**4. Add the secrets** (repo or org level): `CLAUDE_CODE_OAUTH_TOKEN` is
required, and `AGENT_PAT` is required for spec orchestration (slice and final PRs
must be authored by a real collaborator); `RAILS_MASTER_KEY`, `LINEAR_API_KEY` are
optional — see [Secrets](#secrets).

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

### Spec orchestrator — `implement-spec`

The orchestrator needs **two** callers. Kickoff fires on the spec-issue label and
passes `mode: kickoff`:

```yaml
# .github/workflows/agent-implement-spec-kickoff.yml
name: Agent Implement spec (kickoff)
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
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'agent:implement-spec'
    uses: michaelloistl/agent-workflows/.github/workflows/implement-spec.yml@main
    with:
      mode: kickoff
      git-author-email: agent@example.com
    secrets: inherit
```

Advance fires when a tracer-bullet PR merges into a spec branch and passes
`mode: advance` (no label, plain `pull_request` — it runs no PR-head code):

```yaml
# .github/workflows/agent-implement-spec-advance.yml
name: Agent Implement spec (advance)
on:
  pull_request:
    types: [closed]
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  advance:
    # Only a merged tracer-bullet PR into a spec branch. The final spec→default PR
    # has base == default branch, so it does NOT match and does NOT re-trigger.
    if: >-
      github.event.pull_request.merged == true
      && startsWith(github.event.pull_request.base.ref, 'agent/spec-')
    uses: michaelloistl/agent-workflows/.github/workflows/implement-spec.yml@main
    with:
      mode: advance
      git-author-email: agent@example.com
    secrets: inherit
```

## Status view

`agent-workflows status` prints the specs currently building in the repo you are
standing in, with their tracer-bullets nested beneath (ADR-0007):

```sh
yarn agent:status                          # or: agent-workflows status
yarn agent:status --watch                  # check every 5s until ctrl-c
yarn agent:status --watch --interval 60
yarn agent:status --no-color
yarn agent:status --no-hyperlinks          # print the URL column instead of linking
yarn agent:status --hyperlinks             # link anyway (overrides the Herdr default)
```

```
madebyon/on-vantage — 2 specs in flight

#1438      Spec: Default views in platform          2/5 · building
  ✓ #1519  Prefactor: extract Project-type filter…  done
  ▸ #1521  Tag Retainer and internal Projects       building
    #1522  Replace Retainer and internal toggles    pending

#1485      Spec: Port the Utilization report        5/5 · awaiting final PR
```

On a terminal each `#1521` is itself the link to the issue — the state marker beside it
stays outside the link, so only the reference is clickable. Piped or with `--no-hyperlinks`
the trailing URL column comes back instead:

```
#1438      Spec: Default views in platform          2/5 · building           https://github.com/…/1438
  ▸ #1521  Tag Retainer and internal Projects       building                 https://github.com/…/1521
```

- **In flight** means an **open** spec issue with a live `agent/spec-*` branch — a
  branch exists only after kickoff, and requiring the issue to be open excludes the
  ghost branches a finished spec leaves behind. No label is involved: kickoff retires
  `agent:implement-spec` immediately, so no label marks a running spec.
- A slice belongs to a spec through GitHub's **native sub-issue** hierarchy where that
  edge exists, and through the body's `## Parent` reference where it does not. Both
  render as one tree, so a repo can adopt native hierarchy gradually.
- Slices are in the orchestrator's own build order — topological over the **union** of
  GitHub's native `blockedBy` edges and the body's `## Blocked by` refs, so a spec
  declaring its dependencies either way (or half each) builds in one correct sequence.
  The native sub-issue *priority* order is never used. A blocker in another repository
  is named on the row rather than ordered on, since issue numbers are per-repo.
  Each state is its issue state plus its `agent:*` label — nothing else. A slice in a
  dependency cycle is shown as blocked rather than silently dropped.
- **States are colour-coded on a terminal**, with `agent:blocked` in bold red because it
  is the one state that means stop and look. Colour is emitted only when stdout is a
  terminal, so piping or redirecting the view gives clean text with no escape sequences;
  `--no-color` (or `--no-colour`) turns it off on a terminal too.
- **The issue reference is the click target on a terminal.** `#1521` is what you read and
  `#1521` is what you click: it carries the issue URL through an OSC 8 hyperlink rather than
  a column of visible text, and the state marker stays outside the link. Like colour, links
  are emitted only when stdout is a terminal — piped or redirected, the trailing URL column
  is printed instead so a reference is never left unreachable. `--no-hyperlinks` restores
  that column on a terminal too, for one (like Apple Terminal) that prints the escape as
  plain text rather than honouring it. It is independent of `--no-color`: they are separate
  terminal capabilities and neither implies the other.
- **Inside Herdr the URL column is printed instead**, automatically. A multiplexer owns the
  pane, and Herdr 0.8.0 acts on neither route: ⌘-click reaches Herdr, which does not open
  the link, and ⌘-Shift-click bypasses Herdr to the host terminal, which was never handed
  one. Plain URLs *are* clickable there, so the column is the working target and the escape
  is an inert one — hence hyperlinks default off when `HERDR_ENV=1`. This is the only
  terminal the view knows by name, and `--hyperlinks` overrides it, so a Herdr that fixes
  OSC 8 needs a flag rather than a release.
  **Under `--watch` inside Herdr, open a URL with ⌘-Shift-click, not ⌘-click.** `--watch`
  draws on the alternate screen, which Herdr's own URL clicking does not reach; Shift
  suppresses mouse reporting so the click goes to the host terminal, which finds the URL as
  ordinary text on screen. ⌘-click is enough for the one-shot view, which draws on the
  normal screen. This is the reason the column has to be *text* rather than an escape:
  the host terminal can only find what Herdr actually drew.
- **`--watch` checks in place** — every 5 seconds by default, `--interval <seconds>` sets
  how often it checks (whole seconds, from 2 to 3600). A tick costs one conditional read
  and a branch listing, not a full fetch of the tree, and redraws only when something has
  changed — so the default is a person's cadence, not a rate-limit budget: a label change
  shows up in about five seconds. The floor is the round trip of a check itself (a shorter
  interval would only stack checks on each other, since a `304` is free); past the ceiling
  the timer overflows into no pause at all. The interval is the gap *between* checks, so a
  slow pass simply pushes the next one out. It redraws on its own screen and gives your
  scrollback back on ctrl-c, and since replacing a frame needs a terminal, `--watch` is
  refused when stdout is a pipe or a file. There are **no key bindings**: it is a redraw,
  not a TUI.
- It is **read-only**. It runs no agent and writes nothing — a label write would be a
  dispatch, i.e. a real, billed agent run — so watching it costs reads only.
- The repo comes from `GH_REPO` or the checkout's `origin` remote; no argument.

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

The `implement-spec` orchestrator is lighter (no build toolchain) and takes only:

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
| `AGENT_PAT` | **yes for spec orchestration**, else no | a PAT used for `git push` and PR creation so the resulting PR triggers downstream CI (a `GITHUB_TOKEN` push does not). Falls back to `GITHUB_TOKEN` when unset. **Required** under `implement-spec`: slice PRs must be authored by a real collaborator (`author_association ∈ {OWNER,MEMBER,COLLABORATOR}`) or the PR-verb callers — including the `agent:review-pr` on the final PR — skip them and the spec stalls |
| `RAILS_MASTER_KEY` | no | Rails repos that need it to prepare the test DB / run the app |
| `LINEAR_API_KEY` | no | Linear-tracker repos (consumed by the swapped tracker adapter, not the central YAML) |

## Repo layout

- **`.github/workflows/{explore,implement,implement-pr,review-pr,update-branch}.yml`**
  — the five reusable verbs (`on: workflow_call`). Tracker-agnostic; zero tracker
  I/O.
- **`.github/workflows/implement-spec.yml`** — the reusable spec orchestrator
  (kickoff + advance modes).
- **`.github/workflows/agent-*.yml`** — this repo's own thin callers. It is its
  own first consumer (the dogfooding plumbing test), running the dispatcher
  against `src/` directly rather than installing itself.
- **`src/`** — the reference **GitHub-Issues** implementation of the hook
  contract (`shared/github.mts` is the tracker adapter), distributed as the
  `agent-workflows` package. Consuming GitHub repos install it as a git
  dependency; a Linear repo swaps the adapter (packaged separately, #33).
- **`bin/agent-workflows.mjs`** — the dispatcher: maps `<verb> <hook>` to a
  `src/` entrypoint (override-first) and runs it under `tsx`. Also routes the
  non-verb entry points: the attended local runs and `status`.
- **`src/status/`** — the read-only [status view](#status-view), over the shared
  spec-tree reader (`src/shared/spec-tree.mts`).
- **`docs/hook-contract.md`** — the interface every consuming repo implements.
- **`CONTEXT.md`** — glossary. **`PLAN.md`** — build plan + rollout.
  **[`CHANGELOG.md`](CHANGELOG.md)** — notable changes per release.
  **`docs/adr/`** — architecture decisions (0001 thin reusable workflows; 0002
  toolchain generalization + feedback-loop boundary; 0003 spec strictly
  sequential; 0004 no per-slice review; 0005 one sequencer, two entry points;
  0006 attended spec runs; 0007 the status view).

## Local checks

```sh
yarn install
yarn typecheck
yarn test
```

## Releasing

There is no publish step — the package ships straight from git tags. A release is
just the merge commit, tagged, with the floating `v1` pointer moved to it. Cut one
like this:

1. **Merge the work into `main`.** Everything in a release is already reviewed and
   merged; the release only labels a commit that is on `main`.
2. **Promote `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md)** to a new
   `## vX.Y.Z — YYYY-MM-DD` heading (leaving a fresh empty `## Unreleased` above
   it), and merge that too.
3. **Pull `main` locally so it points at the merge commit:**
   `git checkout main && git pull`. GitHub creates the merge commit server-side,
   so your local `main` is stale until you pull — tagging before this would tag
   the wrong commit.
4. **Tag the merge commit:** `git tag -a vX.Y.Z -m "<summary>"`.
5. **Move the floating major tag:** `git tag -f v1 vX.Y.Z`.
6. **Push both:** `git push origin vX.Y.Z && git push -f origin v1`.

The `v1` tag is a floating major-version pointer (see [`CHANGELOG.md`](CHANGELOG.md)):
it always tracks the newest `v1.x.y` release, so consumers pin
`github:michaelloistl/agent-workflows#v1` and follow the latest compatible version
without editing their workflow on every release.

**Consumers on `#v1` still need `yarn upgrade agent-workflows` to pick up a moved
tag.** A git-dependency install records the *resolved commit* in the consumer's
`yarn.lock`, not the tag name — so moving `v1` to a new commit does not reach a repo
whose lockfile still pins the old one. `yarn upgrade agent-workflows` re-resolves
`#v1` to the commit it now points at and rewrites the lockfile; until a consumer runs
it (and commits the changed `yarn.lock`), they stay on the release they installed.
