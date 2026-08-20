// GitHub tracker adapter shared by the hook implementations. This is the GitHub
// counterpart to a Linear repo's Linear client: it is the ONE place all GitHub
// tracker I/O (label transitions, comments, refusals) lives, so the central
// reusable workflow can stay tracker-agnostic (ADR-0001, Decision 7) and a
// future Linear repo only swaps this module out behind the same hook contract.

import { capture } from "./process.mts";

// `issue` and `pr` are the `gh` subcommands; both accept `edit`/`comment` and
// take the shared issue/PR number space.
export type Kind = "issue" | "pr";

// The four states the `<verb>-status` hook reports. `in-progress`/`review`/
// `blocked` map to `agent:*` labels; `done` clears the in-progress label and
// leaves no state label (a clean success).
export type State = "in-progress" | "review" | "blocked" | "done";

// The `agent:in-progress` state label. Exported because it is also the mutex
// BETWEEN entry points (issue #56): an attended run refuses to start on an issue
// already carrying it, since another entry point (the unattended workflow) is
// mid-run there.
export const IN_PROGRESS_LABEL = "agent:in-progress";

const STATE_LABEL = {
  "in-progress": IN_PROGRESS_LABEL,
  review: "agent:review",
  blocked: "agent:blocked",
} as const;

function gh(args: ReadonlyArray<string>): string {
  return capture("gh", args);
}

// Label edits are best-effort: a missing label or a race on a re-run must never
// fail the surrounding step (the original YAML used `|| true` for the same reason).
function tryEdit(kind: Kind, number: string, flags: ReadonlyArray<string>): void {
  try {
    gh([kind, "edit", number, ...flags]);
  } catch {
    /* tolerate: label already absent / present, or a transient API hiccup */
  }
}

export function addLabel(kind: Kind, number: string, label: string): void {
  tryEdit(kind, number, ["--add-label", label]);
}

export function removeLabel(kind: Kind, number: string, label: string): void {
  tryEdit(kind, number, ["--remove-label", label]);
}

// The `owner/name` slug in a git remote URL, or null when the URL is not one this
// understands. Pure — the parsing half of `resolveRepoSlug`. Handles the three forms
// a GitHub remote takes: scp-style ssh (`git@host:owner/name.git`), an ssh:// URL,
// and https, with or without the `.git` suffix.
export function repoFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  if (!trimmed) return null;
  const scp = /^[^@]+@[^:]+:(?<slug>[^/]+\/[^/]+)$/.exec(trimmed);
  if (scp?.groups) return scp.groups.slug;
  const uri = /^(?:ssh|https?):\/\/(?:[^@/]+@)?[^/]+\/(?<slug>[^/]+\/[^/]+)$/.exec(trimmed);
  if (uri?.groups) return uri.groups.slug;
  return null;
}

// The `owner/name` the hooks read from `GH_REPO`. In CI the workflow supplies it
// (`github.repository`); an ATTENDED run has no workflow, so it is derived here from
// the checkout's own `origin` remote — otherwise every hook that calls
// `required("GH_REPO")` refuses, which reads downstream as an unexplained guard
// refusal. Local git first (instant, offline), then `gh` as the fallback for a
// remote shape the parser does not know. Empty when nothing resolves; the caller
// then leaves the variable unset rather than setting a blank one.
export function resolveRepoSlug(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GH_REPO) return env.GH_REPO;
  try {
    const slug = repoFromRemoteUrl(capture("git", ["remote", "get-url", "origin"]));
    if (slug) return slug;
  } catch {
    /* no origin remote, or not a git checkout */
  }
  try {
    return capture("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  } catch {
    return "";
  }
}

// The repository default branch as a bare branch NAME, or empty when the ref names
// no branch. Pure — the normalising half of `resolveDefaultBranch`. Both sources
// answer in a shape the base consumers cannot take as-is: git abbreviates the symref
// to a remote-tracking ref (`origin/main`), while `gh` answers with the bare name, and
// either can degrade to `HEAD` (a detached or unset symref), which names no branch —
// passed on it would make `create-branch` cut from `origin/HEAD`. Empty is the
// "nothing resolved" signal `resolveBaseBranch` already understands.
export function defaultBranchFromRef(ref: string): string {
  const name = ref.trim().replace(/^origin\//, "");
  return name === "HEAD" ? "" : name;
}

// The repository default branch the hooks read from `DEFAULT_BRANCH` — the lowest-
// precedence slot of `resolveBaseBranch` (BASE_BRANCH → the config file → this). In CI
// the reusable workflow supplies it (`github.event.repository.default_branch`); an
// ATTENDED run has no workflow, so it is derived here — otherwise a run with no
// configured base resolves BASE="" and `create-branch` cuts from `origin/`, which dies
// in git rather than saying what is missing. Local git first (instant, offline), then
// `gh` for the checkout whose `origin/HEAD` is unset or dangling — a remote added by
// hand rather than cloned, or a default branch renamed since. Empty when nothing
// resolves; the caller then leaves the variable unset rather than setting a blank one.
export function resolveDefaultBranch(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEFAULT_BRANCH) return env.DEFAULT_BRANCH;
  try {
    const name = defaultBranchFromRef(capture("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"]));
    if (name) return name;
  } catch {
    /* no origin/HEAD (never cloned, or the symref was never set), or not a git checkout */
  }
  try {
    return defaultBranchFromRef(
      capture("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]),
    );
  } catch {
    return "";
  }
}

