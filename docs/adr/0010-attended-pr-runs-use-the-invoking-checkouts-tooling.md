# An attended PR run's tooling is the invoking checkout

The PR verbs split **where the tooling is** (`$TOOLING_DIR`) from **what the agent acts on** (cwd, the pull request's head). The unattended path fills the first slot with a detached worktree checked out at the default branch. The attended path fills it with the checkout the developer launched from. This is the one place where an attended run deliberately does something *other* than what CI does, and it is recorded here because the reason is a property of who is watching, not an implementation detail.

## Status

accepted (refines ADR-0005's two-entry-points split and ADR-0001's hook contract; neither is changed)

## Context

ADR-0001 gave a PR verb two checkouts for one reason: a pull request's branch may **predate the tooling**. The agent has to run against the code under review, but the guards, status and finalize hooks must be the ones the fleet ships *today* — otherwise a PR opened before a hook existed cannot be reviewed by it. So the workflow checks out the PR head as the working tree, checks the default branch's tooling into `$RUNNER_TEMP/agent-tooling`, and passes that path as `$TOOLING_DIR`.

Attending those verbs (issue #139) put the same slot in front of a developer, and the isolation argument inverts. A developer running `agent-workflows review-pr 138` is, very often, running it *because they are changing what `review-pr` does*: the prompt, the guard, the finalize. Loading tooling from a detached default-branch worktree would run the version already merged and shipped — the developer's edit would be invisible until pushed, merged, and re-run through CI, which is precisely the loop the attended path exists to collapse. It would also be an odd thing to isolate *from*: the developer's checkout is not an old PR branch that may lack the tooling, it is the newest tooling there is.

`implement-pr` makes the slot mandatory rather than optional. Its push-and-finalize step interpolates `$TOOLING_DIR` straight into a shell command (`yarn --cwd "$TOOLING_DIR" sandcastle:implement-pr-finalize`), so an empty value breaks the step outright — a different failure from `review-pr`'s, where an unset value falls back to the ambient working directory and quietly runs the worktree's own tooling.

## Decision

**An attended PR run sets `$TOOLING_DIR` to the root of the checkout it was launched from**, resolved with `git rev-parse --show-toplevel` (the toplevel, not the raw cwd, so a run started from a subdirectory still finds the repo's `.sandcastle/` overrides and its config file), falling back to the cwd when git cannot answer. The worktree under `worktreeRoot` remains the cwd of the agent run, so the split ADR-0001 describes is preserved exactly — only the directory on the tooling side of it differs.

**The contract is unchanged, and that is what makes this safe.** `$TOOLING_DIR` means *where the tooling is*; it has never meant *a detached default-branch worktree*. The hooks read it through the same `--cwd`, the sequencer resolves `"tooling"` steps through the same one variable, and no hook learns which entry point it is under.

**Only PR runs set it.** An attended issue run has a single checkout and no split, and hands its sequence to the worktree's own `sandcastle:<verb>-sequence` script — the tooling it builds on is the base branch's, as it is in CI.

## Considered alternatives

- **Mirror CI: a detached default-branch worktree locally too.** Rejected — it makes the fastest feedback loop the fleet has (edit a PR verb, run it) impossible without a push, for the sake of an isolation the local case does not need. The thing CI isolates *from* is a stale PR branch; a developer's checkout is the opposite of that.
- **A `--tooling-dir` flag.** Rejected — a flag implies a decision the developer must make on every run, when the right answer is the same every time. Nothing in the design forbids adding one later if a case for the other value appears.
- **Copy the invoking checkout into a scratch tooling worktree.** Rejected — it would run the developer's *committed* tooling, not their working tree, which is the version they are least interested in, at the cost of a copy per run.

## Consequences

- **What an attended PR run does is what the developer's checkout says, including uncommitted changes.** That is the feature; it is also the caveat, and it is the reason the attended and unattended paths can differ in *behaviour* while still sharing one *plan*. A developer reporting "it did X locally" is reporting on their tree, not on the release.
- **The guarantee that survives is the sequence.** Both entry points still build it from the one plan module, and the `auto`-mode plan pins prove the unattended shape is untouched. Tooling location was never part of that guarantee.
- **A PR verb's logic can be changed and run in one command**, which is how the PR verbs are now dogfooded.
- **`docs/hook-contract.md` states both fillings of the slot**, so a consuming repo implementing the contract does not read the CI arrangement as the definition.
