# Build plan — `implement-spec` orchestrator

Add a sixth top-level workflow, `implement-spec`: an **orchestrator** (CONTEXT.md) that drives the `implement` verb across a spec's tracer-bullets on a shared spec branch, strictly sequentially. Triggered by labelling a spec issue `agent:implement-spec`. See ADR-0003 for the strictly-sequential decision and CONTEXT.md for vocabulary (spec branch, Tracer-bullet, Stacked, Kickoff, Advance, Slice merge).

> **Update (ADR-0004):** the per-slice **review loop** below (Decisions 7–8: `implement → review-pr → implement-pr → merge`) was **dropped** after the #8 dogfood showed it unsound (`review-pr` is advisory-only; `implement-pr` blocks on a no-op). A slice now merges straight into the spec branch after it builds (`implement → merge → advance`); the only review is the human review of the final spec→default PR. The decision rows below are kept as the historical design.

## Decisions (locked)

| # | Decision |
|---|---|
| 1 | **Topology: stacked.** spec branch `agent/spec-<n>-<slug>` is cut once from default; each tracer-bullet branches off the *current* spec HEAD and its PR targets the spec branch. When the last slice lands, one PR `spec branch → default` goes up for human review. |
| 2 | **Order: strictly sequential, topological** (ADR-0003). One slice in flight at a time → every merge into the spec branch is conflict-free by construction. No parallel waves, no conflict-recovery machinery. |
| 3 | **Advancement: event-driven, two entry points.** *Kickoff* (label the spec issue) and *Advance* (a tracer-bullet PR merges into a spec branch). No long-lived run. |
| 4 | **Home: a new lightweight central reusable workflow** `implement-spec.yml` (node + tsx + `gh`; **no** postgres/redis/ruby). Zero tracker I/O in the YAML; all graph logic behind new sandcastle hooks. It is an **Orchestrator**, not a sixth verb, and does **not** follow the 5-hook contract. |
| 5 | **Discovery: reverse text-search**, parsing the `## Parent` and `## Blocked by` sections structurally (not a loose grep). The `to-tickets` body format becomes a load-bearing contract. Child set is recomputed **live** on each advance — late-added slices are picked up. |
| 6 | **Advance discriminator: branch names.** Fires only on `merged && base.ref ~ ^agent/spec-<n>-`. spec# from base ref; tracer-bullet# from head ref `agent/issue-<n>-…`. Branch names are a parsed contract. |
| 7 | **Per-slice gate: none human.** The slice review loop replaces it: `implement` → `agent:review-pr` → `agent:implement-pr` → auto-merge. Only the final spec→default PR is human-reviewed (draft, body `Closes #<spec>`). |
| 8 | **Slice loop is self-propelling via finalize hooks**, keyed on spec-context detection (`base.ref ~ agent/spec-*`). No central conductor. |
| 9 | **Base branch: a derived `fetch-spec` output**, parsed from the tracer-bullet's `## Parent` (spec branch if live, else default). **Not** a workflow input. Central YAML reads `steps.spec.outputs.base`. |
| 10 | **Loop termination:** clean review (`APPROVE`/no actionable comments) → straight to merge; else **one** `implement-pr` pass → merge. No re-review. |
| 11 | **Failure:** a blocked verb halts the sequence (one in flight) until a human fixes it — orchestrator does **not** auto-recover. No per-slice CI gate (CI enforced at the final PR). |
| 12 | **Concurrency:** group `implement-spec-<spec#>`, `cancel-in-progress: false` — kickoff + advances for one spec serialise. |

## New components (central repo)

### `.github/workflows/implement-spec.yml` (reusable, `on: workflow_call`)
- Lightweight shell — checkout (default branch, `fetch-depth: 0`, PAT token) · setup-node · `yarn install` · install Claude CLI only if a mode needs an agent (it does not — pure `gh`) · git identity. **No services, no Ruby.**
- Input `mode: kickoff | advance` (string). Plus `git-author-email` (for the branch-creating commit identity).
- **Guard job** (kickoff only): `yarn sandcastle:implement-spec-guards` → `refused` output, same refuse-skips-run semantics as `implement`.
- **Run job:** `yarn sandcastle:implement-spec-<mode>`. Env: `GH_TOKEN` (PAT), `GH_REPO`, `RUN_URL`; kickoff also `ISSUE_NUMBER`/`ISSUE_TITLE`; advance also `PR_NUMBER`, `BASE_REF`, `HEAD_REF`.

### Two thin callers (this repo, dogfooding)
- `.github/workflows/agent-implement-spec-kickoff.yml` — `issues: [labeled]`, `if: label.name == 'agent:implement-spec'` (+ `workflow_dispatch`), `uses: …/implement-spec.yml@main` `with: { mode: kickoff }`.
- `.github/workflows/agent-implement-spec-advance.yml` — `pull_request: [closed]`, `if: github.event.pull_request.merged && startsWith(base.ref,'agent/spec-')`, `with: { mode: advance }`.

