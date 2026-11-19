import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  classifyExclusiveCreate, CONTENTION_ATTEMPTS, CONTENTION_PAUSE_MS, pauseSync, TRANSIENT_CREATE_CODES,
} from "../node/lock-contention.mts";

// The probe's lock files (issues #600, #602). A holder publishes an owner
// record into the lock through the descriptor of its exclusive create, before
// its action runs: {"version":1,"pid","token","at"} and a newline that marks
// the record complete. Operator decisions of 2026-10-22:
// (a) only a complete record whose PID process.kill(pid, 0) reports absent
//     (ESRCH) is reclaimed, through the sibling ".reclaim" gate, rereading the
//     exact bytes under it; an empty (older version), incomplete, malformed,
//     oversized or symlinked lock stays held whatever its age, and so does a
//     live or unverifiable owner;
// (b) a failed release reports storage_error and is kept as pending: this
//     process creates no new probe lock until it has retried that release. What
//     the action persisted stays; it is never rolled back or rerun.
// EPERM, EACCES and EBUSY on the create mean "still held" (Windows delete
// pending, lock-contention.mts). Every open of one call, reclaim gates
// included, draws on one allowance of LOCK_ATTEMPTS opens. An open that finds
// the complete record of a live owner in another process is given back to the
// allowance for LIVE_OWNER_WAIT_MS from the start of the call (issue #982): that
// owner is working, and how long it holds is no measure of this call's opens.

export const LOCK_HELD_CODES: ReadonlySet<string> = new Set(["EEXIST", ...TRANSIENT_CREATE_CODES]);
export const LOCK_ATTEMPTS = CONTENTION_ATTEMPTS;
// One hook run makes one lock call and must end below its timeout of 10 s
// (README, hook configuration): this wait (5 s) + the allowance tail (50 opens
// x 4 ms, about 0.8 s at a 15.6 ms timer) + Node startup + the action (ms) < 10 s.
export const LIVE_OWNER_WAIT_MS = 5_000;
export const RECLAIM_DEPTH = 4;
export const OWNER_MAX_BYTES = 256;
const OWNER_KEYS = "version,pid,token,at";
const TOKEN = /^[0-9a-f]{32}$/;

interface ProbeOwner { version: 1; pid: number; token: string; at: string }
type OwnerRead = { kind: "missing" } | { kind: "unknown" } | { kind: "owner"; owner: ProbeOwner; bytes: string };
interface Budget { left: number; liveUntil: number }
interface PendingRelease { file: string; bytes: string }

// At most one per process: a failed release ends its call.
let pending: PendingRelease | null = null;

const code = (error: unknown): string => (error as NodeJS.ErrnoException | undefined)?.code ?? "";
const storageError = (cause: unknown): Error => new Error("storage_error", { cause });

export const probeLockFile = (stateDir: string, name: string): string => path.join(stateDir, "locks", `${name}.lock`);
// The lock file of the unresolved release, for tests; never its bytes or token.
export const pendingProbeRelease = (): string | null => pending?.file ?? null;

function parseOwner(text: string): ProbeOwner | null {
  if (text.indexOf("\n") !== text.length - 1) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if (Object.keys(owner).join(",") !== OWNER_KEYS || owner.version !== 1 || !Number.isSafeInteger(owner.pid)
    || (owner.pid as number) <= 0 || typeof owner.token !== "string" || !TOKEN.test(owner.token)
    || typeof owner.at !== "string") return null;
  return owner as unknown as ProbeOwner;
}

function readProbeOwner(file: string): OwnerRead {
  let fd: number;
  try {
    // lstat: a symbolic link is no regular file.
    if (!fs.lstatSync(file).isFile()) return { kind: "unknown" };
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return code(error) === "ENOENT" ? { kind: "missing" } : { kind: "unknown" };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: "unknown" };
    const buffer = Buffer.alloc(OWNER_MAX_BYTES + 1);
    let size = 0, bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, size, buffer.length - size, size);
      size += bytes;
    } while (bytes > 0 && size < buffer.length);
    if (size === 0 || size > OWNER_MAX_BYTES) return { kind: "unknown" };
    const text = buffer.subarray(0, size).toString("utf8");
    const owner = parseOwner(text);
    return owner ? { kind: "owner", owner, bytes: text } : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  } finally {
    try { fs.closeSync(fd); } catch { /* a read-only descriptor */ }
  }
}

// A reused but live PID counts as alive; only ESRCH proves absence.
function ownerState(owner: ProbeOwner): "alive" | "absent" | "unknown" {
  if (owner.pid === process.pid) return "alive";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    return code(error) === "ESRCH" ? "absent" : "unknown";
  }
}

