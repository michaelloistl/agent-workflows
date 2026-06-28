# Context

You are implementing a single GitHub issue end-to-end as one vertical slice. All
your commits go on the current git branch. After this run, the workflow pushes
the branch and opens ONE draft pull request for it automatically — you do NOT
push or open pull requests yourself.

## The issue

**#{{ISSUE_NUMBER}} — {{ISSUE_TITLE}}**

<issue>

!`cat {{SPEC_FILE}}`

</issue>

This is the sole source of truth for what to build. Implement exactly this slice —
no more, no less.

# Task

Implement the issue as the smallest coherent change, test-first, and leave the
verify gate green before you finish.

## Repo conventions & verify gate (customise per repo)

<!-- CUSTOMISE PER REPO — a consuming repo replaces this block with its own
     stack, conventions docs, and verify commands. This is agent-workflows'
     own copy: a GitHub Actions + TypeScript repo (reusable workflows under
     `.github/workflows/`, the `.sandcastle/` hook layer in `.mts` run via
     `tsx`, and Markdown docs). No Rails, no full test suite. -->

- **Read first:** `AGENTS.md`, `CONTEXT.md` (match its vocabulary), and the
  relevant `docs/adr/` decisions. Follow the existing patterns — the hook
  contract, the tracker-agnostic boundary, the comment style.
- **Tests:** hook logic lives in `.mts` with co-located `*.test.mts` run via
  `tsx --test`. Workflow YAML and Markdown carry no unit tests — sanity-check
  them by hand instead.
- **Verify gate** (must be green before you declare the work complete):
  - `yarn typecheck && yarn test`
  - for any workflow YAML you touch: re-check the syntax and that every hook it
    references exists.

## Workflow

1. **Explore** — read the conventions above, the issue, and any parent or
   blocking issue it references. Read the files you'll touch first.
2. **Plan** — decide the smallest change that satisfies the issue.
3. **Build one behaviour at a time.** When you touch hook logic, drive it
   test-first: add or extend the co-located `*.test.mts`, watch it fail, then make
   it pass — one behaviour per cycle. (YAML or Markdown-only changes have no test
   to write; lean on the syntax check and the verify gate.)
4. **Refactor only when green** — tidy up once the behaviour passes, never before.
5. **Verify** — run the verify gate above and get it green *before* you move on.
6. **Commit** — one commit (or a few focused commits), imperative present tense.
   The body lists key decisions and files changed. Do NOT add a `Co-Authored-By`
   or "Generated with" trailer.

## Rules

- Implement only this one issue. If the body turns out to be a multi-phase plan,
  it was mis-sliced — build the smallest coherent slice and note the rest in the
  commit body.
- No commented-out code or TODOs in committed code.
- Do not push, open PRs, or change issue labels — that is all automated after the
  run.

# Done

Once the work is committed and the verify gate is green, output:

<promise>COMPLETE</promise>
