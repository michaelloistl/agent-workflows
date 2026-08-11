// The append-only run log for the attended spec loop (issue #62). A spec that halts
// at 2am currently leaves nothing to read in the morning — the end-of-run summary is
// terminal output that scrolls away. This writes each transition the loop makes to an
// append-only file under the worktree ROOT (not inside the per-spec worktree, which
// is removed when the final PR opens), so the record survives a halt AND a completed
// run's cleanup, and stays discoverable from the summary.
//
// The load-bearing distinction: this file is WRITTEN, never CONSULTED. Nothing reads
// it to decide what happens next — resume still derives entirely from the tracker and
// the branches. It is pure observability, so it does NOT reintroduce local state.
//
// Kept pure where it matters: the path and the line are unit-testable functions; only
// `appendRunLine` touches disk, and it swallows every error — a failed log write is an
// observability loss, never a reason to fail a run that is otherwise fine.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

// One transition the loop made. `slice` is null for spec-level transitions (worktree
// setup, the spec-branch cut, the final PR) and the tracer-bullet number otherwise.
export interface RunLogEntry {
  readonly timestamp: string; // ISO 8601 — supplied by the caller so the line is testable
  readonly slice: number | null;
  readonly action: string; // what the loop did: build, merge, resume-gate, checkpoint, halt, complete…
  readonly outcome: string; // how it ended: merged, built, paused, halted: <reason>…
}

// Where the run log lives: under the worktree ROOT, keyed by spec, so it outlives the
// per-spec worktree (removed on completion) and two specs never share a file.
export function runLogPath(root: string, spec: number): string {
  return join(root, `spec-${spec}-run.log`);
}

// One tab-separated line: timestamp, slice (`#4` or `spec`), action, outcome. Tabs
// keep it greppable and column-splittable without a parser — it is read by a human,
// never by code.
export function formatRunLogLine(e: RunLogEntry): string {
  const slice = e.slice === null ? "spec" : `#${e.slice}`;
  return `${e.timestamp}\t${slice}\t${e.action}\t${e.outcome}`;
}

// Append one transition to the log. Best-effort: a write failure (a read-only root, a
// vanished directory) is swallowed so logging can never fail the run — the log is
// observability, not correctness, and nothing downstream reads it.
export function appendRunLine(path: string, entry: RunLogEntry): void {
  try {
    appendFileSync(path, formatRunLogLine(entry) + "\n");
  } catch {
    /* best-effort: never fail a run because the run log could not be written */
  }
}
