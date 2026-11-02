import fs from "node:fs";

import {
  bypassesPermissions, isPlainSessionId, listenerLock, listenerScope, rememberedMode, type ListenerLock, type ListenerScope,
} from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { readLocalSessions, type LocalSession } from "./exchange.mts";
import { listInbox, readJson, setMessageProgress, type InboxRecord } from "./inbox.mts";
import { wakeAllowed } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { isActive, listTasks, taskForSession, taskGrants } from "./task-records.mts";
import { killSwitch, WAKE_MAX_WAIT_MS } from "./wake-hook.mts";
import { lazyRequests, replyGrants, taskMessageGrants, type RequestIndex } from "./wake-reply.mts";

// Issue #487: the daemon passes its inbox index or the round snapshot.
export const inboxOf = (deps: RunnerDeps): InboxRecord[] => deps.inbox?.() ?? listInbox(deps.paths.inbox);

const refsOf = (session: { sessionId: string; name?: string }): string[] =>
  session.name ? [session.sessionId, session.name] : [session.sessionId];

export function progressRecords(paths: NodePaths, records: InboxRecord[], phase: Parameters<typeof setMessageProgress>[2],
  code: Parameters<typeof setMessageProgress>[3], now: number, retryAt?: number): void {
  for (const record of records) setMessageProgress(paths.inbox, record.messageId, phase, code, now, retryAt);
}

