// GitHub tracker adapter shared by the hook implementations. This is the GitHub
// counterpart to on-vantage's Linear client: it is the ONE place all GitHub
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

const STATE_LABEL = {
  "in-progress": "agent:in-progress",
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

// A guard refusal: retire the trigger label, post the explanation, and exit
// non-zero so the central workflow skips the rest (NOT a failure — never
// `agent:blocked`). The hook owns its own feedback; the YAML only reads the exit.
export function refuse(
  kind: Kind,
  number: string,
  triggerLabel: string,
  message: string,
): never {
  removeLabel(kind, number, triggerLabel);
  comment(kind, number, message);
  process.exit(1);
}
