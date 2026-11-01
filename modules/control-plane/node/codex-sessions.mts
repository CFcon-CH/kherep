import fs from "node:fs";
import path from "node:path";

import { isSessionInfo, isSessionList, type SessionInfo } from "../protocol.mts";
import { isSessionRef } from "../protocol-messages.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { isActive, listTasks } from "./task-records.mts";

// Codex session discovery (issue #31, step 4). Codex has no documented session
// listing and documents no session id variable (CODEX_THREAD_ID is source-defined,
// runtime-identity.mts), but every hook input carries session_id and cwd (https://learn.chatgpt.com/docs/hooks.md,
// "Common input fields"). The delivery hook therefore records each Codex
// session it sees in codex-sessions/<session_id>.json, and the daemon lists the
// sessions seen recently.

export const CODEX_RUNTIME = "codex";
// Historical hook evidence is retained within this window; it never proves running.
export const CODEX_ACTIVE_MS = 12 * 60 * 60_000;
// Files of sessions not seen for this long are removed.
export const CODEX_RETENTION_MS = 7 * 24 * 60 * 60_000;

// The hook events a record keeps as idle evidence (issue #408).
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const;
export type CodexHookEvent = typeof CODEX_HOOK_EVENTS[number];
export const isCodexHookEvent = (value: unknown): value is CodexHookEvent => CODEX_HOOK_EVENTS.includes(value as CodexHookEvent);

// permissionMode: the hook input's permission_mode (documented values default,
// acceptEdits, plan, dontAsk, bypassPermissions), kept when a later input lacks it.
// lastEvent and lastEventAt: the last hook event and its time; lastStopAt: the
// time of the last Stop. All three are kept when a later input has no event; a
// record without lastEvent (an older hook) is unknown, never idle.
// lastStopEnded: the last Stop ended its turn, written by markStopEnded on
// every exit of the Stop hook that returns no blocking continuation. Every hook
// event clears it, so a Stop starts without it; absent is unknown, never idle.
export interface CodexSessionRecord {
  sessionId: string; cwd?: string; lastSeen: string; runtime: typeof CODEX_RUNTIME; permissionMode?: string;
  lastEvent?: CodexHookEvent; lastEventAt?: string; lastStopAt?: string; lastStopEnded?: true;
}

// Idle evidence (issue #408): the last event is a Stop marked as ended, at
// least idleAfterMs ago, and the session was seen within CODEX_ACTIVE_MS.
// Evidence, not proof: whether Stop fires on a cancelled turn, or an approval
// wait is told apart, is UNKNOWN. A threshold outside 30 s to 1 h is never idle.
export const CODEX_IDLE_AFTER_MS = 90_000;
const IDLE_AFTER_MIN_MS = 30_000;
const IDLE_AFTER_MAX_MS = 3_600_000;

export function idleEvidence(record: CodexSessionRecord | null | undefined, now: number, idleAfterMs: number = CODEX_IDLE_AFTER_MS): boolean {
  if (!Number.isSafeInteger(idleAfterMs) || idleAfterMs < IDLE_AFTER_MIN_MS || idleAfterMs > IDLE_AFTER_MAX_MS) return false;
  if (record?.lastEvent !== "Stop" || record.lastStopEnded !== true) return false;
  const stoppedAt = Date.parse(record.lastStopAt ?? ""), seenAt = Date.parse(record.lastSeen);
  return now - stoppedAt >= idleAfterMs && now - seenAt <= CODEX_ACTIVE_MS;
}

const EVENT_KEYS = ["lastEvent", "lastEventAt", "lastStopAt", "lastStopEnded"] as const;
type EventFields = Pick<CodexSessionRecord, typeof EVENT_KEYS[number]>;

// A hook event replaces the last event (a Stop also the stop time) and clears
// lastStopEnded; anything else keeps the previous record's valid event fields.
function eventFields(previous: CodexSessionRecord | null, event: unknown, now: number): EventFields {
  const validTime = (value: unknown): string | undefined => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined);
  const at = new Date(now).toISOString();
  const keptEvent = isCodexHookEvent(previous?.lastEvent) ? previous.lastEvent : undefined;
  const lastEvent = isCodexHookEvent(event) ? event : keptEvent;
  const lastEventAt = isCodexHookEvent(event) ? at : validTime(previous?.lastEventAt);
  const lastStopAt = event === "Stop" ? at : validTime(previous?.lastStopAt);
  const ended = !isCodexHookEvent(event) && previous?.lastStopEnded === true;
  return { ...(lastEvent ? { lastEvent } : {}), ...(lastEventAt ? { lastEventAt } : {}), ...(lastStopAt ? { lastStopAt } : {}),
    ...(ended ? { lastStopEnded: true } : {}) };
}

