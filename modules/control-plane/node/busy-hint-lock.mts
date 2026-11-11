import crypto from "node:crypto";
import fs from "node:fs";

import { classifyExclusiveCreate } from "./lock-contention.mts";

// The owner lock of a busy-hint ticket (issues #374, #602, #877). The lock is
// created with an exclusive open and then carries {version, pid, startedAt,
// token}; the holder runs its body only after reading its own token back.
// A create failing with EPERM, EACCES or EBUSY (Windows delete pending, #602) is
// busy at once, without waiting; other create errors are failed. An existing
// lock is busy unless it is provably stale:
//  - its record names a pid that kill(pid, 0) reports gone (ESRCH);
//  - its record names this pid, but this process holds no such lock: this
//    process leaked it, or the recorded owner died and its pid was reused here;
//  - it is empty and its mtime lies more than EMPTY_LOCK_STALE_MS in the past
//    on the wall clock (a holder died between create and record write).
// Any other content, a read error, a future mtime or a pid reused by another
// live process stays busy (fail closed). A stale lock is taken only under the
// `<lock>.reclaim.lock` gate (same routine, at most GATE_DEPTH gates deep),
// after reading it again, by renaming it to a tombstone and comparing bytes and
// file identity with what was judged (listener-sweep.mts takeIfUnchanged).
// A mismatch is put back by link, never over a newer lock. Release compares
// the token before unlinking; a failed unlink is failed and leaves a lock that
// names this process, which the next call (or any call after its exit) recovers.

export const EMPTY_LOCK_STALE_MS = 60_000;
export const GATE_SUFFIX = ".reclaim.lock";
const GATE_DEPTH = 2;
const MAX_LOCK_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
// Lock paths this process holds; a re-entrant acquire is busy.
const holding = new Set<string>();

export type BusyHintLockClass = "live" | "dead-owner" | "empty-old" | "unverifiable";
export interface BusyHintLockDeps { clock?: () => number }
type Alive = (pid: number) => boolean;
interface Seen { raw: Buffer; stamp: string; size: bigint; mtimeMs: number }

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

// Gone only on ESRCH; EPERM and every other answer count as alive (process-start.mts).
const alive: Alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) !== "ESRCH";
  }
};

function ownerOf(raw: string): { pid: number; startedAt: number; token: string } | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4
      || value.version !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
      || !Number.isSafeInteger(value.startedAt) || typeof value.token !== "string" || !UUID.test(value.token)) return null;
    return { pid: value.pid as number, startedAt: value.startedAt as number, token: value.token };
  } catch {
    return null;
  }
}

// Bytes and identity of a lock from one open; null when absent. Other errors throw.
function readLock(file: string): Seen | null {
  let fd: number;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("lock is not a regular file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) throw new Error("lock is no lock record");
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    let size = 0, bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, size, buffer.length - size, size);
      size += bytes;
    } while (bytes > 0 && size < buffer.length);
    return { raw: buffer.subarray(0, size), stamp: `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`,
      size: stat.size, mtimeMs: Number(stat.mtimeNs / 1_000_000n) };
  } finally { fs.closeSync(fd); }
}

function judge(lock: string, seen: Seen, now: number, isAlive: Alive): BusyHintLockClass {
  if (seen.raw.length === 0) {
    if (seen.size !== 0n) return "unverifiable";
    const age = now - seen.mtimeMs;
    if (age > EMPTY_LOCK_STALE_MS) return "empty-old";
    return age >= 0 ? "live" : "unverifiable"; // a future mtime stays busy
  }
  const owner = ownerOf(seen.raw.toString("utf8"));
  if (!owner) return "unverifiable";
  if (owner.pid === process.pid) return holding.has(lock) && owner.startedAt === STARTED_AT ? "live" : "dead-owner";
  return isAlive(owner.pid) ? "live" : "dead-owner";
}

const stale = (state: BusyHintLockClass): boolean => state === "dead-owner" || state === "empty-old";