function observeAccepted(deps: RunnerDeps, session: LocalSession, accepted: InboxRecord[], now: number,
  requests: () => RequestIndex): void {
  if (accepted.length === 0) return;
  if (session.state !== "idle-loaded") {
    progressRecords(deps.paths, accepted, "waiting", "target-busy", now);
    return;
  }
  const refs = refsOf(session);
  const task = deps.policy.sessions?.enabled === true ? taskForSession(deps.paths, session.sessionId) : null;
  const granted = task ? accepted.filter((record) => taskGrants(task, record)) : [];
  // Reply and task message grants (issues #253, #264): for an unlisted session
  // only, as in its listener, and covered by the same replies scope.
  const replies = deps.policy.wake?.replies === true && !wakeAllowed(deps.policy, refs)
    ? accepted.filter((record) => !granted.includes(record)
      && (replyGrants(deps.paths, refs, record, now) || taskMessageGrants(deps.paths, refs, record, now, requests))) : [];
  const ordinary = accepted.filter((record) => !granted.includes(record) && !replies.includes(record));
  if (fs.existsSync(killSwitch(deps.paths))) {
    progressRecords(deps.paths, accepted, "waiting", "wake-disabled", now);
    return;
  }
  if (!deps.policy.wake) progressRecords(deps.paths, ordinary, "waiting", "wake-disabled", now);
  else if (!wakeAllowed(deps.policy, refs)) progressRecords(deps.paths, ordinary, "waiting", "wake-not-authorized", now);
  const authorized = [...granted, ...replies, ...(wakeAllowed(deps.policy, refs) ? ordinary : [])];
  if (authorized.length === 0) return;
  const mode = task?.permissionMode ?? rememberedMode(deps.paths, session.sessionId);
  if (bypassesPermissions(mode)) {
    progressRecords(deps.paths, authorized, "waiting", "permission-restricted", now);
    return;
  }
  const lock = readJson<ListenerLock>(listenerLock(deps.paths, session.sessionId));
  let listener = lock !== null && now - lock.startedAt <= WAKE_MAX_WAIT_MS;
  if (listener && lock) {
    try { process.kill(lock.pid, 0); } catch (error) { listener = (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  // Waking only for what the live listener's scope covers (issue #213). Without
  // its scope (an older listener) only the task grant, which every listener
  // looks up; a reply or task message only with a scope that says replies. Otherwise
  // awaiting-user-turn: a new code would make an older Worker refuse the whole
  // status (isNodeMessageStatusBody).
  const scope = readJson<ListenerScope>(listenerScope(deps.paths, session.sessionId));
  const own = scope !== null && scope.token === lock?.token ? scope : null;
  const covered = (record: InboxRecord): boolean => listener
    && (own?.listed === true || (granted.includes(record) && (own === null || own.taskId === task?.taskId))
      || (replies.includes(record) && own?.replies === true));
  progressRecords(deps.paths, authorized.filter(covered), "waking", "wake-pending", now);
  progressRecords(deps.paths, authorized.filter((record) => !covered(record)), "waiting", "awaiting-user-turn", now);
}

// A successful session snapshot is the node's current evidence for Claude.
// Each message is resolved once, with an exact session id taking precedence
// over names. This observer emits fixed metadata only; it never reads transcript content.
export function observeClaudeDeliveryProgress(deps: RunnerDeps): void {
  const now = deps.now?.() ?? Date.now();
  const allSessions = new Map<string, LocalSession>();
  for (const session of readLocalSessions(deps.paths, now)) allSessions.set(session.sessionId, session);
  const claudeSessions = new Map([...allSessions].filter(([, session]) => session.runtime === "claude-code"));
  const byName = new Map<string, LocalSession[]>();
  for (const session of allSessions.values()) {
    if (!session.name) continue;
    byName.set(session.name, [...(byName.get(session.name) ?? []), session]);
  }
  const resolve = (record: InboxRecord): LocalSession | "ambiguous" | undefined => {
    const exact = allSessions.get(record.toSession);
    if (exact) return exact;
    const aliases = byName.get(record.toSession) ?? [];
    if (aliases.length > 1 && aliases.some((session) => session.runtime === "claude-code")) return "ambiguous";
    return aliases.length === 1 ? aliases[0] : undefined;
  };

  const waiting = inboxOf(deps).filter((record) => record.state === "accepted" || record.state === "offered");
  progressRecords(deps.paths, waiting.filter((record) => {
    if (record.state !== "offered") return false;
    const target = resolve(record);
    return target === "ambiguous" || target?.runtime === "claude-code";
  }), "waiting", "awaiting-turn-confirmation", now);

  const assigned = new Map<string, InboxRecord[]>();
  const ambiguous: InboxRecord[] = [];
  for (const record of waiting.filter((entry) => entry.state === "accepted")) {
    const target = resolve(record);
    if (target === "ambiguous") {
      ambiguous.push(record);
      continue;
    }
    if (target?.runtime === "claude-code") {
      assigned.set(target.sessionId, [...(assigned.get(target.sessionId) ?? []), record]);
    }
  }
  progressRecords(deps.paths, ambiguous, "waiting", "ambiguous-target", now);
  // One task request index per observation, read only if a session needs it (issue #266).
  const requests = lazyRequests(deps.paths);
  for (const session of claudeSessions.values()) observeAccepted(deps, session, assigned.get(session.sessionId) ?? [], now, requests);
}

// Codex task sessions the message resume (codex-wake.mts) skips: a running
// task is busy, an operator-stopped one waits for an explicit continue (issue
// #197). Only accepted messages addressed to the task itself are annotated;
// a message closed-session delivery handed over keeps that path's progress.
// Without such a task the inbox is not read.
export function observeCodexTaskProgress(deps: RunnerDeps): void {
  const held = listTasks(deps.paths).filter((task) => task.runtime === "codex" && isPlainSessionId(task.sessionId)
    && (task.operatorStoppedAt !== undefined || isActive(task)));
  if (held.length === 0) return;
  const now = deps.now?.() ?? Date.now();
  const waiting = inboxOf(deps).filter((record) => record.state === "accepted" && record.closedTo === undefined);
  for (const task of held) {
    const records = waiting.filter((record) => record.toSession === task.sessionId || record.toSession === task.name);
    const code = task.operatorStoppedAt !== undefined ? "operator-stopped" : "target-busy";
    progressRecords(deps.paths, records, "waiting", code, now);
  }
}
