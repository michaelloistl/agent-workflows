# `init` and `sync` — a generated install, and one planner behind both

Setting a consuming repo up meant transcribing five README steps by hand: a thin caller per verb, a `sandcastle:*` script per hook, a git-dependency pin, the trigger labels, the secrets. This adds a fourth entry point to the package — `agent-workflows init` to do that, and `agent-workflows sync` to keep it current — sharing one planner, and deriving the consumer's hook scripts from this repo's own `package.json` rather than from a second table.

## Status

accepted

## Context

The five manual steps are not hard, but they are a matrix, and a matrix transcribed by hand goes wrong in ways nothing detects until a run fails. The hook set is asymmetric (`explore` has a `-sequence` and no `-guards-sequence`; the PR verbs have a `-guards-sequence` and no plain `-sequence`; the orchestrator has `kickoff`/`advance` and neither), the orchestrator's two callers pass `mode:` and must *not* pass `enable-ruby`, and a `pull_request_target` caller on a public repo needs an author gate or any external PR can start a billed run against the repo's secrets. A README asks a human to get all of that right; nothing checks that they did.

Keeping an installed repo current is the second half, and the one with no manual procedure at all. A repo installed at v1.2 has callers pinned at v1.2, hook scripts from v1.2, and overrides copied at v1.2 — and nothing anywhere says which of those is now stale.

## Decision

**One planner, two policies.** `plan.mts` decides everything — which workflows, which files, what changed, what to warn about — as data, against a `RepoState` the entry point reads and applies. That is the same shape as one sequencer behind two entry points (ADR-0005), for the same reason: "what would `sync` do to a repo pinned at v1.2 with two overrides and a hand-edited caller?" becomes a unit test rather than a scratch checkout. `init` is told what to enable and writes what is missing; `sync` detects what the repo already enabled and updates it in place. Everything downstream of that difference is common, so the two commands cannot drift into disagreeing about what an installed repo looks like.

**The consumer's hook scripts are derived from this repo's `package.json`.** The central repo is its own first consumer, so its own `sandcastle:*` scripts already spell out every (verb, hook) pair the workflows invoke — including every asymmetry above. Reading them means a hook added here reaches every consumer on their next `sync` with no second list to update. Only the bin path differs (`node bin/agent-workflows.mjs` here, the `agent-workflows` bin on the yarn PATH there), and the verb each script drives is read from the *command*, never the script name, which is ambiguous across hyphenated verbs.

**The installer owns the scripts that call the dispatcher — not the `sandcastle:` namespace.** A stale hook script is worse than a missing one, because the workflow calling it fails at the point of use rather than at install time, so a dispatcher script no longer desired is removed. But `.sandcastle/` is the consumer's own hook layer and a repo may keep its own `sandcastle:seed` there: the namespace is not the installer's to empty, only its own scripts within it.

**Callers are re-pinned, never regenerated.** The caller is the one generated artifact a consumer legitimately edits — the `with:` inputs are their toolchain, the `if:` is their access policy — so `sync` moves the `uses:` ref and leaves every other line alone. Every such `uses:` in the file moves, since a consumer may put two jobs in one caller and half a re-pin is worse than none. What it cannot fix it reports, and the generated-file marker decides *whose* drift it is describing: a file the installer wrote and can no longer re-pin is its own mess to explain; one written by hand is not.

**`sync` re-resolves the dependency instead of installing it.** The default pin is the moving major tag, because the compatibility promise sits at the major. That makes plain `yarn install` a no-op for `sync`'s whole purpose: the `github:owner/repo#v1` descriptor is unchanged, so the lockfile's resolution stands and CI's `--frozen-lockfile` keeps running the commit the repo was installed at. `sync` therefore runs `yarn up agent-workflows` (`yarn upgrade` on yarn 1) and says, in its own output, to commit the updated lockfile. It also states the ordering it cannot escape: `sync` runs the copy in `node_modules`, so it wires the hooks *that* version knows about, and a hook added in the release it is moving to arrives on the run after.

**The selectable unit is an `Installable`, not a verb.** What a consumer enables is the five verbs plus the `implement-spec` orchestrator, and `CONTEXT.md` is explicit that the orchestrator is not a sixth verb — it triggers no agent action and follows no hook contract. Rather than widen "verb" to six, the union gets its own name in the catalog, the flag (`--enable=`) and the plan output. The dispatcher's own argument slot keeps the name it already has in `planVerb`.

