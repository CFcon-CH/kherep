import fs from "node:fs";
import path from "node:path";

import { budgetBytes, withBudgetMutation } from "./budget-lock.mts";
import { budgetMarker, budgetTombs, parseBudget } from "./budget-store.mts";
import { listenerDir } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { messageIds, readJson } from "./inbox.mts";
import { knownSessionsFile } from "./known-sessions.mts";
import { readIfPresent, takeIfUnchanged, type FileStamp, type SweepDeps } from "./listener-sweep.mts";
import { isActive, readTask } from "./task-records.mts";

// Removes the listener state files of sessions that ended (issue #474). The
// lock and its scope belong to the sweep (listener-sweep.mts); nothing else
// removed the rest: the remembered mode, the turn budget, the scope a
// listener's own release leaves, the woken records, the busy tickets of a Codex
// thread, and .queued.json, which has had no writer or reader since 2026-10-11.
// A session id's files go only when all of these hold:
// - a fresh, complete listing (sessions.json) does not show it;
// - known-sessions.json no longer holds it, 7 days after its last listing, so
//   closed delivery can no longer resolve it and its .mode.json guards nothing;
// - no lock and no in-flight lock or temporary file of it exists;
// - no active task record names it;
// - every one of its state files is older than STATE_RETENTION_MS, so a
//   session in use keeps them, and every turn in .turns.json is past the
//   budget's day.
// Any read that fails ends the pass with a skip reason and removes nothing.
// Each file is taken by the sweep's rename and compare: a file rewritten
// meanwhile is put back. At most PRUNE_MAX files per pass; the rest wait an hour.

export const STATE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const PRUNE_MAX = 200;
// LISTING_FRESH_MS of closed-delivery.mts, not imported: that module would load into every wake hook.
const LISTING_FRESH_MS = 3 * 60_000;
const STATE_NAME = /^([A-Za-z0-9_-]{1,128})\.(?:mode|turns|scope|stuck|woke|queued|busy-hint|busy-admission)\.json$/;
const LOCK_NAME = /^([A-Za-z0-9_-]{1,128})\.json$/;
// deliver-midturn.mts's lock, a turn or busy-hint lock, a temporary file of an atomic write.
const IN_FLIGHT_NAME = /^\.?([A-Za-z0-9_-]{1,128})\..*\.(?:lock(?:\.reclaim)*|tmp)$/;

export type PruneSkip = "listing-stale" | "listing-partial" | "listing-unreadable" | "known-unreadable" | "tasks-unreadable"
  | "dir-unreadable";
export type PruneResult = { removed: number; kept: number; sessions: number; failed: string[] } | { skipped: PruneSkip };

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

// The session ids of a list of entries, or null when one has none: a damaged entry may be the one that keeps a session.
const idsOf = (entries: unknown): string[] | null =>
  Array.isArray(entries) && entries.every((e) => typeof (e as { sessionId?: unknown } | null)?.sessionId === "string")
    ? entries.map((e) => (e as { sessionId: string }).sessionId) : null;

// The ids the node can still resume or is running, or why they cannot be known.
function retained(paths: NodePaths, now: number): Set<string> | PruneSkip {
  let listing: { sessions?: unknown; unseen?: unknown; updatedAt?: unknown } | null;
  try {
    listing = readJson(paths.sessions);
  } catch {
    return "listing-unreadable";
  }
  const listedAt = Date.parse(typeof listing?.updatedAt === "string" ? listing.updatedAt : "");
  if (!(Math.abs(now - listedAt) <= LISTING_FRESH_MS)) return "listing-stale";
  const listed = idsOf(listing?.sessions);
  if (!listed) return "listing-unreadable";
  if (!Array.isArray(listing?.unseen) || listing.unseen.length > 0) return "listing-partial";
  let known: string[] | null;
  try {
    const value = readJson<{ sessions?: unknown }>(knownSessionsFile(paths));
    known = value === null ? [] : idsOf(value.sessions);
  } catch {
    return "known-unreadable";
  }
  if (!known) return "known-unreadable";
  const ids = new Set([...listed, ...known]);
  try {
    for (const taskId of messageIds(paths.tasks)) {
      const task = readTask(paths, taskId);
      if (task && isActive(task) && typeof task.sessionId === "string") ids.add(task.sessionId);
    }
  } catch {
    return "tasks-unreadable";
  }
  return ids;
}

