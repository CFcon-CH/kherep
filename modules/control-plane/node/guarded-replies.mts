import fs from "node:fs";
import path from "node:path";
import { isMessageId } from "../protocol-messages.mts";
import { isLoopAdmissionV1 } from "../protocol-loop-brake.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { getMessage, writeJsonAtomic } from "./inbox.mts";
import { LOCK_HELD_CODES, RECORD_LOCK_POLL_MS, RECORD_LOCK_WAIT_MS, recordLockFile } from "./inbox-record-lock.mts";

// Deny-only history for native MCP request IDs, not a send/status record or
// Worker admission. Never expire/evict a remembered denial into permission.
export const MAX_GUARDED_MCP_REPLIES = 4096;
const INDEX_LOCK = "00000000-0000-4000-8000-000000000000";
const directory = (paths: NodePaths): string => path.join(paths.mcp, "guarded-replies");
const fileOf = (paths: NodePaths, id: string): string => path.join(directory(paths), `${id}.json`);
const unavailable = (): Error => new Error("guarded-reply-provenance-unavailable");

function releaseCapacityLock(file: string, mine: fs.Stats): void {
  // Cleanup failure intentionally takes precedence over a body failure: never
  // displace another entry or turn unprovable ownership into permission.
  const current = fs.lstatSync(file);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== mine.dev
    || current.ino !== mine.ino || current.uid !== mine.uid) throw unavailable();
  fs.rmdirSync(file);
}

// This capacity transaction cannot tolerate the record lock's age takeover:
// a paused live writer would retain an unfenced count/check. Reuse its exact
// pathname so old file-lock writers and new directory owners cannot overlap.
function withCapacityLock<T>(dir: string, body: () => T): T {
  const file = recordLockFile(dir, INDEX_LOCK), deadline = performance.now() + RECORD_LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(file, { mode: 0o700 }); break; } catch (error) {
      if (!LOCK_HELD_CODES.has((error as NodeJS.ErrnoException).code ?? "") || performance.now() >= deadline) throw unavailable();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECORD_LOCK_POLL_MS);
    }
  }
  const mine = fs.lstatSync(file);
  if (!mine.isDirectory() || mine.isSymbolicLink()) throw unavailable();
  try { return body(); } finally {
    // Never displace or recursively remove another entry, even after failure.
    // A crash or unprovable ownership leaves a conservative fence for offline
    // operator maintenance with all writers stopped, not automatic cleanup.
    releaseCapacityLock(file, mine);
  }
}

export function wasGuardedMcpReply(paths: NodePaths, requestId: string): boolean {
  if (!isMessageId(requestId)) throw unavailable();
  const file = fileOf(paths, requestId);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw unavailable();
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64) throw unavailable();
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1 || (value as { version?: unknown }).version !== 1) throw unavailable();
    return true;
  } catch { throw unavailable(); }
}

// Called by the common trusted hook before publishing an intent. The caller's
// tool fields cannot supply provenance; only an already validated inbox parent
// can produce this fixed bit. Its only reader can refuse a downgrade.
export function rememberGuardedMcpReply(paths: NodePaths, requestId: string, parentId: unknown): void {
  if (!isMessageId(requestId)) throw unavailable();
  if (!isMessageId(parentId)) return;
  const parent = getMessage(paths.inbox, parentId);
  if (!parent || !Object.hasOwn(parent, "loop")) return;
  if (!isLoopAdmissionV1(parent.loop) || parent.depth !== parent.loop.depth) throw unavailable();
  const dir = directory(paths);
  ensureDir(dir);
  withCapacityLock(dir, () => {
    if (wasGuardedMcpReply(paths, requestId)) return;
    const count = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
    if (count >= MAX_GUARDED_MCP_REPLIES) throw unavailable();
    writeJsonAtomic(fileOf(paths, requestId), { version: 1 });
  });
}
