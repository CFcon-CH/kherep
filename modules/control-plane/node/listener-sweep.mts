import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withBudgetMutation } from "./budget-lock.mts";
import { recoverBudget } from "./budget-store.mts";
import { listenerDir, listenerLock, listenerScope, type ListenerLock, type ListenerScope } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { pidAlive as processAlive } from "./daemon-state.mts";
import { orderOf } from "./listener-order.mts";
import { pruneListenerState } from "./listener-prune.mts";

// Removes the locks of wake listeners whose process is gone (issue #225):
// nothing else does, and doctor counts them as stale. The daemon sweeps at its
// start and then hourly.
// A lock goes only when its pid is not running or its content is not JSON; a
// live listener always holds its own pid, and its lock is written atomically.
// A pid reused by another process keeps the lock until that process ends.
// There is no compare-and-delete on a path, and a resuming session's new
// listener may write its scope and lock at any moment (wake-hook.mts writes the
// scope first). So the sweep renames the file to a tombstone, compares the
// tombstone byte for byte with what it judged, deletes it only when equal and
// otherwise puts it back by link, never over a later-armed lock (restore). A
// live lock moved aside for that moment is put back by its listener too, and a
// listener never yields to an older one (listener-order.mts, wake-hook.mts).
// With the lock goes its scope, but only while the scope carries that lock's
// token, by the same rename and compare. The session's other files stay while
// the node can resume it; listener-prune.mts removes them after it ended
// (issue #474), in the same pass and by the same rename and compare.

const SWEEP_INTERVAL_MS = 60 * 60_000;
// A tombstone older than this was left by a sweep that did not finish.
export const TOMB_RECOVER_AFTER_MS = 60_000;
const SWEEP_MAX = 500;
const RESTORE_ATTEMPTS = 4;
const LOCK_NAME = /^([A-Za-z0-9_-]{1,128})\.json$/;
// A lock's, or a state file's that listener-prune.mts took aside.
const TOMB_NAME = /^\.([A-Za-z0-9_-]{1,128}(?:\.(?:scope|mode|turns|stuck|woke|queued|busy-hint|busy-admission))?\.json)\.(\d+)-[0-9a-f-]{36}\.tomb$/;

// beforeTake and afterTake: test seams around the rename that takes a file aside.
export interface SweepDeps {
  pidAlive?: (pid: unknown) => boolean; now?: number; beforeTake?: (file: string) => void; afterTake?: (file: string) => void;
}
// failed: the error code of each file the sweep could not handle.
export type SweepResult = { removed: number; kept: number; failed: string[] } | { error: string };

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const parse = <T,>(raw: Buffer): T | null => {
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    return null;
  }
};

const tombOf = (file: string, now: number): string =>
  path.join(path.dirname(file), `.${path.basename(file)}.${now}-${crypto.randomUUID()}.tomb`);
// A lock's arming order (listener-order.mts); a dead listener's lock and content
// that is no lock count as oldest, so they never displace a live lock. ENOENT throws.
const rank = (file: string, alive: (pid: unknown) => boolean): number => {
  const lock = parse<Partial<ListenerLock>>(fs.readFileSync(file));
  return lock?.pid !== undefined && !alive(lock.pid) ? -Infinity : orderOf(lock);
};
const missing = (error: unknown): boolean => code(error) === "ENOENT";

