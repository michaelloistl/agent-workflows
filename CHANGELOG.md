# Changelog

All notable changes to this project are documented in this file.

The `v1` tag is a floating major-version pointer: it always tracks the newest
`v1.x.y` release, so consumers can pin `#v1` to follow the latest compatible
version without editing their workflow on every release.

## Unreleased

- **Withhold an attended `implement-pr` finalize** with `--finalize=ask|never`, the flag
  the issue `implement` verb and the read-only `review-pr` already had, now on the verb
  that commits onto a pull request. `never` stops with the commits on the retained
  worktree — nothing pushed, no replies posted, the tracker untouched; `ask` prints how
  many commits it is about to push, to which head ref, and how many threaded replies it
  will post, and pushes only on an explicit `y` (a bare Enter or a non-interactive stdin
  declines — the safe default). `auto` remains the default and remains full parity with
  the unattended path, its plan pin unaltered. A withheld run touches the pull request NOT
  AT ALL: the plan drops the in-progress status write along with the tail, so a `never`
  run and a declined `ask` run leave no label, no comment and no commit on the remote. A
  confirmed `ask` lands exactly what an `auto` run would have, down to the
  non-fast-forward self-report: this verb's push and finalize are one bundled step —
  finalize only makes sense after a successful push — so the plan gained two shapes, the
  run without that tail and the tail alone, each pinned by the plan module's tests, and
  the confirmation runs the tail as a second slice. The worktree is retained either way,
  as a commit-producing verb's clean success already was: the commits are what you
  inspect. The run summary reports the mode, whether the run finalized, and where the tree
  is, in this verb's own terms — commits on the pull request's head, never an agent branch
  it does not cut. `--interactive` composes with every mode. `update-branch`, whose whole
  point is the push, still does not read the flag and its plan is unaltered by a mode.
- **Withhold an attended `review-pr` finalize** with `--finalize=ask|never`, the flag the
  issue `implement` verb already had, extended to a pull-request-numbered verb. `never`
  composes the review and posts nothing; `ask` prints what finalize is about to post — the
  summary, the inline-comment count, and the file holding it — and runs the finalize only
  on an explicit `y`, a bare Enter or a non-interactive stdin declining, which is the safe
  default. `auto` remains the default and remains full parity with the unattended path, its
  plan pin unaltered. A withheld run touches the pull request NOT AT ALL: the plan drops
  the in-progress status write along with the finalize tail, so a `never` run and a
  declined `ask` run leave no label, no comment and no review — the same trace, which is
  none. What the run composed is still written, now to a file inside the run's worktree,
  and a withheld run RETAINS that worktree whatever the verb (a read-only verb's clean
  success otherwise removes it), so you can read exactly what would have been posted. A
  confirmed `ask` posts precisely what an `auto` run would have: the confirmation runs the
  same plan's tail on its own — the review posted, then the run reported done. An
  unrecognised mode is still refused by name rather than defaulting to the posting path,
  and the run summary reports the mode and whether the run finalized, in the verb's own
  terms. Which verbs read the flag is now a tested predicate in the plan module rather than
  a condition in the entry point; `implement-pr` and `update-branch` do not read it yet and
  their plans are unaltered by a mode.
- Run **`implement-pr` as an attended run**: `agent-workflows implement-pr <pr>` addresses a
  pull request's review feedback on your own machine, end to end. It reuses everything the
  attended `review-pr` run established — the worktree at the pull request's head, the
  bootstrap, the fork refusal, the tooling directory at the invoking checkout, both mutexes,
  `--force`, the streamed output, the summary — and adds the difference between a read-only
  verb and one that produces commits. The agent commits onto the checked-out pull-request
  head and the run pushes those commits to the head ref BY NAME, which is why the worktree
  can stay detached at the fetched head. The push is a plain one: a branch that advanced
  remotely during the run self-reports blocked rather than being overwritten. The
  per-comment replies are then posted and the tracker updated exactly as the unattended path
  does — the replies file being another slot the workflow fills under the runner's temp
  directory in CI and the entry point fills locally. A clean success **retains** the
  worktree, unlike the read-only verb's: what provides inspection is the surviving tree you
  can open and diff, the same reasoning the issue `implement` verb already follows; a
  failure or a Ctrl-C abort retains it too. `--interactive` becomes reachable for the first
  time — the eligibility predicate already admitted this verb — so the fixes can be steered
  in a live agent session rather than watched headless; the push and finalize that follow
  are unchanged by it. Finalize is full parity with the unattended path; withholding it with
  `--finalize=ask|never` is the next slice. The unattended `implement-pr` path is unchanged,
  its plan pin unaltered.
