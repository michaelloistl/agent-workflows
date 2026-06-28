# Context

You are exploring a single GitHub issue to help the repo owner judge its scope
BEFORE any code is written. This is strictly READ-ONLY: do not edit files, do not
commit, and do not create branches or pull requests. Your only product is a
written exploration handed off to the next pass.

## The issue

**#{{ISSUE_NUMBER}} — {{ISSUE_TITLE}}**

<issue>

!`cat {{SPEC_FILE}}`

</issue>

# Task

Explore the issue to understand what implementing it would involve, and hand off
a written scope assessment.

## Repo conventions & verify gate (customise per repo)

<!-- CUSTOMISE PER REPO — a consuming repo replaces this block with its own
     stack, conventions docs, and verify commands. This is agent-workflows'
     own copy: a GitHub Actions + TypeScript repo (reusable workflows under
     `.github/workflows/`, the `.sandcastle/` hook layer in `.mts` run via
     `tsx`, and Markdown docs). No Rails, no full test suite. -->

- **Read first:** `AGENTS.md`, `CONTEXT.md` (the domain glossary — match its
  vocabulary), and the relevant `docs/adr/` decisions. Note the patterns a change
  would have to follow — the hook contract, the tracker-agnostic boundary.
- **Verify gate:** none. This is a read-only verb — your only product is the notes
  file, so there are no commands to run. (A consuming repo still keeps the
  conventions docs above current with its own stack.)

Investigate, using search and read tools only, and form a view on:

- **Areas & files** a change would touch — name concrete paths (which reusable
  workflow under `.github/workflows/`, which hook under `.sandcastle/`).
- **Approach** you would take, and any alternative worth weighing.
- **Patterns & conventions** already in the codebase to follow (the hook
  contract, the tracker-agnostic boundary).
- **Risks & open questions** the repo owner should decide before building.

Stay strictly read-only. Do not modify, create, or delete anything in the repo.

When you have a clear picture, write your exploration as a GitHub-flavoured
Markdown comment to the notes file at `{{NOTES_FILE}}`. Keep it focused and
skimmable: short sections, concrete file paths, no filler. This file is the only
thing the next pass sees.

# Done

Once you have written the exploration to `{{NOTES_FILE}}`, output:

<promise>COMPLETE</promise>
