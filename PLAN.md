# Build plan — unify agent workflows

Unify the five label-triggered agent workflows across multiple project repos into reusable workflows in `michaelloistl/agent-workflows`, with each consuming repo supplying config + sandcastle hooks. See `docs/adr/0001` for the architecture decision and `CONTEXT.md` for vocabulary.

## Decisions (locked)

| # | Decision |
|---|---|
| 1 | **Mechanism:** reusable workflows (`on: workflow_call`), not composite actions |
| 2 | **Central repo:** `michaelloistl/agent-workflows`, **public** (zero cross-owner access config; no secrets in the YAML) |
| 3 | **Config delivery:** typed `with:` inputs restated in each thin caller (visible, diffable, PR-reviewable) |
| 4 | **Drift split:** essential drift → input; accidental drift → standardized to one central value |
| 5 | **Services:** postgres + redis always-on, standardized creds; only `database-url` is config |
| 6 | **Architecture:** Model X (thin tracker-agnostic YAML + sandcastle hooks); Model Z (package the sandcastle layer) is the north star |
| 7 | **Boundary:** central YAML does **zero** tracker I/O; `git push` in YAML, PR creation in the `finalize` hook |
| 8 | **Versioning:** `@v1` moving major tag; `@main` during bring-up |
| 9 | **Secrets:** `secrets: inherit` + static optional passthrough (`CLAUDE_CODE_OAUTH_TOKEN` required; `AGENT_PAT`, `RAILS_MASTER_KEY`, `LINEAR_API_KEY` optional, empty when absent) |
| 10 | **Inputs:** three only (below); `default-branch` and `node-version` derived/standardized away |
| 11 | **Rollout:** ldf pilot → on-vantage gates `@v1` → lauza fast-follow |

## Input contract (every workflow)

| Input | Type | Default |
|---|---|---|
| `system-packages` | string | `""` (space-separated apt packages) |
| `database-url` | string | `postgres://postgres:postgres@localhost:5432/test` |
| `git-author-email` | string | per-org (`michael.loistl@gmail.com`, `michael@aplo.studio`, …) |
| `enable-ruby` | boolean | `true` (gate Ruby toolchain; see ADR-0002) |

Derived / standardized (not config):
- **default branch** → `${{ github.event.repository.default_branch }}`; PR base → `github.event.pull_request.base.ref`
- **node version** → committed `.node-version` file in each repo
- **timeout** → 90 minutes
- postgres `:16` (postgres/postgres) + redis, both always-on; `REDIS_URL=redis://localhost:6379/0`
- action pins newest (`checkout@v6`, `setup-node@v6`, `setup-ruby@v1`)
- Claude CLI `@anthropic-ai/claude-code`, `bypassPermissions` + no attribution
- git author **name** `Sandcastle Agent`
- `AGENT_MODEL` stays in sandcastle `shared/agent.mts`

## Hook contract (per verb)

The central YAML calls these in order; consuming repos implement them:

- `sandcastle:<verb>-guards` — preflight; posts its own refusal feedback + clears trigger label; exit 0 = proceed, non-zero = refused (skip rest, not a failure)
- `sandcastle:<verb>-fetch-spec` — writes the issue/PR/Linear spec to a file the prompt inlines
- `sandcastle:<verb>` — the agent run
- `sandcastle:<verb>-status <state>` — reports `in-progress` / `review` / `blocked` to the tracker
- `sandcastle:<verb>-finalize` — opens the draft PR with the right cross-ref / posts threaded comment replies

Central YAML responsibilities (generic): checkout default branch · install `system-packages` · Ruby/Node/Yarn setup · start postgres+redis · install Claude CLI + settings · set git identity · create `agent/…` branch · `git push` · control flow · timeout · concurrency · `always()` cleanup.

## Rollout

1. **Build central repo** — 5 reusable workflows, the 3 inputs, `secrets: inherit` + passthrough, served at `@main`.
2. **Pilot: ldf** — migrate YAML guards → sandcastle hooks; thin callers → `@main`; iterate until the full fleet (explore → implement → review-pr → update-branch) is green.
3. **Contract gate: on-vantage** — wire existing Linear hooks to the contract at `@main`. If Linear forces a contract change, make it now.
4. **Cut `@v1`** — only once a GitHub repo *and* the Linear repo both pass.
5. **lauza** — adopt `@v1` directly (same GH hook migration as ldf).
6. **Switch ldf + on-vantage** from `@main` → `@v1`.

## Dogfooding: agent-workflows as its own first consumer

The central repo (`michaelloistl/agent-workflows`) will also consume its own workflows — the cleanest *plumbing* smoke test (label fires → reusable workflow resolves cross-repo → agent edits a file → PR opens), with no Rails noise. ldf remains the better *representative* test.

**Caveat:** agent-workflows is a YAML/markdown repo, **not** Rails. It breaks the standardized toolchain (no Gemfile → `ruby/setup-ruby` fails; maybe no `yarn.lock`; postgres/redis unused). So dogfooding forces the toolchain to become **configurable** rather than a hardcoded Rails bundle.

## Open decisions — RESOLVED in `docs/adr/0002`

- **Q12 — toolchain generalization.** Resolved **B now → A later**: add a fourth input `enable-ruby` (default `true`) gating apt `libpq-dev` + `ruby/setup-ruby` + `db:prepare`; Node/Yarn unconditional (hooks run on `tsx`); postgres/redis stay always-on (idle on non-Rails repos) until the second non-Rails consumer promotes them to per-service toggles. This **amends locked Decision 10** from three inputs to four — `enable-ruby` is essential drift (Decision 4), not derivable like `node-version`/`default-branch`.
- **Feedback loop on agent-workflows.** Resolved: the central YAML has **zero** feedback-loop responsibility — "green" is always the agent's internal loop behind the `<verb>` hook. agent-workflows' `implement` agent just edits + opens a PR (no green-check gate); an optional `actionlint`/`yamllint` self-check can live in that repo's `implement` *prompt*, never in the contract.

## Per-repo go-live checklist

- [ ] thin callers merged to the **default branch** (label triggers only fire from there)
- [ ] `workflow_dispatch` present on each caller (first-run trigger registration + manual runs)
- [ ] `agent/*` in the repo's CI push triggers
- [ ] secrets set: `CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_PAT`, `RAILS_MASTER_KEY` (+ `LINEAR_API_KEY` for Linear repos)
- [ ] `.node-version` file present
- [ ] sandcastle hooks implemented for every verb
- [ ] smoke test: explore → implement → review-pr
