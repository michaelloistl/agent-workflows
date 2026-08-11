// The polling loop shared by the two CI gates (issue #44): `implement-finalize`
// (fix 1) and `implement-spec-advance` (fix 2). The pure verdict/action decisions
// live in `checks.mts`; this owns the timing (interval, overall timeout, no-checks
// grace period). Each caller owns its own `gh` I/O and passes a `fetch` thunk that
// returns the current bucketed runs — `gh pr checks` for a PR, `gh api …/check-runs`
// for a branch tip. Poll rather than `gh pr merge --auto`, which would force
// branch-protection + required-checks config onto every consuming repo; the
// workflow must not demand that infrastructure.
import { checkVerdict, pollAction, type CheckRun, type PollPolicy } from "./checks.mts";
import { resolveConfig } from "./config.mts";

// Poll `fetch`'s check set until it resolves to a go/no-go. Resolves `true` when
// checks pass — or none are reported past the grace window — so the gated action
// may proceed; `false` when a check failed or stayed pending past the timeout, so
// the caller must halt. Interval, timeout, and grace are configurable through both
// the config file and the environment (seconds), env winning, so a consumer can
// tune them to its CI without editing the package (issue #53).
export async function awaitChecks(fetch: () => CheckRun[]): Promise<boolean> {
  const timings = resolveConfig().checks;
  const policy: PollPolicy = {
    timeoutMs: timings.timeoutSeconds * 1000,
    graceMs: timings.graceSeconds * 1000,
  };
  const intervalMs = timings.intervalSeconds * 1000;
  // Monotonic clock: elapsed time must not be perturbed by a wall-clock (NTP/DST)
  // jump across the poll window.
  const start = performance.now();
  for (;;) {
    const action = pollAction(
      checkVerdict(fetch()),
      performance.now() - start,
      policy,
    );
    if (action === "merge") return true;
    if (action === "abort") return false;
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
