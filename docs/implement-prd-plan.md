# Build plan — `implement-prd` orchestrator

Add a sixth top-level workflow, `implement-prd`: an **orchestrator** (CONTEXT.md) that drives the `implement` verb across a PRD's tracer-bullets on a shared PRD branch, strictly sequentially. Triggered by labelling a PRD issue `agent:implement-prd`. See ADR-0003 for the strictly-sequential decision and CONTEXT.md for vocabulary (PRD branch, Tracer-bullet, Stacked, Kickoff, Advance, Slice review loop).

## Decisions (locked)

| # | Decision |
|---|---|
| 1 | **Topology: stacked.** PRD branch `agent/prd-<n>-<slug>` is cut once from default; each tracer-bullet branches off the *current* PRD HEAD and its PR targets the PRD branch. When the last slice lands, one PR `PRD branch → default` goes up for human review. |
| 2 | **Order: strictly sequential, topological** (ADR-0003). One slice in flight at a time → every merge into the PRD branch is conflict-free by construction. No parallel waves, no conflict-recovery machinery. |
| 3 | **Advancement: event-driven, two entry points.** *Kickoff* (label the PRD issue) and *Advance* (a tracer-bullet PR merges into a PRD branch). No long-lived run. |
| 4 | **Home: a new lightweight central reusable workflow** `implement-prd.yml` (node + tsx + `gh`; **no** postgres/redis/ruby). Zero tracker I/O in the YAML; all graph logic behind new sandcastle hooks. It is an **Orchestrator**, not a sixth verb, and does **not** follow the 5-hook contract. |
| 5 | **Discovery: reverse text-search**, parsing the `## Parent` and `## Blocked by` sections structurally (not a loose grep). The `to-issues` body format becomes a load-bearing contract. Child set is recomputed **live** on each advance — late-added slices are picked up. |
| 6 | **Advance discriminator: branch names.** Fires only on `merged && base.ref ~ ^agent/prd-<n>-`. PRD# from base ref; tracer-bullet# from head ref `agent/issue-<n>-…`. Branch names are a parsed contract. |
| 7 | **Per-slice gate: none human.** The slice review loop replaces it: `implement` → `agent:review-pr` → `agent:implement-pr` → auto-merge. Only the final PRD→default PR is human-reviewed (draft, body `Closes #<PRD>`). |
| 8 | **Slice loop is self-propelling via finalize hooks**, keyed on PRD-context detection (`base.ref ~ agent/prd-*`). No central conductor. |
| 9 | **Base branch: a derived `fetch-spec` output**, parsed from the tracer-bullet's `## Parent` (PRD branch if live, else default). **Not** a workflow input. Central YAML reads `steps.spec.outputs.base`. |
| 10 | **Loop termination:** clean review (`APPROVE`/no actionable comments) → straight to merge; else **one** `implement-pr` pass → merge. No re-review. |
| 11 | **Failure:** a blocked verb halts the sequence (one in flight) until a human fixes it — orchestrator does **not** auto-recover. No per-slice CI gate (CI enforced at the final PR). |
| 12 | **Concurrency:** group `implement-prd-<PRD#>`, `cancel-in-progress: false` — kickoff + advances for one PRD serialise. |

## New components (central repo)

### `.github/workflows/implement-prd.yml` (reusable, `on: workflow_call`)
- Lightweight shell — checkout (default branch, `fetch-depth: 0`, PAT token) · setup-node · `yarn install` · install Claude CLI only if a mode needs an agent (it does not — pure `gh`) · git identity. **No services, no Ruby.**
- Input `mode: kickoff | advance` (string). Plus `git-author-email` (for the branch-creating commit identity).
- **Guard job** (kickoff only): `yarn sandcastle:implement-prd-guards` → `refused` output, same refuse-skips-run semantics as `implement`.
- **Run job:** `yarn sandcastle:implement-prd-<mode>`. Env: `GH_TOKEN` (PAT), `GH_REPO`, `RUN_URL`; kickoff also `ISSUE_NUMBER`/`ISSUE_TITLE`; advance also `PR_NUMBER`, `BASE_REF`, `HEAD_REF`.

### Two thin callers (this repo, dogfooding)
- `.github/workflows/agent-implement-prd-kickoff.yml` — `issues: [labeled]`, `if: label.name == 'agent:implement-prd'` (+ `workflow_dispatch`), `uses: …/implement-prd.yml@main` `with: { mode: kickoff }`.
- `.github/workflows/agent-implement-prd-advance.yml` — `pull_request: [closed]`, `if: github.event.pull_request.merged && startsWith(base.ref,'agent/prd-')`, `with: { mode: advance }`.

