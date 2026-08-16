import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface LockOwner {
  pid: number;
  hostname: string;
  nonce: string;
  createdAt: string;
}

export interface ExclusiveFileLockOptions {
  /** Test/diagnostic override. Production uses the bounded default. */
  timeoutMs?: number;
  /** Internal safety valve for the recovery-election lock itself. */
  recoverDeadOwner?: boolean;
}

export interface ExclusiveFileLockLease {
  path: string;
  nonce: string;
}

/**
 * Run one synchronous action while holding an adjacent cooperative lock.
 *
 * A fully-written candidate is hard-linked into the fixed lock path. `link`
 * is an atomic no-replace operation, so contenders can never replace even an
 * empty-looking live lock. Recovery is deliberately conservative: only a
 * well-formed same-host owner whose PID is definitely dead can be reclaimed.
 * Malformed and foreign-host locks require inspection instead of guessing.
 */
export function withExclusiveFileLock<T>(
  lockPath: string,
  options: ExclusiveFileLockOptions,
  action: (lease: ExclusiveFileLockLease) => T,
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const owner: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const candidatePath = `${lockPath}.candidate-${owner.nonce}`;
  writeLockCandidate(candidatePath, owner);

  let acquired = false;
  try {
    while (true) {
      try {
        // Unlike rename, link never replaces an existing destination. The
        // published lock therefore always has a complete owner record.
        linkSync(candidatePath, lockPath);
        acquired = true;
        break;
      } catch (err) {
        if (!hasErrorCode(err, "EEXIST")) throw err;
        if (options.recoverDeadOwner !== false && tryReclaimDeadLocalOwner(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new LockBusyError(`resource is busy: timed out waiting for ${lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
  } finally {
    rmSync(candidatePath, { force: true });
  }

  if (!acquired) throw new Error(`could not acquire lock ${lockPath}`);
  const lease = { path: lockPath, nonce: owner.nonce };
  try {
    return action(lease);
  } finally {
    releaseLock(lease);
  }
}

/** Fence a commit against accidental/manual replacement of the held lock. */
export function assertExclusiveFileLock(lease: ExclusiveFileLockLease): void {
  const owner = readLockOwner(lease.path);
  if (!owner || owner.nonce !== lease.nonce) {
    throw new Error(`lost exclusive lock before commit: ${lease.path}`);
  }
}

function writeLockCandidate(path: string, owner: LockOwner): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
  } finally {
    if (fd !== null) closeSync(fd);
    // Keep a complete candidate for acquisition, but never retain a partial
    // one after a write/flush error.
    if (fd !== null) rmSync(path, { force: true });
  }
}

function tryReclaimDeadLocalOwner(lockPath: string): boolean {
  const observed = readLockOwner(lockPath);
  if (!observed || observed.hostname !== hostname() || processIsAlive(observed.pid)) return false;

  // Several waiters may observe the same dead owner. Elect exactly one
  // reclaimer, then re-read under that election before moving the lock. A
  // delayed waiter can therefore never act on its stale observation after a
  // successor has acquired the fixed path. Recovery of the election lock is
  // intentionally disabled: a reclaimer crash fails closed for inspection.
  try {
    return withExclusiveFileLock(
      `${lockPath}.reclaim`,
      { timeoutMs: 0, recoverDeadOwner: false },
      () => reclaimCurrentDeadLocalOwner(lockPath, observed.nonce),
    );
  } catch (err) {
    if (err instanceof LockBusyError) return false;
    throw err;
  }
}

function reclaimCurrentDeadLocalOwner(lockPath: string, observedNonce: string): boolean {
  const current = readLockOwner(lockPath);
  if (
    !current ||
    current.nonce !== observedNonce ||
    current.hostname !== hostname() ||
    processIsAlive(current.pid)
  ) {
    return false;
  }

  // The verified-dead owner cannot release or admit a successor before this
  // rename, and every cooperating reclaimer is serialized by `.reclaim`.
  const quarantine = `${lockPath}.dead-${current.nonce}-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantine);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return true;
    return false;
  }
  const moved = readLockOwner(quarantine);
  if (!moved || moved.nonce !== current.nonce) {
    throw new Error(`lock changed during dead-owner recovery: ${quarantine}`);
  }
  rmSync(quarantine, { force: true });
  return true;
}

class LockBusyError extends Error {}

function releaseLock(lease: ExclusiveFileLockLease): void {
  const owner = readLockOwner(lease.path);
  if (!owner || owner.nonce !== lease.nonce) return;
  const quarantine = `${lease.path}.release-${lease.nonce}`;
  try {
    renameSync(lease.path, quarantine);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return;
    throw err;
  }
  const moved = readLockOwner(quarantine);
  if (!moved || moved.nonce !== lease.nonce) {
    throw new Error(`lock ownership changed during release: ${quarantine}`);
  }
  rmSync(quarantine, { force: true });
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      typeof raw.hostname !== "string" ||
      raw.hostname.trim().length === 0 ||
      raw.hostname.length > 255 ||
      raw.hostname !== raw.hostname.trim() ||
      typeof raw.nonce !== "string" ||
      !UUID_PATTERN.test(raw.nonce) ||
      typeof raw.createdAt !== "string" ||
      !isCanonicalIsoDate(raw.createdAt)
    ) {
      return null;
    }
    return raw as LockOwner;
  } catch {
    return null;
  }
}

function isCanonicalIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !hasErrorCode(err, "ESRCH");
  }
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, ms);
}

function hasErrorCode(err: unknown, code: string): boolean {
  return !!err && typeof err === "object" && "code" in err && err.code === code;
}
