# Hook contract

The fixed interface between the central reusable workflows (this repo) and a
consuming repo's `sandcastle:*` scripts. The central workflow calls these `yarn`
scripts at fixed points and does **zero** tracker I/O itself (ADR-0001,
Decision 7). A consuming repo wires every script for every verb it uses; only
the implementations behind them differ between GitHub-Issues and Linear repos.

The reference GitHub-Issues implementation lives in this repo's `src/` and is
distributed as the **`agent-workflows` package**, installed as a git dependency
(issue #31):

```jsonc
// consumer package.json
{
  "devDependencies": { "agent-workflows": "github:michaelloistl/agent-workflows#v1" },
  "scripts": {
    "sandcastle:implement":        "agent-workflows implement run",
    "sandcastle:implement-guards": "agent-workflows implement guards"
    // …one per verb×hook; see "Consuming-repo requirements"
  }
}
```

Each script invokes the packaged **dispatcher bin** `agent-workflows <verb>
<hook>`, which resolves the entrypoint **override-first**: a consumer's local
`.sandcastle/agent-workflows/<verb-dir>/<entry>.mts` wins, else the packaged
`src/` default runs. So a vanilla GitHub-Issues consumer hosts **no**
`.sandcastle/` code at all; copying a single file into the override dir is the
escape hatch for bespoke guard/finalize/prompt logic. (Packaging the Linear
tracker adapter is tracked separately in #33 — it's a deep import, not an
override-dir-resolvable entrypoint.)

## Scripts per verb

`<verb>` ∈ `explore`, `implement`, `implement-pr`, `review-pr`, `update-branch`.

| Script | Called when | Must do | Exit semantics |
|---|---|---|---|
| `sandcastle:<verb>-guards` | first, in a lightweight guard job | preflight; on refusal retire the trigger label + comment why | `0` = proceed, non-zero = **refused** (skip the run; NOT a failure, never `agent:blocked`) |
| `sandcastle:<verb>-status <state> [reason]` | start, success, failure | apply the tracker state (see states below) | non-zero fails the step |
| `sandcastle:<verb>-fetch-spec` | issue verbs only (`explore`, `implement`) | write the spec to `$SPEC_FILE`; `implement` also emits `branch=…` to `$GITHUB_OUTPUT` | non-zero fails the run |
| `sandcastle:<verb>` | the agent run | do the work; write the verb's output file (below); exit non-zero if it produced nothing | non-zero → `blocked` |
| `sandcastle:<verb>-finalize` | after a successful run (and `git push`) | post results to the tracker (comment / review / draft PR / threaded replies) | non-zero fails the step |

PR verbs (`implement-pr`, `review-pr`, `update-branch`) gather their own PR
context inside `<verb>` (diff, comments, linked issue), so they have **no**
`fetch-spec`.

## Status states

`sandcastle:<verb>-status` takes a state and an optional reason. The hook owns
all `agent:*` state-label hygiene and is idempotent about clearing
`agent:in-progress`, so any terminal path leaves the tracker clean.

| State | Meaning | Reference label transition |
|---|---|---|
| `in-progress` | run started | remove trigger label + `agent:blocked`; add `agent:in-progress` |
| `review` | success, awaiting human review (`implement` only) | remove `agent:in-progress`; add `agent:review` |
| `done` | clean success, no lingering state | remove `agent:in-progress` |
| `blocked` `[reason]` | run failed / aborted | remove `agent:in-progress`; add `agent:blocked`; comment the reason + run URL |

## Environment the central workflow provides

Common: `GH_TOKEN`, `GH_REPO`, `RUN_URL`.
Issue verbs: `ISSUE_NUMBER`, `ISSUE_TITLE`, `SPEC_FILE`. `implement` finalize also
gets `BRANCH`.
PR verbs: `PR_NUMBER`, `PR_TITLE`; plus `HEAD_REF`/`BASE_REF` where relevant, and
`PR_STATE` in the guard job.
Agent run also gets: `CLAUDE_CODE_OAUTH_TOKEN`, `DATABASE_URL`, `REDIS_URL`,
`RAILS_MASTER_KEY` (empty when the repo sets no such secret).

Output files the agent run writes (path supplied by the workflow):

| Verb | File | Shape |
|---|---|---|
| `explore` | `$COMMENT_FILE` | markdown comment |
| `review-pr` | `$REVIEW_FILE` | GitHub reviews-API payload `{ body, event, comments[] }` |
| `implement-pr` | `$REPLIES_FILE` | `{ summary, replies: [{ commentId, body }] }` |
| `update-branch` | `$STATUS_FILE` | `up-to-date` \| `merged` |
| `implement` | — | commits on the branch (the workflow pushes) |

## Invocation forms

- **Issue verbs** run on the default-branch checkout (tooling present): the
  workflow calls `yarn sandcastle:<verb>-<hook>`, which resolves the consumer's
  script → the packaged dispatcher bin.
- **PR verbs** run the agent against the PR head, but the PR branch may predate
  the tooling — so the workflow checks out the PR head as the working tree and the
  **default branch's** tooling into a detached worktree (`$TOOLING_DIR`). The
  agent run is invoked by absolute path to the packaged bin —
  `"$TOOLING_DIR/node_modules/.bin/agent-workflows" <verb> run` — with the PR
  working tree as cwd. This splits **tooling location** (`$TOOLING_DIR`) from
  **cwd** (PR head), which `yarn --cwd` cannot express. The tracker-only hooks
  (guards/status/finalize) run as `yarn --cwd "$TOOLING_DIR"
  sandcastle:<verb>-<hook>` (cwd is irrelevant — they act on the tracker via
  `PR_NUMBER`).

`<verb-dir>` is the source/override directory name: `review-pr` lives under
`review/`; the rest match the verb. The dispatcher maps the `run` hook to the
verb's own entry (`<verb-dir>/<verb-dir>.mts`) and every other hook to
`<verb-dir>/<hook>.mts`.

## Consuming-repo requirements

- `package.json` depends on `agent-workflows` (git dep) and defines every
  `sandcastle:*` script above for every verb used, each pointing at the
  dispatcher bin (`agent-workflows <verb> <hook>`; the agent-run script is
  `<verb> run`). Plus committed `.node-version` and `yarn.lock` (Node/Yarn are
  unconditional — hooks run on `tsx`, which the package pulls in).
- **No `.sandcastle/` code is required.** To customize a hook, drop a single
  override file at `.sandcastle/agent-workflows/<verb-dir>/<entry>.mts` (or
  `prompt.md`) — it wins over the packaged default. An override that imports
  shared helpers must get them from the package (or copy them), since its
  relative imports resolve from its own location, not the package's `src/`.
- Thin callers pass `git-author-email` and, on non-Rails repos, `enable-ruby:
  false` (ADR-0002); set the optional `agent-model` input to override the
  packaged default model.
