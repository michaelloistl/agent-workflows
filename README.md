# agent-workflows

Central, public repo of **reusable GitHub Actions workflows** that drive a
label-triggered coding-agent fleet across multiple project repos. The central
workflows own only the generic, tracker-agnostic orchestration shell; every
repo- or domain-specific decision lives behind sandcastle hooks in the consuming
repo.

## Layout

- **`.github/workflows/{explore,implement,implement-pr,review-pr,update-branch}.yml`**
  — the five reusable workflows (`on: workflow_call`). Tracker-agnostic; zero
  tracker I/O.
- **`.github/workflows/agent-*.yml`** — this repo's own thin callers. It is its
  own first consumer (the dogfooding plumbing test).
- **`.sandcastle/agent-workflows/`** — the reference **GitHub-Issues**
  implementation of the hook contract (`shared/github.mts` is the tracker
  adapter). Consuming GitHub repos copy this; a Linear repo swaps the adapter.
- **`docs/hook-contract.md`** — the interface every consuming repo implements.
- **`CONTEXT.md`** — glossary. **`PLAN.md`** — build plan + rollout.
  **`docs/adr/`** — architecture decisions (0001 thin-reusable-workflows;
  0002 toolchain generalization + feedback-loop boundary).

## Using it from a consuming repo

A thin caller triggers on a label and calls the matching reusable workflow:

```yaml
# .github/workflows/agent-implement.yml
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

Inputs: `system-packages` (`""`), `database-url`
(`postgres://postgres:postgres@localhost:5432/test`), `git-author-email`
(required), `enable-ruby` (`true`). Required secret: `CLAUDE_CODE_OAUTH_TOKEN`;
optional: `AGENT_PAT`, `RAILS_MASTER_KEY`, `LINEAR_API_KEY`.

## Local checks

```sh
yarn install
yarn typecheck
```