// The file's identity when it is past the retention, else null; null also when it cannot be stated: it stays.
const oldStamp = (file: string, now: number): FileStamp | null => {
  try {
    const { ino, mtimeMs } = fs.statSync(file);
    return now - mtimeMs > STATE_RETENTION_MS ? { ino, mtimeMs } : null;
  } catch {
    return null;
  }
};

// The state files the next pass removes, by session id: the dry run doctor reports.
export function pruneCandidates(paths: NodePaths, now: number): Map<string, string[]> | { skipped: PruneSkip } {
  const keep = retained(paths, now);
  if (typeof keep === "string") return { skipped: keep };
  const dir = listenerDir(paths);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return code(error) === "ENOENT" ? new Map() : { skipped: "dir-unreadable" };
  }
  for (const name of names) {
    const id = LOCK_NAME.exec(name)?.[1] ?? IN_FLIGHT_NAME.exec(name)?.[1];
    if (id) keep.add(id);
  }
  const files = new Map<string, string[]>();
  for (const name of names) {
    const id = STATE_NAME.exec(name)?.[1];
    if (!id || keep.has(id)) continue;
    const list = files.get(id) ?? [];
    list.push(path.join(dir, name));
    files.set(id, list);
  }
  for (const [id, list] of files) if (!list.every((file) => oldStamp(file, now))) files.delete(id);
  return files;
}

// Removes a candidate only while it is the file stated here, past the retention, with the bytes read
// before: an atomic rewrite with the same bytes (rememberMode of an unchanged mode) is a new inode and stays.
function takeOld(file: string, now: number, deps: SweepDeps): boolean {
  const seen = readIfPresent(file);
  const stamp = seen && oldStamp(file, now);
  if (!seen || !stamp) return false;
  deps.beforeTake?.(file);
  return takeIfUnchanged(file, seen, now, deps, stamp);
}

// Budget cleanup joins the writer lock and rechecks the candidate population.
// Protected v2 state keeps its marker and canonical record together, even when
// it has no group receipts yet; it can never be reset to an empty legacy file.
function takeOldBudget(paths: NodePaths, id: string, file: string, now: number, deps: SweepDeps): boolean {
  deps.beforeTake?.(file);
  return withBudgetMutation(file, () => {
    const keep = retained(paths, now);
    if (typeof keep === "string" || keep.has(id) || budgetTombs(file).length || budgetBytes(budgetMarker(file)) !== null) return false;
    const names = fs.readdirSync(listenerDir(paths));
    if (names.some(name => name !== path.basename(`${file}.lock`)
      && (LOCK_NAME.exec(name)?.[1] === id || IN_FLIGHT_NAME.exec(name)?.[1] === id))) return false;
    const related = names.filter(name => STATE_NAME.exec(name)?.[1] === id);
    if (!related.every(name => oldStamp(path.join(listenerDir(paths), name), now))) return false;
    const bytes = budgetBytes(file);
    if (bytes === null) return false;
    const record = parseBudget(bytes);
    if ("version" in record || record.turns.some(at => now - at < 86_400_000)) return false;
    return takeOld(file, now, { ...deps, beforeTake: undefined });
  });
}

export function pruneListenerState(paths: NodePaths, deps: SweepDeps = {}): PruneResult {
  const now = deps.now ?? Date.now();
  const candidates = pruneCandidates(paths, now);
  if (!(candidates instanceof Map)) return candidates;
  const result = { removed: 0, kept: 0, sessions: 0, failed: [] as string[] };
  const ended = new Set<string>();
  const files = [...candidates].flatMap(([id, list]) => list.map((file) => ({ id, file })));
  for (const { id, file } of files.slice(0, PRUNE_MAX)) {
    try {
      if (file.endsWith(".turns.json") ? takeOldBudget(paths, id, file, now, deps) : takeOld(file, now, deps)) {
        result.removed++;
        ended.add(id);
      } else result.kept++;
    } catch (error) {
      result.failed.push(code(error) ?? "error");
    }
  }
  result.sessions = ended.size;
  return result;
}