// The previous record with its event fields replaced as a whole: a field that
// eventFields leaves out is cleared, as in a record written anew.
function withEventFields(previous: CodexSessionRecord, event: unknown, now: number): CodexSessionRecord {
  const rest: CodexSessionRecord = { ...previous };
  for (const key of EVENT_KEYS) delete rest[key];
  return { ...rest, ...eventFields(previous, event, now) };
}

// Session ids name files, so only plain file-name characters are accepted.
export function isCodexSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

// The last 8 characters (issue #66): a Codex thread id is a UUIDv7, whose
// first 8 characters are the top of its millisecond timestamp, so sessions
// started within about a minute shared the earlier prefix name; the tail is random.
export function codexSessionName(sessionId: string): string {
  return `codex-${sessionId.slice(-8)}`;
}

// The name before issue #66, still honoured where it is unambiguous.
export const legacyCodexSessionName = (sessionId: string): string => `codex-${sessionId.slice(0, 8)}`;

function readCompleteLocalSessions(paths: NodePaths): SessionInfo[] | null {
  try {
    const snapshot = readJson<{ sessions?: unknown }>(paths.sessions);
    if (!snapshot || !isSessionList(snapshot.sessions)) return null;
    const valid = snapshot.sessions.every((session) => isSessionRef(session.sessionId)
      && (session.name === undefined || isSessionRef(session.name)));
    return valid ? snapshot.sessions : null;
  } catch {
    return null;
  }
}

// The inbox references of a Codex session: its id, and each of its names (new
// and legacy) that no other live recorded session shares; ambiguous lists the
// names that are shared. live: the ids of the recorded sessions, listed here
// when not given.
export function codexSessionRefs(paths: NodePaths, sessionId: string, now: number = Date.now(),
  live?: string[]): { refs: string[]; ambiguous: string[] } {
  let ids = live;
  if (!ids) {
    try {
      ids = listCodexSessions(paths, now).map((s) => s.sessionId);
    } catch {
      ids = [];
    }
  }
  const all = ids.includes(sessionId) ? ids : [...ids, sessionId];
  const snapshot = readCompleteLocalSessions(paths);
  const local = snapshot ?? [];
  const localKnown = snapshot !== null;
  const exactIds = new Set([...all, ...local.map((session) => session.sessionId)]);
  const refs = [sessionId];
  const ambiguous: string[] = [];
  for (const name of new Set([codexSessionName(sessionId), legacyCodexSessionName(sessionId)])) {
    if (!localKnown) {
      ambiguous.push(name);
      continue;
    }
    if (exactIds.has(name)) continue;
    const holders = new Set(all.filter((id) => codexSessionName(id) === name || legacyCodexSessionName(id) === name));
    for (const session of local) if (session.name === name) holders.add(session.sessionId);
    (holders.size > 1 ? ambiguous : refs).push(name);
  }
  return { refs, ambiguous };
}

const fileOf = (paths: NodePaths, sessionId: string): string => path.join(paths.codexSessions, `${sessionId}.json`);

// Writes or refreshes the record of one Codex session. Throws for an id that
// cannot name a file. event: the hook event (issue #408).
export function recordCodexSession(paths: NodePaths, sessionId: string, cwd: unknown, now: number = Date.now(), permissionMode?: unknown,
  event?: unknown): void {
  if (!isCodexSessionId(sessionId)) throw new Error("codex session id is not a plain name");
  ensureDir(paths.codexSessions);
  let previous: CodexSessionRecord | null = null;
  try {
    previous = readCodexSession(paths, sessionId);
  } catch {
    // an unreadable record is rewritten without its mode and events
  }
  const given = typeof permissionMode === "string" && /^[A-Za-z-]{1,32}$/.test(permissionMode) ? permissionMode : undefined;
  const mode = given ?? previous?.permissionMode;
  const record: CodexSessionRecord = {
    sessionId, ...(typeof cwd === "string" && isSessionRef(cwd) && cwd.length <= 512 ? { cwd } : {}),
    lastSeen: new Date(now).toISOString(), runtime: CODEX_RUNTIME, ...(mode ? { permissionMode: mode } : {}),
    ...eventFields(previous, event, now),
  };
  writeJsonAtomic(fileOf(paths, sessionId), record);
}

