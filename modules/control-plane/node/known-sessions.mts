import path from "node:path";

import { sessionVerdict } from "./session-lifecycle.mts";
import type { SessionInfo } from "../protocol.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";

// The sessions this node has listed recently (issue #102). sessions.json holds
// only the last listing, so a session that ended is gone from it; this file
// keeps its runtime, name and working directory for a while, so a message that
// arrives for it can still resume it (closed-delivery.mts). Updated by every
// successful listing, entries not seen for KNOWN_RETENTION_MS are dropped.
//
// Issue #389: one listing without a session is no proof that it ended. Each
// entry also counts the successful listings since it was last seen that did not
// show it (misses, from missedSince to missedAt). A listing that shows it starts
// a fresh entry without them; a failed listing never reaches this file, and a
// partial one (unseen runtimes, sessions.mts) counts no miss for the runtimes it
// could not see. The streak lives and is pruned with its entry.

export const KNOWN_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_KNOWN = 512;

// Legacy miss counters are diagnostic only. Positive metadata decides closure.
export const CLOSED_AFTER_MISSES = 3;
export const CLOSED_MIN_AGE_MS = 90_000;

export interface KnownSession {
  sessionId: string; runtime: string; name?: string; cwd?: string; lastSeen: string;
  misses?: number; missedSince?: string; missedAt?: string;
}

// The runtimes a successful listing could not see ("*" for all), set by
// listSessions on the array it returns and read where the listing is recorded.
const unseenRuntimes = new WeakMap<SessionInfo[], readonly string[]>();
export function markUnseen(sessions: SessionInfo[], runtimes: readonly string[]): SessionInfo[] {
  if (runtimes.length > 0) unseenRuntimes.set(sessions, runtimes);
  return sessions;
}
export const unlistedRuntimes = (sessions: SessionInfo[]): readonly string[] => unseenRuntimes.get(sessions) ?? [];

export const knownSessionsFile = (paths: NodePaths): string => path.join(paths.dir, "known-sessions.json");

export function readKnownSessions(paths: NodePaths): KnownSession[] {
  const value = readJson<{ sessions?: unknown }>(knownSessionsFile(paths));
  return Array.isArray(value?.sessions) ? value.sessions as KnownSession[] : [];
}

// Merges a successful listing into the file, newest first. unseen names the
// runtimes the listing could not see ("*" for all of them).
export function rememberSessions(paths: NodePaths, sessions: SessionInfo[], now: number = Date.now(),
  unseen: readonly string[] = []): void {
  const seen = new Date(now).toISOString();
  const fresh: KnownSession[] = sessions.map((s) => ({ sessionId: s.sessionId, runtime: s.runtime,
    ...(s.name ? { name: s.name } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), lastSeen: seen }));
  const ids = new Set(fresh.map((s) => `${s.runtime}/${s.sessionId}`));
  const missed = (s: KnownSession): boolean => !unseen.includes("*") && !unseen.includes(s.runtime);
  const kept = readKnownSessions(paths).filter((s) => !ids.has(`${s.runtime}/${s.sessionId}`) && now - Date.parse(s.lastSeen) <= KNOWN_RETENTION_MS)
    .map((s) => missed(s) ? { ...s, misses: (s.misses ?? 0) + 1, missedSince: s.missedSince ?? seen, missedAt: seen } : s);
  ensureDir(paths.dir);
  writeJsonAtomic(knownSessionsFile(paths), { sessions: [...fresh, ...kept].slice(0, MAX_KNOWN) });
}

// The known session a reference names: by id, else by a name only one holds.
export function findKnown(paths: NodePaths, ref: string): KnownSession | null {
  const known = readKnownSessions(paths);
  const byId = known.find((s) => s.sessionId === ref);
  if (byId) return byId;
  const named = known.filter((s) => s.name === ref);
  return named.length === 1 ? named[0] : null;
}

// A message target this node never listed (a Codex session its hook recorded
// while no daemon listed, a task session that ended between two listings)
// gets an entry now, so that the listings from here on count its misses.
export function trackSession(paths: NodePaths, session: { sessionId: string; runtime: string; cwd?: string }, now: number): void {
  const known = readKnownSessions(paths);
  if (known.some((s) => s.sessionId === session.sessionId)) return;
  ensureDir(paths.dir);
  writeJsonAtomic(knownSessionsFile(paths), { sessions: [{ ...session, lastSeen: new Date(now).toISOString() }, ...known].slice(0, MAX_KNOWN) });
}

// Positive liveness/lifecycle evidence only; miss counters confer no authority.
export function closedSession(paths: NodePaths, sessionId: string, now = Date.now()): boolean {
  const known = readKnownSessions(paths).filter(s => s.sessionId === sessionId);
  if (known.length !== 1) return false;
  const row = known[0];
  // Keep the old miss/min-age veto: metadata can narrow, never widen, fallback.
  return (row.misses ?? 0) >= CLOSED_AFTER_MISSES
    && Date.parse(row.missedAt ?? "") - Date.parse(row.missedSince ?? "") >= CLOSED_MIN_AGE_MS
    && sessionVerdict(paths, row, now).state === "closed";
}
