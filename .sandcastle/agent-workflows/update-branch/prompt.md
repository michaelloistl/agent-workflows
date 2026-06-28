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

Merge the base branch into the current branch, resolve any conflicts in line with
the repo conventions, and confirm the result with the verify gate.

## Repo conventions & verify gate (customise per repo)

<!-- CUSTOMISE PER REPO — a consuming repo replaces this block with its own
     stack, conventions docs, and verify commands. This is agent-workflows'
     own copy: a GitHub Actions + TypeScript repo (reusable workflows under
     `.github/workflows/`, the `.sandcastle/` hook layer in `.mts` run via
     `tsx`, and Markdown docs). No Rails, no full test suite. -->

- **Resolve conflicts by:** the project's conventions in `AGENTS.md`,
  `CONTEXT.md`, and the relevant `docs/adr/` decisions — keep the hook contract
  and the tracker-agnostic boundary intact.
- **Verify gate** (must be green before you declare the merge complete):
  - `yarn typecheck && yarn test`
  - for any workflow YAML affected by the merge: re-check the syntax and that
    every hook it references exists.

## Workflow

1. Run `git merge --no-edit origin/{{BASE_REF}}`.
2. **If the merge is clean**, git has already created the merge commit — there is
   nothing to resolve.
3. **If there are conflicts**, resolve every one. Read both sides and the
   surrounding code, keep the intent of BOTH branches, and prefer the project's
   conventions above. When the files are resolved, `git add` them and complete the
   merge with `git commit --no-edit`.
4. **Verify** — run the verify gate above and get it green to confirm the merge
   (and any conflict resolution) is sound before you finish.

## Rules

- Do NOT push, force-push, rebase, or open/close pull requests — the workflow
  handles the push.
- Leave exactly the merge (plus any conflict-resolution fixes) committed on this
  branch. Do not add unrelated changes.
- Do NOT add a `Co-Authored-By` or "Generated with" trailer to any commit.
- If the merge cannot be completed sensibly, stop and explain why rather than
  forcing a broken state.

# Done

Once the base branch is merged in, conflicts (if any) are resolved, and the
verify gate is green, output:

<promise>COMPLETE</promise>