// For doctor: the class of one lock file, counts only.
export function classifyBusyHintLock(file: string, now: number, isAlive: (pid: unknown) => boolean): BusyHintLockClass {
  try {
    const seen = readLock(file);
    return seen ? judge(file, seen, now, isAlive) : "unverifiable";
  } catch {
    return "unverifiable";
  }
}

// Exclusive create plus record; the token when this process owns the lock.
function create(lock: string): string | "exists" | "busy" | "failed" {
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); } catch (error) {
    const outcome = classifyExclusiveCreate(error);
    return outcome === "exists" ? "exists" : outcome === "retry" ? "busy" : "failed";
  }
  const token = crypto.randomUUID();
  try {
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, startedAt: STARTED_AT, token })); }
    finally { fs.closeSync(fd); }
  } catch { return "failed"; }
  // readFileSync with an encoding does not go through fs.openSync.
  try { if (ownerOf(fs.readFileSync(lock, "utf8"))?.token !== token) return "busy"; } catch { return "busy"; }
  holding.add(lock);
  return token;
}

function restore(tomb: string, lock: string): void {
  try {
    fs.linkSync(tomb, lock);
    fs.rmSync(tomb, { force: true });
  } catch { /* a newer lock holds the path: the tombstone stays */ }
}

// Renames the lock aside and removes it only if it is still the file judged.
function takeIfUnchanged(lock: string, seen: Seen): boolean {
  const tomb = `${lock}.${crypto.randomUUID()}.tomb`;
  try { fs.renameSync(lock, tomb); } catch (error) {
    if (code(error) === "ENOENT") return true;
    throw error;
  }
  let same = false;
  try {
    const taken = readLock(tomb);
    same = !!taken && taken.stamp === seen.stamp && taken.raw.equals(seen.raw);
  } finally {
    if (same) {
      try { fs.rmSync(tomb, { force: true }); } catch { /* the path is free; the tombstone stays */ }
    } else restore(tomb, lock);
  }
  return same;
}

// True when the lock path is free for one more create.
function reclaim(lock: string, deps: BusyHintLockDeps, depth: number): boolean {
  const clock = deps.clock ?? Date.now;
  let first: Seen | null;
  try { first = readLock(lock); } catch { return false; }
  if (!first) return true;
  if (!stale(judge(lock, first, clock(), alive))) return false;
  const gate = lock + GATE_SUFFIX;
  const token = acquire(gate, deps, depth + 1);
  if (token === "busy" || token === "failed") return false;
  try {
    const again = readLock(lock);
    if (!again) return true;
    if (again.stamp !== first.stamp || !again.raw.equals(first.raw) || !stale(judge(lock, again, clock(), alive))) return false;
    return takeIfUnchanged(lock, again);
  } catch {
    return false;
  } finally { release(gate, token); }
}

function acquire(lock: string, deps: BusyHintLockDeps, depth: number): string | "busy" | "failed" {
  if (holding.has(lock)) return "busy";
  const created = create(lock);
  if (created !== "exists") return created;
  if (depth >= GATE_DEPTH || !reclaim(lock, deps, depth)) return "busy";
  const again = create(lock);
  return again === "exists" ? "busy" : again;
}

function release(lock: string, token: string): boolean {
  holding.delete(lock);
  try {
    if (ownerOf(fs.readFileSync(lock, "utf8"))?.token !== token) return false;
    fs.unlinkSync(lock);
    return true;
  } catch (error) {
    return code(error) === "ENOENT";
  }
}

export function withBusyHintLock<T>(lock: string, body: () => T, deps: BusyHintLockDeps = {}): T | "busy" | "failed" {
  const token = acquire(lock, deps, 0);
  if (token === "busy" || token === "failed") return token;
  let result: T | "failed";
  try { result = body(); } catch { result = "failed"; }
  return release(lock, token) ? result : "failed";
}