## New sandcastle hooks — `.sandcastle/agent-workflows/implement-prd/`
- **`guards.mts`** (`implement-prd-guards`): refuse (retire `agent:implement-prd` + comment) when (a) issue isn't a PRD (no `prd` label and title doesn't start `PRD:`), (b) no tracer-bullets discovered, (c) PRD branch already exists (idempotent re-kickoff).
- **`kickoff.mts`** (`implement-prd-kickoff`): create `agent/prd-<n>-<slug>` from default · discover + topo-sort tracer-bullets · apply `agent:implement` to the topologically-first · post PRD progress comment · retire `agent:implement-prd`.
- **`advance.mts`** (`implement-prd-advance`): close the merged tracer-bullet (#from head ref) · recompute the child set live · if slices remain, apply `agent:implement` to the next topological slice · else open the draft `PRD branch → default` PR with `Closes #<PRD>` · post PRD progress comment.
- **shared `prd-graph.mts`**: reverse-search a PRD's tracer-bullets; parse `## Parent` / `## Blocked by` (reuse the `## `-header walk from `implement/guards.mts`); topo-sort with deterministic tie-break (lowest issue #); PRD-branch name derivation.
- **shared `prd-context.mts`**: `isPrdBranch(ref)`, `prdNumberFromBranch(ref)`, `issueNumberFromBranch(ref)`.

## Edits to existing pieces (PRD-context awareness)

| File | Change |
|---|---|
| `implement/fetch-spec.mts` | also emit `base=…` — parse `## Parent`; if it references a PRD with a live `agent/prd-<n>-…` branch, `base` = that branch, else default. |
| `.github/workflows/implement.yml` | `git fetch origin "$base"` then `git checkout -B "$BRANCH" "origin/$base"` using `steps.spec.outputs.base` (fallback default); pass `base` to finalize. Make the post-run `implement-status review` step PRD-aware (under a PRD: **no** `agent:review`). |
| `implement/finalize.mts` | if `base != default` → open a **ready** (non-draft) PR `--base <PRD branch>` **and** apply `agent:review-pr` to it; else unchanged (draft, default base, `Closes #N`). |
| `review/finalize.mts` | if PR base `~ agent/prd-*` → clean review ⇒ `gh pr merge` into the PRD branch; else apply `agent:implement-pr`. |
| `implement-pr/finalize.mts` | if PR base `~ agent/prd-*` → `gh pr merge` into the PRD branch (fires advance). |

**Unchanged:** the `implement` PRD/issue-shape/blocked-by guards (tracer-bullets pass; PRDs are triggered with `agent:implement-prd`, never `agent:implement`).

## Build sequence

1. **Glossary + ADR** — done (CONTEXT.md PRD-orchestration section; ADR-0003).
2. **`prd-graph.mts` + `prd-context.mts`** with unit coverage on a fixture PRD + tracer-bullet bodies (discovery, parse, topo-sort, tie-break).
3. **`fetch-spec` base output + `implement.yml` base threading** — verify standalone issues still derive `base = default` (no behaviour change).
4. **`implement-prd.yml` + guards + kickoff** — kickoff a real PRD, assert PRD branch created + first slice labelled + progress comment.
5. **Slice-loop finalize edits** (`implement`/`review`/`implement-pr`) gated on PRD context — assert the `implement → review-pr → (implement-pr) → merge` chain self-propels.
6. **`advance.mts` + advance caller** — assert merge → close + next slice; last merge → final draft PR with `Closes #<PRD>`.
7. **End-to-end dogfood** on a throwaway 2–3-slice PRD in this repo.

## Risks / watch-list
- **`to-issues` format is now load-bearing** (Decision 5). If a tracer-bullet omits `## Parent`/`## Blocked by` or uses non-`##` headers, discovery/edges break. Mitigate with clear guard refusals naming the offending issue.
- **Branch-name contract** (Decision 6): a hand-renamed branch mid-flight makes advance blind to its merge. Documented limitation.
- **PR-verb guards**: confirm `review/guards.mts` and `implement-pr/guards.mts` don't refuse PRD-context PRs (the slice loop relabels them automatically).
- **`agent:review-pr` / `agent:implement-pr` on a draft-vs-ready PR**: slice PRs are opened *ready* under a PRD so the PR verbs act on them.
