import type { TargetHandle } from "./target-delivery-reservation.mts";
import fs from "node:fs";
import path from "node:path";

import {
  isTaskId, taskSessionName, type PermissionMode, type TaskReportBody, type TaskRequestBody, type TaskRuntime, type TaskState,
} from "../protocol-tasks.mts";
import type { ProcessIdentity } from "./codex-stop.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { localSessionName, readDirectory } from "./exchange.mts";
import { messageIds, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";

// The node's task files (issue #31, item 5), in its config directory:
//   tasks/<taskId>.json          a task session this node started
//   task-reports/<id>.json       task.report bodies the daemon sends, then removes
//   task-requests/<requestId>.json  task.request bodies from `task new`, with their result

export interface TaskRecord {
  targetAttempt?:TargetHandle;
  observedSessionId?:string; mappingConflict?:"identity-or-alias";
  taskId: string; name: string; cwd: string; permissionMode: PermissionMode; state: TaskState;
  startedAt: string; deadline: string; updatedAt: string;
  // Absent in records written before issue #63: claude.
  runtime?: TaskRuntime;
  // Claude: shortId is the id `claude --bg` prints, for `claude stop`;
  // sessionId the full id from `claude agents --json`, for `claude --resume`.
  // Codex: sessionId is the thread_id of `thread.started`, for `codex exec
  // resume`; pid and pidStart (the process start time) identify the process
  // to stop, since a pid alone may be reused. Claude (issue #437): pid is the
  // process `claude agents --json` lists for the session while it is alive and
  // pidStart its start time, recorded at launch and re-captured by status when
  // the supervisor restarted the process (task-control-claude.mts).
  shortId?: string; sessionId?: string; requestedBy?: string; sourceRequestId?: string; reason?: string;
  // The display label of the session (issue #74), shown in the directory
  // instead of the name; the name stays task-<8>.
  label?: string;
  pid?: number; pidStart?: string;
  // Codex, issue #233: the run's descendant processes (pid and start time),
  // refreshed by the watch round while the run lives, so that a run whose
  // root ended abruptly can still end them (codex-reap.mts).
  descendants?: ProcessIdentity[];
  // A confirmed operator request blocks autonomous message resumes until an explicit continue.
  operatorStoppedAt?: string;
  // Exact run whose remote stop may require recovery; blocks automatic retry.
  taskControlRecoveryRunVersion?: string;
  // Codex: the inbox messages a run started for peer messages carries
  // (codex-wake.mts); settled as delivered or retry when that run ends.
  offered?: string[];
  // Set by `task done`: the session reported done, but its process may still
  // run, so the record stays counted and watched (limits, deadline) until
  // `claude agents` shows the session ended or the deadline stopped it.
  running?: boolean;
  // Issue #541: failed max-runtime stops of the current run whose fresh status
  // still showed a live process or decided nothing (task-watch.mts); the
  // record is settled after MAX_STOP_ROUNDS.
  stopAttempts?: number;
  // A record the Worker does not know (issue #102, closed-delivery.mts): an
  // intercom session the node started on its own, or (written before issue
  // #105) a closed session it resumed for peer messages. No task.report is
  // sent for it, its messages carry no task id, and taskForSession skips a
  // resumed session.
  local?: "intercom" | "resume";
  // Set while Claude Code has been asked to start or resume the session and
  // its session id is not confirmed by `claude agents --json` yet (issue #109).
  mappingPendingSince?: string;
  // Issue #197: when the current run was launched, until the watch round sees
  // its turn progress (run-progress.mts); a run without progress is failed.
  awaitingProgressSince?: string;
  // Claude intercom start: the messages its task text carries, delivered once
  // its turn shows progress, refused when it shows none.
  carried?: string[];
  // Exact inbox records waiting for this local delivery task's session id.
  // Resolved only when this task gains an id, avoiding inbox-wide scans.
  deliveryPending?: string[];
  // Intercom: sessions the record held before a resume continued it as a copy
  // (issue #111), to stop once idle (copy-retire.mts); rounds counts the watch
  // rounds that found one busy.
  retire?: { shortId: string; sessionId: string; rounds?: number }[];
}

// The sender of a message as an intercom session's requestedBy records it.
export const senderOf = (record: InboxRecord): string => `${record.from.nodeId}/${record.from.session}`;

// Task grant (item 5): a task session may be woken for the messages of its
// task; an intercom session the node started on its own (issue #105) also for
// those of the session it answers, whose messages carry no task id.
export const taskGrants = (task: TaskRecord, record: InboxRecord): boolean =>
  record.taskId === task.taskId || (task.local === "intercom" && task.requestedBy === senderOf(record));

// The newest intercom session this node started on its own for the sender of
// a message (issue #105), one that did not fail to start.
export const intercomFor = (paths: NodePaths, record: InboxRecord): TaskRecord | undefined =>
  listTasks(paths).filter((t) => t.local === "intercom" && t.requestedBy === senderOf(record) && t.state !== "failed")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

export type RequestState = "pending" | "dispatched" | "refused";
export interface TaskRequestRecord extends TaskRequestBody {
  createdAt: string; state: RequestState; taskId?: string; nodeId?: string; reason?: string;
  // The requesting session's id beside requestedBy, which may be its renameable
  // name, for the task message grant (wake-reply.mts, issue #264). Local, never
  // on the wire: client.mts requestTask picks the frame's fields explicitly.
  requestedBySessionId?: string;
}

export const ACTIVE_STATES: readonly TaskState[] = ["started", "running", "needs-input"];
export const isActive = (record: TaskRecord): boolean => ACTIVE_STATES.includes(record.state) || record.running === true;
export const hasActiveTask = (paths: NodePaths): boolean => listTasks(paths).some(isActive);

const fileOf = (dir: string, id: string): string => path.join(dir, `${id}.json`);

export function readTask(paths: NodePaths, taskId: string): TaskRecord | null {
  return isTaskId(taskId) ? readJson<TaskRecord>(fileOf(paths.tasks, taskId)) : null;
}

export function writeTask(paths: NodePaths, record: TaskRecord, now: number = Date.now()): TaskRecord {
  ensureDir(paths.tasks);
  const updated = { ...record, updatedAt: new Date(now).toISOString() };
  writeJsonAtomic(fileOf(paths.tasks, record.taskId), updated);
  return updated;
}

// Every readable task record; an unreadable file is skipped.
export function listTasks(paths: NodePaths): TaskRecord[] {
  return messageIds(paths.tasks).flatMap((id) => {
    try {
      const record = readTask(paths, id);
      return record ? [record] : [];
    } catch {
      return [];
    }
  });
}

// The task a local session was started for: by the session id `claude agents
// --json` reported (for Codex the thread id), by the task's session name that
// sessions.json records for the id before the mapping is known, or by the task
// name itself, which a Codex task session carries before its thread id is known.
export function taskForSession(paths: NodePaths, sessionId: string | undefined): TaskRecord | null {
  if (!sessionId) return null;
  let name: string | undefined;
  try {
    name = localSessionName(paths, sessionId);
  } catch {
    name = undefined;
  }
  return listTasks(paths).find((t) => t.local !== "resume"
    && (t.sessionId === sessionId || t.name === sessionId || (name !== undefined && t.name === name))) ?? null;
}

// How long a wake listener without a grant waits for a pending mapping (issue #109).
export const MAPPING_WINDOW_MS = 2 * 60_000;

export const mappingPendingAt = (record: TaskRecord, now: number): boolean =>
  record.mappingPendingSince !== undefined && now - Date.parse(record.mappingPendingSince) <= MAPPING_WINDOW_MS;

const realPath = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? realPath(a).toLowerCase() === realPath(b).toLowerCase() : realPath(a) === realPath(b);

// An active task or intercom session of this node in the directory cwd whose
// session id is still being mapped: a session there that has no grant yet may
// be that one, so its wake listener waits for the mapping instead of exiting.
export function mappingPending(paths: NodePaths, cwd: unknown, now: number): boolean {
  return typeof cwd === "string" && listTasks(paths).some((t) => t.local !== "resume" && isActive(t) && mappingPendingAt(t, now)
    && samePath(t.cwd, cwd));
}

export function queueReport(paths: NodePaths, body: TaskReportBody): void {
  if (isLocal(paths, body.taskId)) return;
  ensureDir(paths.taskReports);
  writeJsonAtomic(fileOf(paths.taskReports, crypto.randomUUID()), body);
}

function isLocal(paths: NodePaths, taskId: string): boolean {
  try {
    return readTask(paths, taskId)?.local !== undefined;
  } catch {
    return false;
  }
}

export function reportIds(paths: NodePaths): string[] {
  return messageIds(paths.taskReports);
}

export function readReport(paths: NodePaths, id: string): unknown {
  return readJson<unknown>(fileOf(paths.taskReports, id));
}

export function removeReport(paths: NodePaths, id: string): void {
  fs.rmSync(fileOf(paths.taskReports, id), { force: true });
}

export function writeRequest(paths: NodePaths, record: TaskRequestRecord): void {
  ensureDir(paths.taskRequests);
  writeJsonAtomic(fileOf(paths.taskRequests, record.requestId), record);
}

export function readRequest(paths: NodePaths, requestId: string): TaskRequestRecord | null {
  return isTaskId(requestId) ? readJson<TaskRequestRecord>(fileOf(paths.taskRequests, requestId)) : null;
}

export function requestIds(paths: NodePaths): string[] {
  return messageIds(paths.taskRequests);
}

// Issue #241: the task of this node's own task request whose session the
// directory lists as sessionId on nodeId. Neither the request result nor task
// control carries a task's session id; the target lists the session under the
// task-<8> name it started it with, so exactly one dispatched request on that
// node must carry a task id of that name. null when nothing matches uniquely.
export function ownedTaskForSession(paths: NodePaths, nodeId: string, sessionId: string): string | null {
  const listed = readDirectory(paths)?.sessions.filter((s) => s.nodeId === nodeId && s.sessionId === sessionId) ?? [];
  const name = listed.length === 1 ? listed[0].name : undefined;
  if (!name) return null;
  const owned = new Set(requestIds(paths).flatMap((id) => {
    try {
      const request = readRequest(paths, id);
      return request?.state === "dispatched" && request.nodeId === nodeId && request.taskId && taskSessionName(request.taskId) === name
        ? [request.taskId] : [];
    } catch {
      return [];
    }
  }));
  return owned.size === 1 ? [...owned][0] : null;
}