function writeAll(handle: number, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  for (let offset = 0; offset < buffer.length;) offset += fs.writeSync(handle, buffer, offset, buffer.length - offset);
}

// Removes the lock only while it still holds this exact record.
function removeOwn(file: string, bytes: string): void {
  let cause: unknown = new Error("the lock owner cannot be verified");
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const read = readProbeOwner(file);
    if (read.kind === "missing" || (read.kind === "owner" && read.bytes !== bytes)) return;
    if (read.kind === "unknown") break;
    try {
      fs.unlinkSync(file);
      return;
    } catch (error) {
      if (code(error) === "ENOENT") return;
      cause = error;
      if (!TRANSIENT_CREATE_CODES.has(code(error))) break;
      pauseSync(CONTENTION_PAUSE_MS);
    }
  }
  pending = { file, bytes };
  throw storageError(cause);
}

// A descriptor is closed once, never again: after a failed close its number may
// already belong to another descriptor of this process. The release goes by
// path and bytes either way; a failed close is reported once, not kept pending.
function release(file: string, handle: number, bytes: string): void {
  let closeError: unknown;
  let closed = true;
  try { fs.closeSync(handle); } catch (error) { closed = false; closeError = error; }
  removeOwn(file, bytes);
  if (!closed) throw storageError(closeError);
}

function settlePendingRelease(): void {
  if (!pending) return;
  removeOwn(pending.file, pending.bytes);
  pending = null;
}

function hold<T>(file: string, handle: number, action: () => T): T {
  const bytes = `${JSON.stringify({ version: 1, pid: process.pid, token: crypto.randomBytes(16).toString("hex"),
    at: new Date().toISOString() })}\n`;
  try {
    writeAll(handle, bytes);
    fs.fsyncSync(handle);
  } catch (error) {
    // Ours by the exclusive create; left behind it would be an incomplete lock
    // that nothing reclaims.
    try { fs.closeSync(handle); } catch { /* the publication failed already */ }
    try { fs.unlinkSync(file); } catch { /* an incomplete lock: manual cleanup */ }
    throw storageError(error);
  }
  let result: T;
  try {
    result = action();
  } catch (error) {
    try { release(file, handle, bytes); } catch { /* kept as pending; the action's error wins */ }
    throw error;
  }
  release(file, handle, bytes);
  return result;
}

// "cleared": the held lock is gone now (released meanwhile, or a dead owner's
// record reclaimed), so the next open needs no pause. "live": a complete record
// of a live owner in another process; this process's own pid is never waited
// out on the clock, because nothing releases it while this call blocks.
function heldBy(file: string, depth: number, budget: Budget): "cleared" | "live" | "held" {
  const read = readProbeOwner(file);
  if (read.kind === "missing") return "cleared";
  if (read.kind === "unknown") return "held";
  const state = ownerState(read.owner);
  if (state === "absent") return reclaim(file, read.bytes, depth, budget) === "removed" ? "cleared" : "held";
  return state === "alive" && read.owner.pid !== process.pid ? "live" : "held";
}

function acquire<T>(file: string, depth: number, budget: Budget, action: () => T): T {
  let held: unknown;
  while (budget.left > 0) {
    budget.left--;
    let handle: number;
    try {
      handle = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      const outcome = classifyExclusiveCreate(error);
      if (outcome === "other") throw error;
      held = error;
      const state = outcome === "exists" ? heldBy(file, depth, budget) : "held";
      if (state === "cleared") continue;
      if (state === "live" && performance.now() < budget.liveUntil) budget.left++;
      pauseSync(CONTENTION_PAUSE_MS);
      continue;
    }
    return hold(file, handle, action);
  }
  throw storageError(held);
}

// Serialised through the gate: the record is reread under it and removed only
// when it is byte-identical to the one observed and its owner still absent.
function reclaim(file: string, observed: string, depth: number, budget: Budget): "removed" | "kept" {
  if (depth + 1 > RECLAIM_DEPTH) throw storageError(new Error("reclaim depth exceeded"));
  return acquire(`${file}.reclaim`, depth + 1, budget, () => {
    const read = readProbeOwner(file);
    if (read.kind === "missing") return "removed";
    if (read.kind === "unknown" || read.bytes !== observed || ownerState(read.owner) !== "absent") return "kept";
    try {
      fs.unlinkSync(file);
      return "removed";
    } catch (error) {
      return code(error) === "ENOENT" ? "removed" : "kept";
    }
  });
}

export function withProbeLock<T>(stateDir: string, name: string, action: () => T): T {
  settlePendingRelease();
  const file = probeLockFile(stateDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return acquire(file, 0, { left: LOCK_ATTEMPTS, liveUntil: performance.now() + LIVE_OWNER_WAIT_MS }, action);
}