## New sandcastle hooks — `.sandcastle/agent-workflows/implement-spec/`
- **`guards.mts`** (`implement-spec-guards`): refuse (retire `agent:implement-spec` + comment) when (a) issue isn't a spec (no `spec` label and title doesn't start `spec:`), (b) no tracer-bullets discovered, (c) spec branch already exists (idempotent re-kickoff).
- **`kickoff.mts`** (`implement-spec-kickoff`): create `agent/spec-<n>-<slug>` from default · discover + topo-sort tracer-bullets · apply `agent:implement` to the topologically-first · post spec progress comment · retire `agent:implement-spec`.
- **`advance.mts`** (`implement-spec-advance`): close the merged tracer-bullet (#from head ref) · recompute the child set live · if slices remain, apply `agent:implement` to the next topological slice · else open the draft `spec branch → default` PR with `Closes #<spec>` · post spec progress comment.
- **shared `spec-graph.mts`**: reverse-search a spec's tracer-bullets; parse `## Parent` / `## Blocked by` (reuse the `## `-header walk from `implement/guards.mts`); topo-sort with deterministic tie-break (lowest issue #); spec-branch name derivation.
- **shared `spec-context.mts`**: `isSpecBranch(ref)`, `specNumberFromBranch(ref)`, `issueNumberFromBranch(ref)`.

## Edits to existing pieces (spec-context awareness)

| File | Change |
|---|---|
| `implement/fetch-spec.mts` | also emit `base=…` — parse `## Parent`; if it references a spec with a live `agent/spec-<n>-…` branch, `base` = that branch, else default. |
| `.github/workflows/implement.yml` | `git fetch origin "$base"` then `git checkout -B "$BRANCH" "origin/$base"` using `steps.spec.outputs.base` (fallback default); pass `base` to finalize. Make the post-run `implement-status review` step spec-aware (under a spec: **no** `agent:review`). |
| `implement/finalize.mts` | if `base != default` → open a **ready** (non-draft) PR `--base <spec branch>` **and** apply `agent:review-pr` to it; else unchanged (draft, default base, `Closes #N`). |
| `review/finalize.mts` | if PR base `~ agent/spec-*` → clean review ⇒ `gh pr merge` into the spec branch; else apply `agent:implement-pr`. |
| `implement-pr/finalize.mts` | if PR base `~ agent/spec-*` → `gh pr merge` into the spec branch (fires advance). |

**Unchanged:** the `implement` spec/issue-shape/blocked-by guards (tracer-bullets pass; specs are triggered with `agent:implement-spec`, never `agent:implement`).

## Build sequence

1. **Glossary + ADR** — done (CONTEXT.md spec-orchestration section; ADR-0003).
2. **`spec-graph.mts` + `spec-context.mts`** with unit coverage on a fixture spec + tracer-bullet bodies (discovery, parse, topo-sort, tie-break).
3. **`fetch-spec` base output + `implement.yml` base threading** — verify standalone issues still derive `base = default` (no behaviour change).
4. **`implement-spec.yml` + guards + kickoff** — kickoff a real spec, assert spec branch created + first slice labelled + progress comment.
5. **Slice-loop finalize edits** (`implement`/`review`/`implement-pr`) gated on spec context — assert the `implement → review-pr → (implement-pr) → merge` chain self-propels.
6. **`advance.mts` + advance caller** — assert merge → close + next slice; last merge → final draft PR with `Closes #<spec>`.
7. **End-to-end dogfood** on a throwaway 2–3-slice spec in this repo.

## Hooks are frozen at spec-branch-cut time

A spec's slices run the `.sandcastle/` code **as it existed on the default branch when the spec branch was cut**, not current `main`. The `implement` workflow runs its hooks from the working tree, and "Create agent branch" (`git checkout -B agent/issue-N origin/$BASE`) switches that tree to the spec branch — so `yarn sandcastle:implement-finalize` executes the spec branch's copy of the hook. Consequence: a fix to the orchestrator's hooks reaches only specs **started after** the fix; an in-flight spec keeps its cut-time tooling (restart the spec to pick up a fix). This is consistent within a spec and fine in normal use — it only surprises if you change hooks mid-spec (it cost a dogfood re-run; see ADR-0004's history). The PR verbs already side-step this with a default-branch tooling worktree; giving `implement` the same treatment is a possible future hardening, not currently needed.

## Risks / watch-list
- **`to-tickets` format is now load-bearing** (Decision 5). If a tracer-bullet omits `## Parent`/`## Blocked by` or uses non-`##` headers, discovery/edges break. Mitigate with clear guard refusals naming the offending issue.
- **Branch-name contract** (Decision 6): a hand-renamed branch mid-flight makes advance blind to its merge. Documented limitation.
- **PR-verb guards**: confirm `review/guards.mts` and `implement-pr/guards.mts` don't refuse spec-context PRs (the slice loop relabels them automatically).
- **`agent:review-pr` / `agent:implement-pr` on a draft-vs-ready PR**: slice PRs are opened *ready* under a spec so the PR verbs act on them.
