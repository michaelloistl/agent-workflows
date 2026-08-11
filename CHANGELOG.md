# Changelog

All notable changes to this project are documented in this file.

The `v1` tag is a floating major-version pointer: it always tracks the newest
`v1.x.y` release, so consumers can pin `#v1` to follow the latest compatible
version without editing their workflow on every release.

## Unreleased

- Add `--yes` to the attended spec loop: it pre-accepts the preview prompt so a run
  can start with nothing at the terminal to answer it (a launcher script, an
  unattended resume). The preview is still printed in full and the run logs which
  flag accepted it. With `--no-pause`, a spec run is fully non-interactive.

## v1.2.2 — 2026-08-11

- Fix attended-run defects surfaced by the spec-loop dogfood, so a locally
  driven run reports a refused sequence back to its caller instead of failing
  silently.
- Resolve the PR-verb dispatcher so the central repo can run its own PR verbs.
- Add this changelog: `CHANGELOG.md` now ships with the package and is linked
  from the README repo layout.

## v1.2.1 — 2026-08-11

- Stand the CI advance down while an attended local run owns a spec, so a
  terminal-driven run and the reusable workflows no longer race to advance the
  same slice.

## v1.2.0 — 2026-08-11

- Add the local sequencer: an attended spec loop that builds a whole spec from
  the terminal, alongside the existing reusable workflows.
- Collapse the `explore`, `implement`, `implement-spec`, and the three PR verbs
  onto one sequencer with a shared plan-and-executor core.
- Add a config file with a configurable base branch and tunable check timings.
- Add stepwise checkpoints, graceful stop, and resume, plus a run ceiling for
  the loop.
- Add a run log and an optional Herdr progress surface.
- Record the local-sequencer design in ADR-0005 and ADR-0006 and expand the
  glossary.

## v1.1.0 — 2026-07-13

- Gate the tracer-bullet merge on the PR's own CI and gate next-slice dispatch
  on spec-branch CI, so a slice never advances on a red build.
- Add a post-agent fresh-DB boot check to `implement.yml`.

## v1.0.1 — 2026-07-13

- Fix the Postgres service container in the reusable workflows missing its
  `POSTGRES_DB` environment variable.

## v1.0.0 — 2026-07-08

- Initial release: central reusable agent workflows, distributed as a
  git-dependency package via an override-resolution dispatcher, with this
  repository dogfooded as the first consumer.
- Add the implement-spec (originally implement-prd) orchestrator — workflow
  shell, guards, kickoff, advance, and final PR — driven by a spec-graph and
  spec-context decision core with a `node:test` suite.
- Derive and thread the base branch through the `implement` verb; add
  `node-version` and `git-author-name` inputs to the reusable workflows.
- Declare `workflow_call` secrets explicitly so cross-owner callers can pass
  them by name.
- Compute the PR diff locally to bypass the GitHub 300-file API cap.
- Identify specs structurally rather than by a title prefix or label, and allow
  tracer-bullets to hang off native GitHub sub-issue parents.
- Drop the per-slice review loop so slices merge after build (ADR-0004).
- Document install, usage, workflow, and labels in the README and lift the
  implement/verify discipline into the reference prompts.
