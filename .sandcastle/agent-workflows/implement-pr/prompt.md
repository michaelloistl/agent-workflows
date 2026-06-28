# Context

You are iterating on a single open GitHub pull request: addressing the review
feedback on it. The PR branch is checked out as your current branch and the git
identity is already configured. You make the requested changes and commit them
onto this branch — after this run the workflow pushes the branch and posts your
replies. You do NOT push, open, or close anything yourself.

## The pull request

**#{{PR_NUMBER}} — {{PR_TITLE}}** (base branch: `{{BASE_REF}}`)

### Linked issue

<issue>

!`cat {{LINKED_ISSUE_FILE}}`

</issue>

### Diff against `{{BASE_REF}}`

<diff>

!`cat {{DIFF_FILE}}`

</diff>

### Review and inline comments (JSON)

<comments>

!`cat {{COMMENTS_FILE}}`

</comments>

# Task

Address the review feedback test-first, and leave the verify gate green before
you finish.

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

Work through the review feedback above:

1. **Identify the actionable comments.** The `inlineComments` entries each carry
   a numeric `id`, a `path`, a `line`, and a `body`; the `reviews` carry
   top-level feedback. Decide which ask for a concrete change. Skip ones already
   resolved, purely informational, or that you reasonably disagree with (note
   your reasoning in the reply).
2. **Make the requested changes** one behaviour at a time, following the project
   conventions and the linked issue's intent. When you touch hook logic, drive it
   test-first: add or extend the co-located `*.test.mts`, watch it fail, then make
   it pass. Refactor only when green.
3. **Verify** — run the verify gate above and get it green *before* you commit.
4. **Commit** your changes (one commit, or a few focused commits) in imperative
   present tense. Do NOT add a `Co-Authored-By` or "Generated with" trailer.

## Rules

- Address only the review feedback. Do not add unrelated changes or speculative
  features.
- No commented-out code or TODOs in committed code.
- Do NOT push, force-push, rebase, or open/close pull requests — the workflow
  handles the push.
- You must produce at least one commit. If there is genuinely nothing to change,
  stop and explain why rather than committing an empty or unrelated change.

When your changes are committed, write a handoff to `{{NOTES_FILE}}` with two
clearly labelled parts:

1. **SUMMARY** — a short note (GitHub-flavoured Markdown) of what you changed, for
   a top-level PR comment.
2. **REPLIES** — one entry per inline comment you addressed, each giving the
   comment's numeric `id` and a short reply. Write "None." if there were no
   actionable inline comments.

This file is the only thing the next pass sees.

# Done

Once your changes are committed, the verify gate is green, and you have written
the notes file, output:

<promise>COMPLETE</promise>