- Run **`review-pr` as an attended run**: `agent-workflows review-pr <pr>` reviews a pull
  request on your own machine, end to end. The run creates a worktree under the configured
  root — never your checkout — detached at the pull request's head, bootstraps it with the
  repo's own command, and hands the whole verb sequence to the sequencer, so the attended
  and unattended paths still cannot drift; the review posts through the same reviews API.
  Two things differ from CI deliberately. A cross-repository (fork) pull request is refused
  before any worktree exists, naming the reason — its head lives on another repository, so
  checking it out means a second remote and finalizing means push rights an attended run
  must not assume. And the tooling directory points at the checkout you launched from
  rather than a detached default-branch worktree: CI isolates the tooling because a pull
  request's branch may predate it, while locally you want the tooling in front of you, so
  changing a PR verb's logic and running it needs no push in between. The rest is the
  behaviour the issue verbs already have: `agent:in-progress` on the pull request refuses
  the run and `--force` overrules it, the local lock keeps two terminals off the same verb
  and pull request, a guard refusal prints to the terminal and posts nothing, a failure or
  a Ctrl-C abort retains the worktree while a clean success removes it (it is read-only),
  `--interactive` is still refused by naming interactivity, and the run closes with a
  summary of the outcome, the worktree's fate, and what finalize did. The unattended
  `review-pr` path is untouched, its plan pin unaltered.
- **Keep the local-run marker when an attended spec run halts.** `agent:local` on the
  spec issue used to share the local lock's lifecycle: every exit released it, halts
  included. A halt seconds after a merge released it before that merge's `advance` run
  had read the spec issue, so CI found no marker and built the next tracer-bullet — the
  exact slice the developer had just stopped by declining a checkpoint, hitting a run
  ceiling, asking for a graceful stop, aborting, or watching a slice fail. A halted run
  now KEEPS the marker and prints what is still true on its way out: the label is still
  on the spec, CI advance stands down until it goes, handing the spec back to CI takes
  removing the label *and* re-running the advance run that stood down (removing it
  lifts the stand-down but dispatches nothing by itself), and the next attended run
  reclaims it on resume. The end-of-run summary carries a `marker :` line to match. A
  completed run releases it exactly as before, after the final PR is open. A dry run
  still claims nothing. The deadlocked "no ready slice" exit is now recorded as the
  halt it always was, so its summary, run log, and retained marker agree. The decision
  (`markerReleasedOnExit`) is pure and lives beside the rest of the marker vocabulary
  in `shared/spec-marker.mts`; the retention is recorded in the run log.
