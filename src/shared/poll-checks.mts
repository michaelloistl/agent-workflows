// The polling loop shared by the two CI gates (issue #44): `implement-finalize`
// (fix 1) and `implement-spec-advance` (fix 2). The pure verdict/action decisions
// live in `checks.mts`; this owns the timing (interval, overall timeout, no-checks
// grace period). Each caller owns its own `gh` I/O and passes a `fetch` thunk that
// returns the current bucketed runs — `gh pr checks` for a PR, `gh api …/check-runs`
// for a branch tip. Poll rather than `gh pr merge --auto`, which would force
// branch-protection + required-checks config onto every consuming repo; the
// workflow must not demand that infrastructure.
import { checkVerdict, pollAction, type CheckRun, type PollPolicy } from "./checks.mts";

// Poll `fetch`'s check set until it resolves to a go/no-go. Resolves `true` when
// checks pass — or none are reported past the grace window — so the gated action
// may proceed; `false` when a check failed or stayed pending past the timeout, so
// the caller must halt. Interval, timeout, and grace are env-overridable (seconds)
// so a consumer can tune them to its CI without editing the package.
export async function awaitChecks(fetch: () => CheckRun[]): Promise<boolean> {
  const policy: PollPolicy = {
    timeoutMs: envSeconds("CHECKS_TIMEOUT_SECONDS", 1200) * 1000,
    // Generous by default: neither `gh pr checks` nor the REST API can tell "no CI
    // on this ref" from "CI not registered yet", so the grace window is the only
    // thing stopping a proceed before a slow-to-queue check even appears. Long
    // enough that a registered check reliably shows up first; env-overridable for
    // repos with no CI that want to proceed sooner.
    graceMs: envSeconds("CHECKS_GRACE_SECONDS", 180) * 1000,
  };
  const intervalMs = envSeconds("CHECKS_INTERVAL_SECONDS", 15) * 1000;
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

function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
