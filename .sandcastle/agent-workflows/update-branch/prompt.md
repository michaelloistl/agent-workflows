# Context

You are bringing a stale GitHub pull request branch up to date by merging its
base branch into it. The PR branch is checked out as your current branch, the
base branch has been fetched as `origin/{{BASE_REF}}`, and the git identity is
already configured. Your job is to merge the base in, resolve any conflicts, and
leave the result committed on this branch.

After this run, the workflow pushes the branch — you do NOT push, open, or close
anything yourself.

## The pull request

**#{{PR_NUMBER}}** — base branch: `{{BASE_REF}}`

# Task

This repo (`agent-workflows`) is a GitHub Actions + TypeScript repo. Merge the
base branch into the current branch:

1. Run `git merge --no-edit origin/{{BASE_REF}}`.
2. **If the merge is clean**, git has already created the merge commit — there is
   nothing to resolve.
3. **If there are conflicts**, resolve every one. Read both sides and the
   surrounding code, keep the intent of BOTH branches, and prefer the project's
   conventions (`AGENTS.md`, `CONTEXT.md`, `docs/adr/`). When the files are
   resolved, `git add` them and complete the merge with `git commit --no-edit`.

## Rules

- Do NOT push, force-push, rebase, or open/close pull requests — the workflow
  handles the push.
- Leave exactly the merge (plus any conflict-resolution fixes) committed on this
  branch. Do not add unrelated changes.
- Do NOT add a `Co-Authored-By` or "Generated with" trailer to any commit.
- If the merge cannot be completed sensibly, stop and explain why rather than
  forcing a broken state.

# Done

Once the base branch is merged in and conflicts (if any) are resolved, output:

<promise>COMPLETE</promise>