**Nothing is written until the whole plan is accepted**, in the shape the spec loop used at the time: print the blast radius, a non-interactive stdin declines, `--yes` pre-accepts, `--dry-run` prints and stops. *(ADR-0011 flipped the spec loop's half of that shape — a bare `implement-spec <n>` now proceeds unattended, with `--pause` to be asked and `--dry-run` to look. It deliberately did **not** flip `init`/`sync`, and the reason is recorded there: `implement-spec 139` names the work exactly, so its preview tells the developer nothing they did not already know, while `init`'s plan is derived from whatever it finds in the repo — its preview is information the developer does not yet have, and the prompt is what delivers it. The decision below stands unchanged; only the cross-reference dates.)* Three refusals are deliberate and permanent:

- **Secrets are reported, never written.** The installer reads and writes no secret material, and `AGENT_PAT` cannot be minted outside the GitHub UI anyway. A secret list that cannot be read at all (it needs admin) says nothing rather than claiming the secrets are missing.
- **A `package.json` that exists but does not parse blocks the run.** Absent and unreadable are different states: absent means `init` writes a minimal manifest, which is the normal case for a Rails or Go consumer; unreadable — a UTF-8 BOM, a mid-edit comma, an `EACCES` — must stop, because treating it as absent replaces a real manifest with a four-line stub and the only hint would be the word `(create)` in a plan the human was asked to accept.
- **Neither command runs against a checkout of this package.** Its hook scripts deliberately run `node bin/…` against its own source; an install here would rewrite every one of them. Detected by package name, the one thing true of the central repo in every checkout, worktree and fork.

**Defaults come from the repo, so the common install takes no arguments.** Everything enabled, the installer's own major as the pin, `git config user.email` for the identity, a `Gemfile` for `enable-ruby`, repo visibility for the author gate. Unknown visibility is treated as **public**: the gate it implies is a restriction, and guessing "private" would generate an ungated `pull_request_target` caller — the one wrong guess here with a security cost.

## Considered alternatives

- **An interactive questionnaire.** Rejected: a setup command that can only be driven by answering six prompts cannot be put in a script or handed to an agent. Every value is a flag with a detected default instead, and the single prompt is the accept/decline on a plan already printed in full.
- **A caller table transcribed into the installer.** The obvious shape, and the one that produces a repo whose caller triggers on a label nothing creates. Everything the installer knows about one installable lives in one catalog row, read by both the renderer and the label step.
- **Regenerating callers on `sync`.** Simpler to write and it silently reverts the two things in the file that are the consumer's: their toolchain inputs and their access policy.
- **Writing secrets with `gh secret set`.** Rejected outright — it would put secret material through the installer for a step a human has to do in the UI regardless.
- **Deleting a caller when its workflow is deselected.** Narrowing `--enable` removes hook scripts; it does not delete a workflow file, because that silently disables something a human may still be labelling issues for. Reported instead.
- **Publishing to a registry so `sync` is a version bump.** Out of scope here and orthogonal: the distribution decision (a git dependency, ADR-0001) is what makes the pin a ref, and the moving major tag is what makes that ref useful.

## Consequences

- `CONTEXT.md` gains **installer** and **installable**. The second exists precisely so "verb" keeps meaning the five agent actions while the thing `--enable` selects can include the orchestrator.
- The package acquires a fourth entry point, after the workflow sequencer, the local sequencer and the status view (ADR-0007). Like `status` it runs no agent and follows no hook contract; unlike `status` it writes, and it is the only entry point that runs *before* the package is a dependency, via `npx github:<owner>/agent-workflows#v1 init`.
- The README's five manual steps stay, as "Installing by hand" — they are the reference for what an installed repo looks like, and they now teach the same `@v1` pin the generator writes rather than `@main`.
- A repo can be installed by hand and synced afterwards, because detection reads the callers and the scripts rather than a marker file the installer would have had to write. Nothing about being installed is stored: the repo's own state is the record.
- Two `sync` runs are needed to adopt a release that adds a hook — the first moves the dependency, the second (running the new copy) writes the new script. The alternative, re-executing the freshly installed copy mid-run, buys one saved command for a much sharper failure mode.
