# Changelog

All notable changes to this project are documented in this file.

The `v1` tag is a floating major-version pointer: it always tracks the newest
`v1.x.y` release, so consumers can pin `#v1` to follow the latest compatible
version without editing their workflow on every release.

## Unreleased

## v1.4.0 — 2026-08-13

- Label the final spec→default PR `agent:review-pr` when the orchestrator opens it, so
  the review is already running by the time anyone looks. **This is a behaviour change
  for consumers**: a spec now costs one extra agent run, on a diff that is the whole
  feature. Set `reviewFinalPr: false` in `.sandcastle/agent-workflows/config.json` (or
  `REVIEW_FINAL_PR=false` for one run) to keep the previous behaviour; only an explicit
  `false` disables it, so a mistyped value leaves the review on rather than silently
  removing one you were relying on. The label is applied only when the PR is newly
  created — never on the idempotent path that finds one already open, which would fire a
  second review every advance — and it needs `AGENT_PAT`, since a label written by
  `GITHUB_TOKEN` triggers no workflow. The PR is still a draft, the review is still
  advisory with no verdict, and nothing routes on it: the human gate is unmoved. Both
  entry points inherit this from one shared routine, so a locally-run spec does not
  silently skip its review.
- Make the status view's issue reference the click target. `#1521` is what you read and
  what you click — it carries the issue URL through an OSC 8 hyperlink rather than a
  column of visible text roughly fifty characters wide, and the state marker stays
  outside the link. The URL column survives as the fallback: piped, redirected, or with
  `--no-hyperlinks`, it is printed exactly as before, so a reference is never left
  unreachable. Independent of `--no-color` — they are separate terminal capabilities.
- Default the status view's hyperlinks **off** inside Herdr (`HERDR_ENV=1`), printing the
  URL column instead. Measured against Herdr 0.8.0 under Ghostty, an OSC 8 link in a pane
  opens on neither route — not on ⌘-click, which Herdr receives and does not act on, nor
  on ⌘-Shift-click, which bypasses Herdr's mouse capture and reaches the host terminal
  with no hyperlink to find — while Herdr's plain-URL clicking works on both. So inside
  Herdr the column is a working click target and the escape is an inert one, and the TTY
  default was landing on a row with neither a link nor a URL. `--hyperlinks` forces them
  back on, so a Herdr that fixes OSC 8 costs a flag rather than a release. This is the
  only terminal the view knows by name.
- Refresh the watched status view only when the tracker has actually changed. Each tick
  now asks one cheap question first — the remote branch list, which is not an API call,
  plus one conditional GitHub read carrying the previous `ETag` — and performs the full
  pass only when the answer is yes. A `304 Not Modified` costs nothing against the
  primary rate limit, so a watch left open all day consumes almost none. The probe is an
  invalidation signal and never a source of display data, so `--watch` still shows exactly
  what a one-shot run prints; it fails open, so a probe error causes a refresh rather than
  a stale screen; and a staleness ceiling forces a full pass regardless, so a change the
  probe cannot witness costs latency rather than a frozen view.
- Drop the status view's default `--watch` interval from 30s to 5s, and its floor from 5s
  to 2s, now that a tick costs a conditional read rather than a full fetch. A label change
  shows up in about five seconds instead of up to thirty — measured detection latency for
  the conditional read is around four. The floor's reason changed rather than merely
  moving: it no longer protects the shared rate limit, it protects against an interval
  shorter than the tick's own round trip. The 3600s ceiling is unchanged, for its own
  unrelated reason — past it the timer overflows and fires without pausing at all.

## v1.3.1 — 2026-08-13

- Move `@ai-hero/sandcastle` from `^0.7.0` to `^0.12.0`. No call this package makes
  changed shape: nothing was removed from the library's public API across the five
  releases, and the additions (`maxRetries` on structured output, `sandbox.exec()`,
  `verbose` stream logging, `permissionMode` on `claudeCode()`) are all optional and
  unadopted here. The 0.12.0 default-model bump does not reach us either — every run
  passes its model explicitly, from `agentModel`.

## v1.3.0 — 2026-08-12

- Add `--yes` to the attended spec loop: it pre-accepts the preview prompt so a run
  can start with nothing at the terminal to answer it (a launcher script, an
  unattended resume). The preview is still printed in full and the run logs which
  flag accepted it. With `--no-pause`, a spec run is fully non-interactive.
- Add the status view: `agent-workflows status` (`yarn agent:status`) prints the
  specs currently building in the repo you are standing in, with their
  tracer-bullets, build order, and per-slice state. Read-only and one-shot.
- Resolve a slice's spec from GitHub's native sub-issue hierarchy where it exists,
  falling back to the body's `## Parent` where it does not, so adopting native
  hierarchy is gradual and per-repo. A migrated spec's tracer-bullets are read
  through the sub-issue relationship and its own cross-references, so a slice that
  is native and a slice that is only textual land in one tree — and the status view
  no longer scans the whole repo to build it. Ordering is unchanged — still
  `## Blocked by`.
- Colour-code the status view's states on a terminal, with `agent:blocked` in bold
  red. Colour is emitted only when stdout is a TTY — piping or redirecting the view
  gives clean text — and `--no-color` (or `--no-colour`) suppresses it on a terminal
  too.
- Add `--watch` to the status view: it redraws in place every 30 seconds
  (`--interval <seconds>` to change it, 5s floor) on its own screen, leaving the
  scrollback intact on ctrl-c. A redraw only — no key bindings and no input loop.
- Order slices by the **union** of GitHub's native `blockedBy` edges and the body's
  `## Blocked by` refs, rather than by the body alone. A spec declaring dependencies
  natively, textually, or half each builds in one correct sequence, so adopting native
  dependencies is gradual and per-repo. The union is not the `native ?? textual`
  fallback membership uses: blockers are a set, and over-blocking shows up as a
  deadlocked row while under-blocking silently builds on a dependency that has not
  landed. Everything that computes a build order reads it: the status view and the
  orchestrator, unattended and attended. A native blocker in another repository is left
  out of the order — issue numbers are per-repo — and named instead, on the status view's
  row and in the spec's progress comment. The native edges ride the issue-list read every consumer
  already makes, so this costs no request per slice; a `gh` older than 2.94 does not
  serve them and now fails the read rather than the orchestrator quietly ordering on
  half the edges.
- Refuse `agent:implement` on a slice whose blocker is still open whichever way it was
  declared — natively or under `## Blocked by`. The guard was the last reader of a
  dependency edge with a parse of its own, so a slice blocked only natively walked past
  it; it now reads the same union everything else orders on. Mostly defence in depth —
  ordering would not have dispatched such a slice — but it is the whole gate on the
  attended and manual paths, where a human names a slice directly, and it is the only
  reader that honours a blocker which is not a tracer-bullet of the same spec. A blocker
  in another repository is reported to the job log rather than gating the run, unless it
  has already closed — that was never a wait. The guard no longer reads one issue per
  blocking ref to learn its state: a native edge carries its blocker's state, and the
  issue list the guard already reads carries the rest, so in the ordinary case the check
  costs no request of its own. A ref past the end of that list still falls back to a point
  read, because a blocker that scrolled off a page must not quietly stop gating.
- Record the design in ADR-0007 and add *status view* and *spec tree* to the
  glossary.
- Declare the Node floor (`engines: node >= 22`) the package has always assumed, ship
  `CHANGELOG.md` in the packed `files`, and carry the release version in
  `package.json` — it had read `1.0.0` since the first release, which is what a
  consumer's lockfile records.

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
