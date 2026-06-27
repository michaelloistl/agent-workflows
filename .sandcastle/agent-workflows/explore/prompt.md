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

This repo (`agent-workflows`) holds reusable GitHub Actions workflows and the
`.sandcastle/` hook layer that drives a label-triggered coding-agent fleet. Read
`AGENTS.md`, `CONTEXT.md` (the domain glossary — match its vocabulary), and the
`docs/adr/` decisions, then explore to understand what implementing this issue
would involve.

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
