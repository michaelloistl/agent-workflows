// The sequence state file: what a finished sequence reports back to the entry point
// that launched it. PURE — render and parse only; the bridge (run.mts) writes the
// file and the attended entry points read it, so this module owning the format is
// what stops writer and reader from drifting.
//
// WHY A FILE AND NOT AN EXIT CODE. A guard refusal deliberately exits 0: in CI a
// refusal must leave the workflow green and never report `blocked` (see run.mts).
// That is the right contract for the unattended path and it cannot change — but it
// leaves an attended caller unable to tell "refused, built nothing" from "ran and
// succeeded". The spec loop got this wrong in the most confusing way available: a
// refused slice built nothing, so no PR was ever merged, and the loop reported "the
// merge was not confirmed on GitHub" — three steps downstream of the actual cause
// (a missing GH_REPO). The outcome travels beside the exit code instead.
//
// The format is the same `key=value` line shape fetch-spec's `$GITHUB_OUTPUT` uses,
// so the parse is the one already familiar in this codebase.

// How a sequence ended, as the executor classifies it (executor.mts `Outcome`).
export type SequenceOutcome = "succeeded" | "refused" | "failed";

const OUTCOMES: readonly string[] = ["succeeded", "refused", "failed"];

// What a sequence reports back. Every field is optional: an older writer, a sequence
// that stopped before fetch-spec resolved a branch, or a caller that only wants one
// of them all produce a partial file, and a reader must cope with each.
export interface SequenceState {
  readonly outcome?: SequenceOutcome;
  // The step that refused or failed, for a message that names the actual cause.
  readonly step?: string;
  // The branch/base the sequence resolved (fetch-spec's outputs), which the attended
  // `ask` path threads into its confirmed finalize slice (issue #57).
  readonly branch?: string;
  readonly base?: string;
}

// Render the state as `key=value` lines. An absent field is OMITTED rather than
// written blank, so a reader can distinguish "not reported" from "reported empty".
export function renderSequenceState(state: SequenceState): string {
  const lines: string[] = [];
  if (state.outcome !== undefined) lines.push(`outcome=${state.outcome}`);
  if (state.step !== undefined) lines.push(`step=${state.step}`);
  if (state.branch !== undefined) lines.push(`branch=${state.branch}`);
  if (state.base !== undefined) lines.push(`base=${state.base}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

// Parse the file. Tolerant in both directions: unknown keys are ignored (an older
// reader against a newer writer) and a file with no outcome parses fine (a newer
// reader against the branch/base-only file issue #57 wrote). An outcome value that
// is not one the executor produces is DROPPED rather than passed through — the loop
// halts on "refused", so a garbled value must never be mistaken for one.
export function parseSequenceState(text: string): SequenceState {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const state: {
    outcome?: SequenceOutcome;
    step?: string;
    branch?: string;
    base?: string;
  } = {};
  if (fields.outcome !== undefined && OUTCOMES.includes(fields.outcome)) {
    state.outcome = fields.outcome as SequenceOutcome;
  }
  if (fields.step !== undefined) state.step = fields.step;
  if (fields.branch !== undefined) state.branch = fields.branch;
  if (fields.base !== undefined) state.base = fields.base;
  return state;
}