// Issue #408: the original owner's PostToolUse refreshes the last event of an
// existing record and nothing else, so a tool boundary never creates a session
// or moves lastSeen. false: no record of this session to refresh.
export function refreshCodexEvent(paths: NodePaths, sessionId: string, event: CodexHookEvent, now: number = Date.now()): boolean {
  return updateRecord(paths, sessionId, (previous) => withEventFields(previous, event, now));
}

// Issue #408: the Stop just recorded returned no blocking continuation, so it
// ended the turn; only such a Stop is idle evidence. false: no record of this session.
export function markStopEnded(paths: NodePaths, sessionId: string): boolean {
  return updateRecord(paths, sessionId, (previous) => ({ ...previous, lastStopEnded: true }));
}

function updateRecord(paths: NodePaths, sessionId: string, change: (previous: CodexSessionRecord) => CodexSessionRecord): boolean {
  if (!isCodexSessionId(sessionId)) return false;
  const previous = readCodexSession(paths, sessionId);
  if (previous?.sessionId !== sessionId || previous.runtime !== CODEX_RUNTIME || !Number.isFinite(Date.parse(previous.lastSeen ?? ""))) return false;
  writeJsonAtomic(fileOf(paths, sessionId), change(previous));
  return true;
}

// Issue #197: the readiness probe's own run loads the user's config, whose
// delivery hook records its thread; the probe forgets it again.
export function forgetCodexSession(paths: NodePaths, sessionId: string): void {
  if (isCodexSessionId(sessionId)) fs.rmSync(fileOf(paths, sessionId), { force: true });
}

export function readCodexSession(paths: NodePaths, sessionId: string): CodexSessionRecord | null {
  return isCodexSessionId(sessionId) ? readJson<CodexSessionRecord>(fileOf(paths, sessionId)) : null;
}

export function isCodexSession(paths: NodePaths, sessionId: string): boolean {
  return isCodexSessionId(sessionId) && fs.existsSync(fileOf(paths, sessionId));
}

// The Codex sessions seen within activeMs, as session info. Removes records
// older than the retention period. A missing directory is no sessions; other
// read errors throw, because a failed read is not an empty node.
export function listCodexSessions(paths: NodePaths, now: number = Date.now(), activeMs: number = CODEX_ACTIVE_MS): SessionInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.codexSessions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sessions: SessionInfo[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(paths.codexSessions, name);
    let record: CodexSessionRecord | null = null;
    try {
      record = readJson<CodexSessionRecord>(file);
    } catch {
      // unreadable record: its file time decides below
    }
    const seen = Date.parse(record?.lastSeen ?? "") || fs.statSync(file).mtimeMs;
    if (now - seen > CODEX_RETENTION_MS) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!record || !isCodexSessionId(record.sessionId) || `${record.sessionId}.json` !== name || now - seen > activeMs) continue;
    const session: SessionInfo = { sessionId: record.sessionId, runtime: CODEX_RUNTIME, state: seen <= now ? "reachable-probable" : "unknown",
      name: codexSessionName(record.sessionId), ...(record.cwd ? { cwd: record.cwd } : {}), kind: "codex" };
    if (isSessionInfo(session) && isSessionRef(session.name)) sessions.push(session);
  }
  return sessions;
}

// Codex task sessions (issue #63), from the task records themselves: a
// `codex exec` run may never fire a hook, and an ended run can still be
// messaged (codex-wake.mts resumes it). Listed once the thread id is known,
// while active or updated within activeMs, with the task's name. An intercom
// run the node started on its own is kind codex-intercom (issue #198); every
// Worker accepts it, since kind has always been any string of up to 32 chars.
export function listCodexTaskSessions(paths: NodePaths, now: number = Date.now(), activeMs: number = CODEX_ACTIVE_MS): SessionInfo[] {
  return listTasks(paths).flatMap((task) => {
    if (task.runtime !== CODEX_RUNTIME || !task.sessionId) return [];
    const active = isActive(task);
    if (!active && !(now - Date.parse(task.updatedAt) <= activeMs)) return [];
    const session: SessionInfo = { sessionId: task.sessionId, runtime: CODEX_RUNTIME, state: "unknown",
      startedAt: task.startedAt, name: task.name, ...(task.cwd.length <= 512 ? { cwd: task.cwd } : {}),
      kind: task.local === "intercom" ? "codex-intercom" : "codex-task", ...(task.label ? { label: task.label } : {}) };
    return isSessionInfo(session) ? [session] : [];
  });
}