- Thread the repository **default branch** into both attended entry points, in the same
  `DEFAULT_BRANCH` slot the reusable workflow fills. Every verb's base resolves
  `BASE_BRANCH` → the config file → the repository default, and CI is where those last
  values came from — an attended run has no workflow, so on a repo with no
  `.sandcastle/agent-workflows/config.json` the base resolved EMPTY and `create-branch`
  ran `git fetch origin ""`, failing inside git without naming the cause. It reached
  attended `implement` on any standalone issue and `implement-spec --dry-run` on the
  first slice of a spec (a real run cuts and pushes the spec branch first, so each
  slice's fetch-spec resolves that instead and the hole stayed hidden). It is injected
  as `DEFAULT_BRANCH`, the LOWEST-precedence slot, so a `baseBranch` in the consuming
  repo's config still wins and a tracer-bullet's live spec branch still overrides it.
  Resolution is shared by both entry points (`resolveDefaultBranch`): git's `origin/HEAD`
  first — instant and offline — then `gh repo view` for the checkout whose `origin/HEAD`
  is unset or dangling (a remote added by hand rather than cloned, or a default branch
  renamed since). When neither answers and nothing is configured, an attended run now
  refuses up front and names `git remote set-head origin -a` and the config file, rather
  than starting a worktree and dying in git several steps later.
- Correct the documented sub-issue rule for tracer-bullets in `README.md`, `CONTEXT.md`
  and the two code comments that restated it. The `implement` shape guard has never
  refused a native GitHub sub-issue outright: it refuses an epic (an issue with
  sub-issues of its own) and a sub-issue whose native parent DISAGREES with its
  `## Parent`, while one that agrees is a tracer-bullet and is built — which is how a
  tracker sync mirroring the parent/child edge looks. The docs said the fleet never
  writes a sub-issue at all, which read as if a native parent were always an accident.
  The textual `## Parent` is still required: the orchestrator resolves a spec's
  membership through it alone, so a slice linked only by the hierarchy is invisible to a
  spec run.

## v1.7.0 — 2026-08-15

- Added `-h` and `--help` option reference to `agent-workflows status`
- Added the running package version to successful status views

## v1.6.0 — 2026-08-14

- Lead `agent-workflows status` with the account's **quota headroom** — the share of its
  rolling session and weekly limits still unconsumed — as one line above the spec tree. The
  tracker structurally cannot answer this: every verb runs the `claude` CLI under a
  subscription token rather than a metered API key, so the fleet drains the same windows
  interactive work does, and it drains them without moving a label, closing an issue or
  changing a row. "Five specs in flight" and "39% of the week gone" are only worth anything
  together. Read from `claude --strict-mcp-config --print --output-format json "/usage"`,
  which makes no model call — so looking at headroom never consumes it — and needs no
  persistence, which is what keeps the rule that state is derived and never written locally
  intact. MCP servers are disabled for the call because loading a consumer's plugins to ask
  the local account about its own rate limits cost 2 seconds of startup for byte-identical
  output. Rendered as a line rather than a column, since the figure is account-global and
  belongs to no row; each window is dimmed, yellow or bold red past 60% and 85%, matching
  what those colours already mean in the tree. The line states each window in the complement
  of the concept — `week 39% used` — because that is the direction the source reports and
  the direction the colours ramp, and the word `used` is never dropped: a bare `39%` under a
  line labelled quota reads either way round. Adds `--no-headroom`, which exists less for
  the ~1.5s than for the case it cannot detect: the read is of whichever account is
  authenticated *locally*, so in a repo whose CI runs on a different subscription the number
  is true and tells you nothing about the fleet on screen. Every failure — no `claude` on
  the PATH, unauthenticated, an API key or Bedrock or Vertex, a timeout, or prose a future
  release has reworded — omits the line in silence and prints exactly what the view printed
  before, so CI and consumers who never authenticate the CLI are unaffected. A partial parse
  is refused as hard as a failed one, because a session bar with no weekly bar reads as "the
  week is fine". Under `--watch` a read is reused for 30s rather than taken every tick, and
  deliberately outside the `--watch` freshness gate: that gate spends the shared GitHub rate
  limit, while this number moves precisely when the tree does not. The last good line is
  carried across one failed window and no further, so a single timeout neither blanks the
  line nor leaves a stale percentage on screen all night. Amends ADR-0007, whose
  "reads GitHub and nothing else" rule this breaks — the stronger rule, that the view
  *writes* nothing, is untouched. `CONTEXT.md` gains **quota headroom**, held apart from
  **run ceiling**: a ceiling bounds one run, headroom bounds all work everywhere.
- Add `agent-workflows init` and `agent-workflows sync`, so setting a repo up no longer
  means transcribing five README steps by hand. `npx github:michaelloistl/agent-workflows#v1 init`
  runs before the package is a dependency and writes the thin callers, wires the
  `sandcastle:*` scripts, pins the git dependency, creates the trigger labels and installs;
  its last act is to add itself as a devDependency, so later updates are
  `yarn agent-workflows sync` and the installer always ships at the version of the
  workflows it installs. One planner serves both commands (the shape of ADR-0005): `init`
  is told what to enable (`--enable=`, over the five verbs plus the orchestrator), `sync`
  detects what a repo already has, and the two
  cannot drift about what an installed repo looks like. The consumer's hook scripts are
  **derived from this repo's own `package.json`** rather than a second table, so a hook
  added here reaches every consumer on their next `sync` — including the asymmetric ones a
  hand-written matrix gets wrong (`explore` has a `-sequence`, the PR verbs have a
  `-guards-sequence` instead, the orchestrator has neither).
  Both commands print the whole plan and change nothing until it is accepted; a
  non-interactive stdin declines and `--yes` pre-accepts, as the spec loop does.
  Three things they deliberately refuse to do: write secrets (reported, never set —
  `AGENT_PAT` cannot be minted outside the GitHub UI); regenerate a caller that already
  exists (`sync` moves the `uses:` ref and leaves the consumer's `with:` inputs and `if:`
  guard alone, reporting other drift); and run against a checkout of this repo, which is
  the package and never installs itself. `sync` also reports local overrides, the one
  thing that goes stale silently — a file under `.sandcastle/agent-workflows/` shadows the
  packaged entrypoint forever, so a prompt copied at v1.1 is still in use at v1.5 with
  nothing else to say so. `sync` **re-resolves** the git dependency (`yarn up
  agent-workflows`) rather than installing it: the default pin is a moving major tag, so a
  plain `yarn install` reuses the lockfile's resolution and the tag never moves — and the
  workflows install with `--frozen-lockfile`, so CI would keep running the commit the repo
  was installed at. It says to commit the updated lockfile, and states the one ordering it
  cannot escape: `sync` runs the copy in `node_modules`, so a hook added in the release it
  is moving to arrives on the run after. Defaults come from the repo: everything the
  package installs, the
  installer's own major version as the pin, `git config user.email` for the identity, a
  `Gemfile` for `enable-ruby`, and repo visibility for the `pull_request_target` author
  gate — so the common install takes no arguments at all. See ADR-0008; `CONTEXT.md` gains
  **installer** and **installable** (the thing `--enable` selects — the verbs plus the
  orchestrator, which is still not a sixth verb).

## v1.5.0 — 2026-08-14

- Move the packaged default agent model from `claude-opus-4-8` to `claude-opus-5`. This is
  the value every verb runs on when a consuming repo sets neither the `agent-model` input
  nor `agentModel` in `.sandcastle/agent-workflows/config.json`, so both of those overrides
  still win and a repo pinned to an older model is unaffected.
- License the project MIT. There was no `LICENSE` file and no `license` field, so default
  copyright applied and the repo was readable but not legally usable: nobody could adopt
  these workflows without permission, however public the code was. MIT matches
  `mattpocock/skills`, which `implement-spec` is built to interoperate with. Adds
  `LICENSE`, `"license": "MIT"` in `package.json`, and a License section in the README.
  `"private": true` stays, since consumers install this as a git dependency and it only
  guards against an accidental `npm publish`.
- Rewrite the README opening around what a run does, and correct the scope of the
  agnosticism claim. The old text said the central YAML knows nothing about your "tracker,
  stack, or domain". Tracker and domain are true and hook-backed (ADR-0001); the stack is
  not. Every verb installs Node unconditionally and brings Ruby, Postgres 16 and Redis up
  behind `enable-ruby`, with `bundle exec rails db:prepare`, `RAILS_ENV` and
  `RAILS_MASTER_KEY` written into the workflow itself. The claim is now scoped to tracker
  and domain, the Rails path is stated as the deliberate first-class one it is, and its
  limit is named: other stacks get Node only, so the agent can edit code it has no way to
  test. The opening also leads with the labelled-issue flow rather than the architecture,
  and `mattpocock/skills` compatibility reads as a feature rather than a constraint.
  Documentation only.
- Document that under `--watch` inside Herdr a URL opens with ⌘-Shift-click rather than
  ⌘-click. `--watch` draws on the alternate screen, which Herdr's own URL clicking does not
  reach; Shift suppresses mouse reporting so the click reaches the host terminal, which
  finds the URL as ordinary text. ⌘-click is enough for the one-shot view, on the normal
  screen. Documentation only — v1.4.0's URL column is what makes the host terminal able to
  find anything at all, and no change here can reach Herdr's alt-screen handling.

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
