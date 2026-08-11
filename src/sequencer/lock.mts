// Attended-run local lock (issue #56). The SECOND concurrency mutex: while the
// `agent:in-progress` label is the mutex BETWEEN entry points (attended vs the
// unattended workflow), this lock is the mutex between two LOCAL terminals. The
// label cannot cover that case — two terminals started together would each only
// ever observe their own not-yet-written label — so a lock under the shared
// worktree root arbitrates instead.
//
// The lock is a DIRECTORY, acquired by a single `mkdirSync` — atomic on the
// filesystem, so two terminals racing to create the same lock cannot both win.
// A check-then-create would be racy; a directory create is not. The owner's pid
// is written inside, so a lock left by a killed process is detectable (its owner
// is no longer alive) and clearable rather than wedging the key forever.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockResult {
  // Whether this call now holds the lock.
  readonly acquired: boolean;
  // The pid recorded in a lock we could not take (a live holder), when known.
  readonly heldBy?: number;
  // Whether a stale lock (dead or pid-less owner) was cleared to acquire this one.
  readonly clearedStale?: boolean;
}

export interface AcquireOptions {
  // Overrule a live holder: clear the existing lock and take it. The single force
  // flag a developer uses to break a mutex they know is safe to break.
  readonly force?: boolean;
  // Liveness probe for the recorded owner pid — injected in tests.
  readonly isAlive?: (pid: number) => boolean;
}

// Where a run's lock directory lives: under the shared root, one per run key
// (`<verb>-<issue>`), so two different keys (two specs) never collide and a
// retained lock is self-identifying. Pure — a string derivation, no I/O.
export function lockPath(root: string, key: string): string {
  return join(root, `${key}.lock`);
}

// Is a process with this pid still alive? Signal 0 performs the permission/exis-
// tence check without actually delivering a signal. EPERM means the process
// exists but is not ours to signal — still alive; ESRCH means it is gone.
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = process.kill.bind(process),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The pid recorded in a lock (the running owner), or null when absent/unreadable.
// Exported so a second terminal's graceful-stop command can find the live loop to
// signal it (issue #60) — the lock already records the owner pid for staleness.
export function readLockOwner(dir: string): number | null {
  return readOwner(dir);
}

// The pid recorded in a lock directory, or null when absent or unreadable (a
// half-written lock counts as pid-less, hence stale).
function readOwner(dir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Create the lock directory atomically and stamp it with the owner pid. Returns
// false when the directory already exists (someone else holds it) — never
// overwrites, so the create IS the mutex.
function create(dir: string, pid: number): boolean {
  try {
    mkdirSync(dir); // atomic: throws EEXIST if the directory already exists.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  writeFileSync(join(dir, "pid"), String(pid));
  return true;
}

// Acquire the lock for `pid`. A free lock is taken outright. A held lock is taken
// only when its owner is stale (dead, or no readable pid) or when `force` is set —
// in either case the old lock is cleared and re-created. A lock held by a live
// process without force is refused, reporting the holder's pid.
export function acquireLock(dir: string, pid: number, opts: AcquireOptions = {}): LockResult {
  const isAlive = opts.isAlive ?? isProcessAlive;
  if (create(dir, pid)) return { acquired: true };

  const owner = readOwner(dir);
  const stale = owner === null || !isAlive(owner);
  if (stale || opts.force) {
    releaseLock(dir);
    if (create(dir, pid)) return { acquired: true, clearedStale: stale };
  }
  return { acquired: false, heldBy: owner ?? undefined };
}

// Release the lock. Idempotent — an already-absent lock is fine — so the caller
// can release on success, failure, and abort alike without guarding each path.
export function releaseLock(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}