// Create a label in the repo if it is not there yet. `gh issue edit --add-label`
// fails on a label the repo does not have, and label edits are best-effort (they
// swallow that failure), so a label the fleet applies itself — rather than one a
// human created by hand — has to be ensured before it is added. Tolerant: an
// already-existing label makes `gh label create` exit non-zero, which is the
// expected case, not an error.
// Quiet, because the EXPECTED path is failure: on the second and every later run the
// label exists and `gh` writes "label with name … already exists" to stderr, which
// would otherwise print on every run of a loop that is behaving perfectly. Silencing
// it costs no diagnosis here — the caller that needs the label to exist (the spec
// loop's marker claim) verifies it afterwards and halts with its own message.
export function ensureLabel(name: string, description: string): void {
  try {
    capture("gh", ["label", "create", name, "--description", description], { quiet: true });
  } catch {
    /* already exists (the common case), or the token cannot create labels */
  }
}

export function comment(kind: Kind, number: string, body: string): void {
  gh([kind, "comment", number, "--body", body]);
}

export function commentFile(kind: Kind, number: string, file: string): void {
  gh([kind, "comment", number, "--body-file", file]);
}

// Apply a state transition. Idempotent about clearing in-progress so any terminal
// path (review/done/blocked) leaves the tracker clean — the contract guarantee
// that a run never gets stuck `agent:in-progress`.
export interface StateOptions {
  // Trigger label to clear when moving to `in-progress` (e.g. `agent:explore`).
  readonly triggerLabel?: string;
  // Optional reason posted with a `blocked` comment.
  readonly reason?: string;
  // Run URL appended to a `blocked` comment.
  readonly runUrl?: string;
}

export function setState(
  kind: Kind,
  number: string,
  state: State,
  opts: StateOptions = {},
): void {
  switch (state) {
    case "in-progress":
      // Clear any stale blocked from a prior run, retire the trigger label.
      removeLabel(kind, number, STATE_LABEL.blocked);
      if (opts.triggerLabel) removeLabel(kind, number, opts.triggerLabel);
      addLabel(kind, number, STATE_LABEL["in-progress"]);
      return;
    case "review":
      removeLabel(kind, number, STATE_LABEL["in-progress"]);
      addLabel(kind, number, STATE_LABEL.review);
      return;
    case "done":
      // Clean success: clear in-progress, leave no state label.
      removeLabel(kind, number, STATE_LABEL["in-progress"]);
      return;
    case "blocked": {
      removeLabel(kind, number, STATE_LABEL["in-progress"]);
      addLabel(kind, number, STATE_LABEL.blocked);
      const reason =
        opts.reason ?? "Agent run could not finish (no commits or an error).";
      const tail = opts.runUrl ? `\n\nSee the run: ${opts.runUrl}` : "";
      comment(kind, number, `${reason}${tail}`);
      return;
    }
  }
}

// Wiring shared by every `<verb>-status` hook: read the state (and optional
// reason) from argv, the run URL from the environment, and apply the transition.
export function runStatus(args: {
  kind: Kind;
  number: string;
  triggerLabel: string;
}): void {
  const state = process.argv[2] as State | undefined;
  const reason = process.argv[3];
  if (
    state !== "in-progress" &&
    state !== "review" &&
    state !== "blocked" &&
    state !== "done"
  ) {
    console.error(`Unknown status state: ${JSON.stringify(state)}`);
    process.exit(1);
  }
  setState(args.kind, args.number, state, {
    triggerLabel: args.triggerLabel,
    reason,
    runUrl: process.env.RUN_URL,
  });
}

// Whether a guard refusal should be ANNOUNCED on the tracker (retire the trigger
// label + comment why) or only surfaced to the terminal. The unattended workflow
// announces; an attended local run sets `ANNOUNCE_REFUSALS=false`, because there
// may be no trigger label to retire and a refusal comment on an issue the
// developer is watching is noise. Only the exact string `"false"` suppresses, so
// a mistyped value never silently swallows a tracker refusal. This is the sole
// addition to the hook contract in issue #56 (see docs/hook-contract.md).
export function announceRefusals(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANNOUNCE_REFUSALS !== "false";
}

// A guard refusal: retire the trigger label, post the explanation, and exit
// non-zero so the central workflow skips the rest (NOT a failure — never
// `agent:blocked`). The hook owns its own feedback; the YAML only reads the exit.
// When announcement is suppressed (an attended run), the reason prints to the
// terminal and nothing is written to the tracker.
export function refuse(
  kind: Kind,
  number: string,
  triggerLabel: string,
  message: string,
): never {
  if (announceRefusals()) {
    removeLabel(kind, number, triggerLabel);
    comment(kind, number, message);
  } else {
    console.error(message);
  }
  process.exit(1);
}
