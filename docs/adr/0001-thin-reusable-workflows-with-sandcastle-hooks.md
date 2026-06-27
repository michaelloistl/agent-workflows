# Thin reusable workflows driving sandcastle hooks (Model X)

We are unifying the five label-triggered agent workflows (explore, implement, implement-pr, review-pr, update-branch) — currently copy-pasted and drifting across lauza_loistl, ldf, and on-vantage — into reusable workflows in a central public repo (`michaelloistl/agent-workflows`). The central workflows are **thin and tracker-agnostic**: they own only generic runner setup, services, git operations, and control flow, and delegate every tracker- and domain-specific operation to a fixed contract of per-repo sandcastle hooks (`<verb>-guards`, `<verb>-fetch-spec`, `<verb>`, `<verb>-status`, `<verb>-finalize`). We chose this over a "fat YAML" central workflow that keeps guards/labels/PR-creation in the shared file.

## Status

accepted

## Considered Options

- **Thin YAML + sandcastle hooks (Model X) vs fat orchestrator YAML (Model Y).** Chose X. With on-vantage already on Linear, any central workflow that embeds `gh`-CLI guard/label logic must special-case Linear with `if: tracker == …` branches — exactly the conditional sprawl unification is meant to remove. Pushing all tracker I/O behind hooks makes Linear "just a different `status`/`guards` implementation" and keeps the central file identical for every repo. The ldf ADR (0002) explicitly deferred this abstraction until it "pays for itself across multiple repos" — that point is now.
- **Reusable workflows vs composite action.** Chose reusable workflows. The shared surface is whole workflows — multi-job structure, service containers, event triggers, concurrency — which composite actions cannot express. A composite action would force every repo to keep duplicating the services block and job wiring.
- **The central YAML touching the tracker, even for GitHub, vs zero tracker I/O.** Chose zero. Letting the YAML keep its `gh` calls (and only abstracting Linear) is a lighter migration but re-introduces the tracker conditional and leaks the abstraction. `git push` stays in YAML (plain git for all repos); PR *creation* is the `finalize` hook (the cross-reference — `Closes #N` vs a Linear ref — is tracker-aware).
- **Where Z (packaging the sandcastle layer) sits.** Deferred, named as the north star. Model X centralizes the orchestration *shell* but leaves the sandcastle guard/prompt *logic* duplicated across repos. Extracting that into a published package is a separate, larger effort to undertake once the hook contract has proven stable.

## Consequences

- lauza and ldf must migrate their guard/label/PR-creation logic out of YAML bash into new sandcastle hook commands they do not yet have (`<verb>-guards`, `-fetch-spec`, `-status`, `-finalize`). on-vantage already has most of these.
- The hook contract is a real interface: renaming or re-sequencing a hook is a breaking change to the central workflow, versioned via the major tag.
- on-vantage validates the contract before `@v1` is cut, precisely because it is the divergent (Linear) case — fixing the contract is cheap before it is pinned and expensive after.
- The orchestration logic remains duplicated across repos until Z is done; this is an accepted interim cost.
