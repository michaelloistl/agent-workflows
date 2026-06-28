# `implement-prd` end-to-end dogfood

The live verification of the orchestrator (issue #8). It can only run **after the
feature branch merges to the default branch** — label/PR triggers fire only from
workflows on the default branch — and needs the secrets and labels below. This is
a plumbing test: kickoff → slice review loop → advance → final PR, with no human
action until the final PR.

## Preconditions

- [ ] `feature/implement-prd-orchestrator` merged to `main` (so the new callers + reusable workflow are on the default branch).
- [ ] Secrets: `CLAUDE_CODE_OAUTH_TOKEN` **and `AGENT_PAT`**. `AGENT_PAT` is **mandatory** — slice PRs must be authored by a real collaborator or the PR-verb callers (`author_association ∈ {OWNER,MEMBER,COLLABORATOR}`) skip them and the loop stalls after the first PR.
- [ ] Labels present (created during #8): `agent:implement-prd`, `agent:implement`, `agent:review-pr`, `prd`, plus the state labels. (`gh label list`.)
- [ ] Repo setting: allow GitHub to auto-delete head branches on merge (cleans up tracer-bullet + PRD branches).

## Set up a throwaway PRD

Use a tiny, agent-buildable feature touching only this repo's docs/markdown (no Rails). Two or three dependent slices so both loop shapes and the advance sequencing are exercised. Example:

1. **PRD issue** — a plain title (no `PRD:` prefix needed — PRD identity is structural: it has tracer-bullets and no `## Parent` of its own), body a short problem/solution. Example: "Dogfood: add a CONTRIBUTORS list". Do **not** run `/to-prd` against real work; this is throwaway.
2. **Tracer-bullets** (each a standalone issue with `## Parent\n#<PRD>` and a `## Blocked by` section, `ready-for-agent`):
   - Slice A — "Create CONTRIBUTORS.md with a heading" — Blocked by: None.
   - Slice B — "Add the first contributor row" — Blocked by: #A.
   - Slice C — "Link CONTRIBUTORS.md from the README" — Blocked by: #B.

   The strictly-sequential chain A→B→C exercises advance dispatching one slice at a time, each stacked on the prior.

## Run

1. Apply `agent:implement-prd` to the PRD issue.
2. **Expect (kickoff):** an `agent/prd-<n>-…` branch is created; Slice A is labelled `agent:implement`; a progress comment appears on the PRD issue; `agent:implement-prd` is removed.
3. **Expect (per slice):** a ready PR `agent/issue-<a>-… → agent/prd-<n>-…`, merged straight into the PRD branch by `implement`'s finalize (no per-slice review — ADR-0004).
4. **Expect (advance, per merge):** the merged slice's issue is closed; the next slice is labelled `agent:implement`; the PRD progress comment refreshes.
5. **Expect (completion):** after Slice C merges, a **draft** PR `agent/prd-<n>-… → <default>` opens with `Closes #<PRD>`. Merging it (the only human step) auto-closes the PRD issue.

## What to watch / known stall points

- **A slice goes `agent:blocked`** → the sequence halts by design; fix and re-apply `agent:implement` to resume (advance only fires on a merge).
- **Slice PR opened but not merged** → `implement`'s finalize couldn't merge (e.g. the `implement` caller/job lacks `contents: write`, or a non-default base protection blocks the merge).
- **Advance doesn't fire after a merge** → the merge's base ref didn't match `agent/prd-*`, or the advance caller isn't on the default branch.
- **Discovery finds nothing at kickoff** → a tracer-bullet's `## Parent`/`## Blocked by` headings drifted from the `to-issues` format (the parsed contract).

## Teardown

Close the throwaway PRD + slices, delete the `agent/prd-*` and any leftover `agent/issue-*` branches, and revert the dogfood file change (or just don't merge the final PR).
