# Toolchain generalization and the feedback-loop boundary

ADR-0001 locked the architecture (thin tracker-agnostic reusable workflows driving sandcastle hooks). `PLAN.md` left two decisions open, both surfaced by dogfooding `agent-workflows` — a YAML/markdown repo, not a Rails app — as the central repo's own first consumer. This ADR resolves them.

## Status

accepted

## Q12 — Toolchain generalization

**Decision: add a fourth typed input `enable-ruby` (boolean, default `true`). Node/Yarn stay unconditional; postgres + redis stay always-on (idle on non-Rails repos); promote the services to real per-service toggles only at the second non-Rails consumer.** This is option **B** from `PLAN.md`, with the promotion to option **A** deferred.

### Why

- The only steps that **hard-fail** on a non-Rails repo are `ruby/setup-ruby` (no `Gemfile`) and `bundle exec rails db:prepare` (no Rails). Gating exactly those three steps (apt `libpq-dev`, Ruby setup, `db:prepare`) behind one `enable-ruby` toggle is the smallest change that unblocks dogfooding.
- **Node/Yarn cannot be gated** — every consumer's hooks are `.mts` run via `tsx`, so `node_modules` must always be installed. Every consuming repo must therefore commit a `package.json` + `yarn.lock` (this repo now does). Node is part of the contract, not config.
- **postgres + redis stay always-on.** GitHub Actions `services:` start unconditionally — they cannot be skipped with a job-level `if:`. Making them genuinely skippable means rewriting them as conditional `docker run` steps (option A). That refactor earns its keep at the *second* non-Rails consumer, not the first; here the two idle containers cost ~10s of startup and nothing else.

### Relationship to locked Decision 10 ("three inputs only")

This ADR **amends Decision 10 from three inputs to four.** Decision 10 standardized away `default-branch` and `node-version` because both are genuinely derivable (`github.event.repository.default_branch`; a committed `.node-version`). The Ruby toolchain is **not** derivable from a standardized value — a Rails consumer needs it and a YAML consumer must not run it. By the project's own Decision 4 (essential drift → input; accidental drift → standardized), `enable-ruby` is essential drift and earns an input by the same test as `system-packages`, `database-url`, and `git-author-email`. Auto-detecting a `Gemfile` was rejected: invisible magic contradicts Decision 3 (config restated in each thin caller — visible, diffable, PR-reviewable).

### Updated input contract

| Input | Type | Default |
|---|---|---|
| `system-packages` | string | `""` |
| `database-url` | string | `postgres://postgres:postgres@localhost:5432/test` |
| `git-author-email` | string | per-org |
| `enable-ruby` | boolean | `true` |

A non-Rails caller sets `enable-ruby: false` (and typically `system-packages: ""`); the postgres/redis services still start but go unused.

## The feedback-loop boundary

**Decision: the central YAML has zero feedback-loop responsibility. The feedback loop — what "green" means — lives entirely inside the `<verb>` hook (the agent's own run). For `agent-workflows` specifically, the `implement` agent just edits and opens a PR with no green-check gate; the plumbing smoke test does not need one.**

### Why

- A Rails consumer's gate (`bin/rails test`, rubocop) is the **agent's internal loop**, driven by its prompt — never a step in the central YAML. The central workflow sets up the environment and pushes; it never runs the project's tests. So "a YAML repo has no `bin/rails test`" changes nothing about the central workflow — there was never a test step there to remove.
- The dogfooding goal is a **plumbing** test: label fires → reusable workflow resolves cross-repo → agent edits a file → PR opens. Proving that path needs no quality gate.
- A YAML-lint loop (`actionlint`/`yamllint`) is genuinely useful for *this* repo — but it belongs in `agent-workflows`' own `implement` **prompt** as an agent self-check, not in the contract and not in the central YAML. It can be added later without touching any other consumer.

### Consequence

The hook contract stays honest: the feedback loop is per-repo and lives behind `<verb>`. The central workflow is identical whether the consumer gates on Rails tests, YAML lint, or nothing.

## Consequences

- The five central workflows take four inputs; thin callers on non-Rails repos pass `enable-ruby: false`.
- `agent-workflows` gains a `package.json` + `yarn.lock` + `.node-version` and a `.sandcastle/` hook tree, making it the **reference GitHub-Issues implementation** of the hook contract. ldf's migration (rollout step 2) becomes "copy these hooks and adjust," not "design hooks from scratch."
- Promoting postgres/redis to per-service toggles (option A) is deferred to the second non-Rails consumer and is a non-breaking, additive change when it lands.
</content>
</invoke>
