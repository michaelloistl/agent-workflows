// CI check-run aggregation for the two CI gates that keep a red slice from
// cascading onto the next tracer-bullet (issue #44). Under a spec a tracer merges
// straight into the spec branch with no per-slice human review (ADR-0004), so:
//   fix 1 — `implement-finalize` gates the tracer-PR merge on that PR's own CI.
//   fix 2 — `implement-spec-advance` gates dispatching the next slice on the spec
//           branch tip's CI after the merge.
// These are the pure decisions behind both gates; the shared polling loop lives in
// `poll-checks.mts` and all `gh` I/O lives in the entrypoints.

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

// A raw check-run as returned by the REST API (`gh api …/commits/{ref}/check-runs`).
// Unlike `gh pr checks` — which pre-buckets — the REST endpoint reports GitHub's
// native (status, conclusion) pair, so fix 2 maps it to a bucket itself.
export interface RawCheckRun {
  readonly name?: string;
  readonly status?: string; // queued | in_progress | completed
  readonly conclusion?: string | null; // success | failure | skipped | … | null
}

// Collapse one REST check-run's (status, conclusion) into a bucket. Anything not
// yet `completed` is pending; a completed run is a pass only on `success`. Non-
// failing terminal outcomes (skipped/neutral/stale — the last is a superseded run)
// bucket as "skipping" so they don't block; every other completed conclusion
// (failure/timed_out/action_required, or a completed run with no conclusion) is a
// hard failure — a gate must never read "not success" as "safe to proceed".
export function bucketOfRun(run: RawCheckRun): CheckBucket {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "pass";
    case "skipped":
    case "neutral":
    case "stale":
      return "skipping";
    case "cancelled":
      return "cancel";
    default:
      return "fail";
  }
}

// Parse the JSON `gh api …/commits/{ref}/check-runs` prints (`{check_runs: […]}`)
// into the bucketed CheckRun[] that `checkVerdict` consumes. Tolerant by the same
// rule as `parseChecks`: a blank, non-object, or missing/`non-array` `check_runs`
// collapses to "no runs" → verdict "none" rather than throwing.
export function parseCommitCheckRuns(json: string): CheckRun[] {
  const text = json.trim();
  if (!text) return [];
  try {
    const data: unknown = JSON.parse(text);
    const runs = (data as { check_runs?: unknown }).check_runs;
    if (!Array.isArray(runs)) return [];
    return (runs as RawCheckRun[]).map((r) => ({
      name: r.name,
      state: r.status,
      bucket: bucketOfRun(r),
    }));
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