// Puts a tombstone back. If a file took the place meanwhile, the later-armed
// lock keeps it, the one in place on a tie (it was written later): an
// older listener that wrote into the gap (a SessionStart check that saw no
// lock) or another sweep's recovery never displaces a newer lock. An older one
// in place is taken aside by rename and judged again, since a newer one may
// land meanwhile. What loses is the older of two locks of one session, which
// the newer listener's arming overwrites anyway and which makes it stand down
// at its next poll. With the gap refilled RESTORE_ATTEMPTS times, the newest
// stays a tombstone for a later recovery, and its listener reasserts itself.
function restore(tomb: string, file: string, now: number, deps: SweepDeps): void {
  const alive = deps.pidAlive ?? processAlive;
  let keep = tomb;
  const losers: string[] = [];
  try {
    for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
      try {
        fs.linkSync(keep, file);
        losers.push(keep);
        return;
      } catch (error) {
        // ENOENT: another sweep put it back meanwhile.
        if (missing(error)) return;
        if (code(error) !== "EEXIST") throw error;
      }
      try {
        if (rank(file, alive) >= rank(keep, alive)) {
          losers.push(keep);
          return;
        }
        const aside = tombOf(file, now);
        fs.renameSync(file, aside);
        deps.afterTake?.(file);
        const newer = rank(aside, alive) >= rank(keep, alive);
        losers.push(newer ? keep : aside);
        if (newer) keep = aside;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  } finally {
    for (const loser of losers) fs.rmSync(loser, { force: true });
  }
}

// A file's identity when it was judged: a rename keeps both, an atomic rewrite changes them.
export interface FileStamp { ino: number; mtimeMs: number }

// Removes file only if it still holds exactly the bytes seen and, with a
// stamp, is still the file stated then (listener-prune.mts).
export function takeIfUnchanged(file: string, seen: Buffer, now: number, deps: SweepDeps, stamp?: FileStamp): boolean {
  const tomb = tombOf(file, now);
  try {
    fs.renameSync(file, tomb);
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
  deps.afterTake?.(file);
  let same = false;
  try {
    same = fs.readFileSync(tomb).equals(seen);
    if (same && stamp) {
      const { ino, mtimeMs } = fs.statSync(tomb);
      same = ino === stamp.ino && mtimeMs === stamp.mtimeMs;
    }
  } finally {
    if (same) fs.rmSync(tomb, { force: true });
    else if (file.endsWith(".turns.json")) recoverBudget(file);
    else restore(tomb, file, now, deps);
  }
  return same;
}

// The read error travels up: a file that cannot be read is never taken for a dead lock.
export function readIfPresent(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}

function sweepOne(paths: NodePaths, session: string, now: number, deps: SweepDeps): "removed" | "kept" {
  const alive = deps.pidAlive ?? processAlive;
  const file = listenerLock(paths, session);
  const raw = readIfPresent(file);
  if (!raw) return "kept";
  const lock = parse<Partial<ListenerLock>>(raw);
  if (lock !== null && alive(lock.pid)) return "kept";
  deps.beforeTake?.(file);
  if (!takeIfUnchanged(file, raw, now, deps)) return "kept";
  const scopeFile = listenerScope(paths, session);
  const scopeRaw = typeof lock?.token === "string" ? readIfPresent(scopeFile) : null;
  if (scopeRaw && parse<ListenerScope>(scopeRaw)?.token === lock?.token) {
    deps.beforeTake?.(scopeFile);
    takeIfUnchanged(scopeFile, scopeRaw, now, deps);
  }
  return "removed";
}

export function sweepListeners(paths: NodePaths, deps: SweepDeps = {}): SweepResult {
  const dir = listenerDir(paths);
  const now = deps.now ?? Date.now();
  const result = { removed: 0, kept: 0, failed: [] as string[] };
  const failed = (error: unknown): void => { result.failed.push(code(error) ?? "error"); };
  const list = (): string[] => fs.readdirSync(dir);
  let names: string[];
  try {
    names = list();
    for (const name of names) {
      const tomb = TOMB_NAME.exec(name);
      if (!tomb || now - Number(tomb[2]) <= TOMB_RECOVER_AFTER_MS) continue;
      try {
        const file = path.join(dir, tomb[1]);
        if (file.endsWith(".turns.json")) withBudgetMutation(file, () => recoverBudget(file));
        else restore(path.join(dir, name), file, now, deps);
      } catch (error) { failed(error); }
    }
    // Read again, so a dead lock just linked back is swept now, not in an hour.
    names = list();
  } catch (error) {
    if (code(error) === "ENOENT") return result;
    return { error: code(error) ?? "unreadable" };
  }
  for (const name of names) {
    if (result.removed >= SWEEP_MAX) break;
    const session = LOCK_NAME.exec(name)?.[1];
    if (!session) continue;
    try {
      result[sweepOne(paths, session, now, deps)]++;
    } catch (error) {
      failed(error);
    }
  }
  return result;
}

// A listener's own lock and then its scope, each removed only while it still
// carries the listener's token, by the same rename and compare: a listener
// that armed meanwhile keeps both (a headless run, wake-hook.mts, issue #235).
// True when both were its own.
export function releaseOwn(paths: NodePaths, session: string, token: string, now: number): boolean {
  let own = true;
  for (const file of [listenerLock(paths, session), listenerScope(paths, session)]) {
    const raw = readIfPresent(file);
    own = raw !== null && parse<{ token?: unknown }>(raw)?.token === token && takeIfUnchanged(file, raw, now, {}) && own;
  }
  return own;
}

// The daemon's sweep and then the prune of ended sessions' state files: at
// once, then every SWEEP_INTERVAL_MS. A skipped prune is silent; doctor shows it. Returns the stop.
export function scheduleListenerSweep(paths: NodePaths, log: (line: string) => void): () => void {
  const run = (): void => {
    const result = sweepListeners(paths);
    if ("error" in result) log(`kherep-node: listener sweep could not read the listener directory (${result.error})`);
    else if (result.removed + result.failed.length > 0) {
      const failures = result.failed.length ? `; ${result.failed.length} failed (${result.failed.join(", ")})` : "";
      log(`kherep-node: removed ${result.removed} stale listener lock(s)${failures}`);
    }
    const pruned = pruneListenerState(paths);
    if (!("skipped" in pruned) && pruned.removed + pruned.failed.length > 0) {
      const failures = pruned.failed.length ? `; ${pruned.failed.length} failed (${pruned.failed.join(", ")})` : "";
      log(`kherep-node: removed ${pruned.removed} orphaned listener file(s) of ${pruned.sessions} ended session(s)${failures}`);
    }
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
