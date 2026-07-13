// CI check-run aggregation for the `implement-finalize` merge gate (issue #44,
// fix 1). Under a spec a tracer-bullet merges straight into the spec branch with
// no per-slice human review (ADR-0004), so gating that merge on the PR's own green
// CI is the only automated stop keeping a red slice from landing and cascading
// onto the next tracer-bullet. These are the pure decisions behind that gate; the
// polling loop and all `gh` I/O live in the finalize entrypoint.

// gh's `bucket` field: the coarse state of one check-run (`gh pr checks --json`).
export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface CheckRun {
  readonly name?: string;
  readonly state?: string;
  readonly bucket: CheckBucket;
}

// The aggregate verdict over a PR's whole check-run set.
//   fail    — at least one check failed or was cancelled (a hard stop).
//   pending — nothing failed, but at least one check is still running.
//   pass    — every check reached a terminal, non-failing state.
//   none    — no checks are reported at all (not yet registered, or the base
//             simply has no PR CI); the caller resolves this via a grace period.
export type CheckVerdict = "pass" | "fail" | "pending" | "none";

export function checkVerdict(runs: ReadonlyArray<CheckRun>): CheckVerdict {
  if (runs.length === 0) return "none";
  if (runs.some((r) => r.bucket === "fail" || r.bucket === "cancel")) return "fail";
  if (runs.some((r) => r.bucket === "pending")) return "pending";
  return "pass";
}

// Parse the JSON `gh pr checks --json …` prints. Tolerant by design: `gh` exits
// non-zero (and may print nothing) when checks are failing, pending, or absent, so
// a blank, non-array, or unparseable payload collapses to "no runs" → verdict
// "none" rather than throwing.
export function parseChecks(json: string): CheckRun[] {
  const text = json.trim();
  if (!text) return [];
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? (data as CheckRun[]) : [];
  } catch {
    return [];
  }
}

export type PollAction = "merge" | "abort" | "wait";

export interface PollPolicy {
  // Overall cap. Checks still pending past this abort rather than merge blind.
  readonly timeoutMs: number;
  // How long "none" (no checks reported) is tolerated before treating the PR as
  // having no CI to wait on and merging. Covers both the brief window before CI
  // registers its checks and a base branch with no PR checks configured at all.
  readonly graceMs: number;
}

// Map (latest verdict, elapsed polling time) to the next action. `wait` means poll
// again after the interval; `merge` and `abort` are terminal.
export function pollAction(
  verdict: CheckVerdict,
  elapsedMs: number,
  policy: PollPolicy,
): PollAction {
  switch (verdict) {
    case "fail":
      return "abort";
    case "pass":
      return "merge";
    case "none":
      return elapsedMs >= policy.graceMs ? "merge" : "wait";
    case "pending":
      return elapsedMs >= policy.timeoutMs ? "abort" : "wait";
  }
}
