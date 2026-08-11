import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, isProcessAlive, lockPath, releaseLock } from "./lock.mts";

// A private lock root per test so the on-disk cases can't collide between runs.
function tmpRoot(name: string): string {
  const root = join(tmpdir(), `agent-workflows-lock-${process.pid}-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

// The lock lives UNDER the configured root, one directory per run key, so two
// different keys (two specs) never collide and a lock is self-identifying.
test("lockPath derives a per-key directory under the root", () => {
  assert.equal(lockPath("/tmp/wt", "explore-55"), join("/tmp/wt", "explore-55.lock"));
});

test("lockPath is distinct per key so two specs get separate locks", () => {
  assert.notEqual(lockPath("/root", "explore-55"), lockPath("/root", "explore-56"));
});

// A fresh acquisition creates the lock directory atomically and records the pid.
test("acquireLock takes a free lock and records the pid", () => {
  const root = tmpRoot("free");
  const dir = lockPath(root, "explore-1");
  const result = acquireLock(dir, 4242);
  assert.equal(result.acquired, true);
  assert.ok(existsSync(dir));
  assert.equal(readFileSync(join(dir, "pid"), "utf8").trim(), "4242");
  rmSync(root, { recursive: true, force: true });
});

// A second terminal that finds the lock held by a LIVE process is refused — this
// is the mutex the `agent:in-progress` label cannot cover (both terminals would
// only ever observe their own label).
test("acquireLock refuses when the lock is held by a live process", () => {
  const root = tmpRoot("held");
  const dir = lockPath(root, "explore-1");
  const first = acquireLock(dir, 100, { isAlive: () => true });
  assert.equal(first.acquired, true);
  const second = acquireLock(dir, 200, { isAlive: () => true });
  assert.equal(second.acquired, false);
  assert.equal(second.heldBy, 100);
  rmSync(root, { recursive: true, force: true });
});

// A lock left by a KILLED process is stale: its owner is no longer alive, so it
// is cleared and re-taken rather than blocking forever.
test("acquireLock clears a stale lock left by a dead process", () => {
  const root = tmpRoot("stale");
  const dir = lockPath(root, "explore-1");
  acquireLock(dir, 999, { isAlive: () => false });
  const retry = acquireLock(dir, 1000, { isAlive: () => false });
  assert.equal(retry.acquired, true);
  assert.equal(retry.clearedStale, true);
  assert.equal(readFileSync(join(dir, "pid"), "utf8").trim(), "1000");
  rmSync(root, { recursive: true, force: true });
});

// A lock directory with no readable pid file is treated as stale (a half-written
// or hand-mangled lock must never wedge a terminal permanently).
test("acquireLock treats a lock with no pid as stale", () => {
  const root = tmpRoot("nopid");
  const dir = lockPath(root, "explore-1");
  mkdirSync(dir);
  const result = acquireLock(dir, 1, { isAlive: () => true });
  assert.equal(result.acquired, true);
  assert.equal(result.clearedStale, true);
  rmSync(root, { recursive: true, force: true });
});

// The force flag overrules a live holder: it clears the existing lock and takes
// it, so a single flag can break a mutex a developer knows is safe to break.
test("acquireLock with force takes a lock held by a live process", () => {
  const root = tmpRoot("force");
  const dir = lockPath(root, "explore-1");
  acquireLock(dir, 100, { isAlive: () => true });
  const forced = acquireLock(dir, 200, { isAlive: () => true, force: true });
  assert.equal(forced.acquired, true);
  assert.equal(readFileSync(join(dir, "pid"), "utf8").trim(), "200");
  rmSync(root, { recursive: true, force: true });
});

// Release removes the lock so the same run can be started again afterwards — the
// guarantee that the lock is freed on success, failure, and abort alike.
test("releaseLock frees the lock for a later run", () => {
  const root = tmpRoot("release");
  const dir = lockPath(root, "explore-1");
  acquireLock(dir, 1, { isAlive: () => true });
  releaseLock(dir);
  assert.ok(!existsSync(dir));
  const again = acquireLock(dir, 2, { isAlive: () => true });
  assert.equal(again.acquired, true);
  rmSync(root, { recursive: true, force: true });
});

test("releaseLock on an already-absent lock is a no-op", () => {
  const root = tmpRoot("release-absent");
  const dir = lockPath(root, "explore-1");
  assert.doesNotThrow(() => releaseLock(dir));
  rmSync(root, { recursive: true, force: true });
});

// The real pid predicate: this process is alive; a pid that has been recycled to
// nothing is not. (PID 1 always exists but may not be signalable — EPERM still
// means alive, so it is not used as the "dead" fixture here.)
test("isProcessAlive is true for this process and false for a freed pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(
    isProcessAlive(1, () => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }),
    false,
  );
});

// EPERM from the probe means the process exists but is not ours to signal — still
// alive, so its lock must NOT be treated as stale.
test("isProcessAlive treats EPERM as alive", () => {
  assert.equal(
    isProcessAlive(1, () => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }),
    true,
  );
});

// Acquisition is atomic: it is a single directory create, never a check followed
// by a create, so two terminals starting together cannot both win. The second
// create of the same directory fails rather than clobbering the first.
test("acquireLock is atomic — a second create of the same lock loses", () => {
  const root = tmpRoot("atomic");
  const dir = lockPath(root, "explore-1");
  assert.equal(acquireLock(dir, 1, { isAlive: () => true }).acquired, true);
  // Do not overwrite the pid: a naive check-then-create would; the atomic
  // create sees EEXIST and reports the lock held instead.
  assert.equal(acquireLock(dir, 2, { isAlive: () => true }).acquired, false);
  assert.equal(readFileSync(join(dir, "pid"), "utf8").trim(), "1");
  rmSync(root, { recursive: true, force: true });
});

// A second lock for a DIFFERENT key is unaffected — two different specs run at
// once, each holding its own lock under the shared root.
test("acquireLock allows two different keys to be held at once", () => {
  const root = tmpRoot("concurrent");
  const a = acquireLock(lockPath(root, "explore-55"), 1, { isAlive: () => true });
  const b = acquireLock(lockPath(root, "explore-56"), 2, { isAlive: () => true });
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, true);
  rmSync(root, { recursive: true, force: true });
});
