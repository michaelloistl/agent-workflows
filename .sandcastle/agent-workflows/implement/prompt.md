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

This repo (`agent-workflows`) is a GitHub Actions + TypeScript repo: reusable
workflows under `.github/workflows/`, the `.sandcastle/` hook layer (`.mts` run
via `tsx`), and Markdown docs (`CONTEXT.md`, `docs/adr/`). There is no Rails app
and no test suite gate. Read `AGENTS.md`, `CONTEXT.md` (match its vocabulary),
and the relevant `docs/adr/` decisions before changing anything.

## Workflow

1. **Explore** — read the issue and any parent/blocking issue it references, plus
   the conventions and decisions above. Read the files you'll touch first.
2. **Plan** — decide the smallest change that satisfies the issue.
3. **Execute** — make the change, following the codebase's existing patterns (the
   hook contract, the tracker-agnostic boundary, the comment style).
4. **Self-check** — keep the change valid:
   - For workflow YAML, sanity-check syntax and that any hook you reference exists.
   - For `.mts` hooks, keep them consistent with the contract and the shared
     modules.
5. **Commit** — one commit (or a few focused commits), imperative present tense.
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

Once the work is committed, output:

<promise>COMPLETE</promise>
