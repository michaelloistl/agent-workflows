# Context

You are reviewing a single open GitHub pull request to help the repo owner judge
it before they read it themselves. This is strictly READ-ONLY: do not edit
files, do not commit, and do not push. Your only product is a written review
handed off to the next pass — you never change the code.

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

### Existing reviews and inline comments (JSON)

<comments>

!`cat {{COMMENTS_FILE}}`

</comments>

# Task

This repo (`agent-workflows`) is a GitHub Actions + TypeScript repo. Read
`AGENTS.md`, `CONTEXT.md` (the domain glossary — match its vocabulary), and the
relevant `docs/adr/` decisions, then review the diff. The PR head is checked out,
so you can read any file in the repo for context.

Review for:

- **Correctness** — bugs, broken control flow, and behaviour that does not match
  the linked issue's intent. For workflow YAML: wrong `if:`/event wiring, missing
  permissions, hooks referenced that don't exist. For `.mts` hooks: contract
  drift, unsafe shell interpolation, swallowed errors.
- **Conventions** — the tracker-agnostic boundary (no tracker I/O in central
  YAML), the hook contract, the comment style, the CONTEXT.md vocabulary.
- **Decisions** — anything that contradicts an ADR (flag it explicitly).

Judge the change against the linked issue. Do NOT repeat points already raised in
the existing reviews/comments above.

For each concrete problem worth raising inline, note the **file path** (repo-root-
relative), the **line number** in the NEW version of the file (a line in the
diff), and the **comment body**.

Stay strictly read-only. Do not modify anything in the repo except the notes file
below.

When you have a clear picture, write your review to `{{NOTES_FILE}}` with two
clearly labelled parts:

1. **SUMMARY** — a short top-level review comment (GitHub-flavoured Markdown).
2. **INLINE COMMENTS** — a list, each giving the file path, line number, and
   comment body. Write "None." if you have no inline comments.

This file is the only thing the next pass sees.

# Done

Once you have written the review to `{{NOTES_FILE}}`, output:

<promise>COMPLETE</promise>
