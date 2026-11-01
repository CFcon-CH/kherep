import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SessionInfo } from "../protocol.mts";
import { isTaskId, SUPPORTED_RUNTIMES, type TaskRuntime } from "../protocol-tasks.mts";
import {
  isMessageId, isMessageProgress, isSessionRef, MAX_REPLY_DEPTH, type MessageAddress, type MessageDeliverBody, type MessageProgress, type MessageState, type MessageStatusBody,
} from "../protocol-messages.mts";
export { MAX_REPLY_DEPTH } from "../protocol-messages.mts";
import { ensureDir } from "./config.mts";
import { RecordLockBusy, withRecordLock } from "./inbox-record-lock.mts";

// The node inbox (issue #31, step 2): one JSON file per accepted message,
// <messageId>.json, in a directory only this user can read. Delivery into a
// session reads it through list/get and reports markDelivered.
// Local states: accepted (stored), offered (handed to a turn that has not
// confirmed it yet; never sent to the Worker), delivered and refused (each
// retried until the Worker returns a persistence receipt).

export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60_000;
// A waiting message for a session that a successful listing does not show is
// refused this long after it arrived.
export const UNDELIVERABLE_AFTER_MS = 60 * 60_000;
// A message at this reply depth or deeper wakes no session and asks for no
// automatic answer (see InboxRecord.depth).
export const PROGRESS_RETRY_BACKOFF_MS = 60_000;

export interface InboxRecord {
  messageId: string;
  from: MessageAddress;
  toSession: string;
  text: string;
  inReplyTo?: string;
  // Issue #408: a proxy answer to this node's message (never with inReplyTo).
  proxyOf?: string;
  // Item 5: the task the message belongs to (task grant of the wake listener).
  taskId?: string;
  // The local task that performed delivery. Separate from the authorization grant above.
  delivery?: DeliveryTaskIdentity;
  createdAt: string;
  receivedAt: string;
  state: "accepted" | "offered" | "delivered" | "refused";
  reason?: string;
  // Set by the delivery hook each time it hands the message to a turn.
  offers?: number;
  offeredAt?: string;
  // Which path made the last offer (issue #417), written with offeredAt.
  offeredBy?: OfferedBy;
  // Set by StopFailure: the turn that carried the offer ended on an API error,
  // so the next UserPromptSubmit offers it again at once.
  retry?: boolean;
  // Codex-only exact-offer generation. Shared/Claude writers never create it.
  codexOffer?: { owner: string; generation: string; fingerprint: string };
  // Reply hops: 0 for a new message, one more than the depth of this node's
  // sent message it answers (exchange.mts replyDepth). Missing means 0.
  depth?: number;
  // Set by closed-delivery.mts (issues #102, #105) when the message was handed
  // to an intercom session of its sender, reused or new: once per message.
  closedAttempt?: string;
  // The closed session the message was sent to, when closed-delivery.mts
  // handed it to the sender's intercom session (issue #105).
  closedTo?: string;
}

// Which path handed the record to a turn (issue #417). Written with offeredAt.
export type OfferedBy =
  | "wake"         // Claude Code: UserPromptSubmit of a turn the wake listener opened (woke marker claimed)
  | "prompt"       // Claude Code: UserPromptSubmit otherwise (user prompt, queued prompt, resumed intercom's wake prompt)
  | "stop"         // Claude Code: Stop continuation of a running turn (mayContinue allowed it)
  | "tool"         // Claude Code: PostToolUse inside the running turn
  | "codex-prompt" // Codex hook: UserPromptSubmit
  | "receive"      // msg inbox --receive (Codex Stop continuation)
  | "codex-wake"   // daemon: codex exec resume of an ended Codex task for its messages (codex-wake.mts)
  | "intercom"     // daemon: closed-session fallback, new or resumed Codex intercom session (closed-resume.mts)
  | "mcp";         // daemon: an MCP inbox read returned the record (mcp-local.mts)

// The local states the daemon reports to the Worker. An offered message remains
// accepted in the cloud until the turn confirms delivery.
export type ReportedState = "accepted" | "delivered" | "refused";
export interface ReceiptRecord { reportedAt: string; reportedState: ReportedState; workerState: MessageState; reportedProgressAt?: string; progressRetryAt?: string }

export interface DeliveryTaskIdentity { taskId: string; runtime: TaskRuntime; sessionId?: string }

function fileOf(dir: string, messageId: string): string {
  return path.join(dir, `${messageId}.json`);
}

export function receiptFileOf(dir: string, messageId: string): string {
  return path.join(dir, "receipts", `${messageId}.json`);
}

export function progressFileOf(dir: string, messageId: string): string {
  return path.join(dir, "progress", `${messageId}.json`);
}

// Issue #408: the proxied sidecar (inbox-proxied.mts). Here, so that this
// module stays inside the closed graph of the staged messaging client.
export function proxiedFileOf(dir: string, messageId: string): string {
  if (!isMessageId(messageId)) throw new Error("invalid message id");
  return path.join(dir, "proxied", `${messageId}.json`);
}

// Issue #540: on Windows a replace-by-rename fails with EPERM, EBUSY or EACCES
// while another process holds the target (or the temp) open. There it is
// retried after these pauses, 8 attempts and 1.27 s at most; the last error is
// rethrown unchanged. Every other platform and code gets a single attempt.
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640];
const RETRYABLE_WIN32_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
export interface RenameDeps { platform?: NodeJS.Platform; sleep?: (ms: number) => void }

export function renameReplacing(temp: string, file: string, deps: RenameDeps = {}): void {
  const { platform = process.platform, sleep = pause } = deps;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (platform !== "win32" || attempt === RENAME_RETRY_DELAYS_MS.length
        || !RETRYABLE_WIN32_RENAME.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Temp file plus rename, so a reader never sees a half-written record. Also
// used for the other files the daemon and the session tools exchange. The temp
// is removed only after the last rename attempt.
export function writeJsonAtomic(file: string, value: unknown, deps: RenameDeps = {}): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameReplacing(temp, file, deps);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// Stores a delivered message. Idempotent: a redelivery of a stored id keeps
// the existing file. Throws when the record cannot be written.
export function storeMessage(dir: string, body: MessageDeliverBody, now: number = Date.now(), depth = 0): InboxRecord {
  const existing = getMessage(dir, body.messageId);
  if (existing) return existing;
  ensureDir(dir);
  const record: InboxRecord = {
    messageId: body.messageId, from: { nodeId: body.from.nodeId, session: body.from.session }, toSession: body.toSession,
    text: body.text, ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}),
    ...(body.proxyOf ? { proxyOf: body.proxyOf } : {}), ...(body.taskId ? { taskId: body.taskId } : {}),
    createdAt: body.createdAt,
    receivedAt: new Date(now).toISOString(), state: "accepted", depth,
  };
  writeJsonAtomic(fileOf(dir, body.messageId), record);
  return record;
}

// The parsed file, or null when it does not exist. Other errors throw.
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function getMessage(dir: string, messageId: string): InboxRecord | null {
  return isMessageId(messageId) ? readJson<InboxRecord>(fileOf(dir, messageId)) : null;
}

export function getReceipt(dir: string, messageId: string): ReceiptRecord | null {
  return isMessageId(messageId) ? readJson<ReceiptRecord>(receiptFileOf(dir, messageId)) : null;
}

export function getMessageProgress(dir: string, messageId: string): MessageProgress | null {
  if (!isMessageId(messageId)) return null;
  const value = readJson<unknown>(progressFileOf(dir, messageId));
  return isMessageProgress(value) ? value : null;
}

// Progress is daemon-owned metadata in a sidecar. Delivery hooks keep sole
// ownership of the message body file, so a stale progress writer cannot
// restore accepted over a newer offered or delivered state.
export function setMessageProgress(dir: string, messageId: string, phase: MessageProgress["phase"], code: MessageProgress["code"],
  now: number = Date.now(), retryAt?: number): MessageProgress | null {
  const record = getMessage(dir, messageId);
  if (!record || (record.state !== "accepted" && record.state !== "offered")) return null;
  const previous = getMessageProgress(dir, messageId);
  const previousAt = Date.parse(previous?.observedAt ?? "");
  const requestedRetryAt = retryAt === undefined ? undefined
    : new Date(Math.max(retryAt, now, Number.isNaN(previousAt) ? now : previousAt)).toISOString();
  if (previous?.phase === phase && previous.code === code && previous.retryAt === requestedRetryAt) return previous;
  const observedMs = Math.max(now, Number.isNaN(previousAt) ? now : previousAt + 1);
  const observedAt = new Date(observedMs).toISOString();
  const nextRetryAt = retryAt === undefined ? undefined : new Date(Math.max(retryAt, observedMs)).toISOString();
  const progress: MessageProgress = { phase, code, observedAt, ...(nextRetryAt ? { retryAt: nextRetryAt } : {}) };
  ensureDir(path.dirname(progressFileOf(dir, messageId)));
  writeJsonAtomic(progressFileOf(dir, messageId), progress);
  return progress;
}

// The message ids of the <messageId>.json files in a directory.
export function messageIds(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter(isMessageId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Records oldest first, optionally only those for one session.
export function listInbox(dir: string, toSession?: string): InboxRecord[] {
  return messageIds(dir).map((id) => getMessage(dir, id)).filter((r): r is InboxRecord => r !== null)
    .filter((r) => toSession === undefined || r.toSession === toSession)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

// Every rewrite of a record body: read, judge and write under the record's lock
// (issue #627). change judges the record the file holds now, never a caller's
// copy; null leaves it as it is. A busy lock throws RecordLockBusy from
// setDeliveryTask and markClosedAttempt; their daemon callers skip that record
// or leave it to a later round (closed-delivery.mts, task-watch.mts). The other
// writers report "not written" (tryUpdate).
type Update = { record: InboxRecord; written: boolean } | null;
function updateRecord(dir: string, messageId: string, change: (record: InboxRecord) => InboxRecord | null): Update {
  if (!isMessageId(messageId)) return null;
  return withRecordLock(dir, messageId, () => {
    const record = getMessage(dir, messageId);
    if (!record) return null;
    const next = change(record);
    if (next) writeJsonAtomic(fileOf(dir, messageId), next);
    return { record: next ?? record, written: next !== null };
  });
}

// A busy record is "not written": the next event, round or read writes it
// again (a repeated offer at worst, never a lost one).
function tryUpdate(dir: string, messageId: string, change: (record: InboxRecord) => InboxRecord | null): Update {
  try {
    return updateRecord(dir, messageId, change);
  } catch (error) {
    if (error instanceof RecordLockBusy) return null;
    throw error;
  }
}

// Associates a message with the local execution that delivered it. This does
// not change taskId, which remains the authorization grant from the sender.
export function setDeliveryTask(dir: string, messageId: string, identity: DeliveryTaskIdentity): boolean {
  if (!isTaskId(identity.taskId) || !SUPPORTED_RUNTIMES.includes(identity.runtime)
    || (identity.sessionId !== undefined && !isSessionRef(identity.sessionId))) {
    throw new Error("invalid delivery task identity");
  }
  return updateRecord(dir, messageId, (record) => ({ ...record, delivery: identity })) !== null;
}
// Marks a stored message as delivered into its session and returns the
// message.status body to send, or null when the message is not in the inbox
// or stayed locked (the next Stop confirms it again).
export function markDelivered(dir: string, messageId: string): MessageStatusBody | null {
  const updated = tryUpdate(dir, messageId, (record) => record.state === "delivered" ? null : { ...record, state: "delivered" });
  return updated ? { messageId, state: "delivered" } : null;
}

// A reply this node sends to a waiting message (msg send --reply-to) shows it
// was read, whether or not a turn offered it (issue #111).
export function markAnswered(dir: string, messageId: string): void {
  tryUpdate(dir, messageId, (record) => record.state === "accepted" || record.state === "offered" ? { ...record, state: "delivered" } : null);
}

// Records that the hook handed the message to a turn, which confirms it at
// its Stop. Returns the updated record, or null when it is not in the inbox,
// no longer waits or stayed locked: the caller then does not show it (deliver-core.mts).
export function markOffered(dir: string, messageId: string, now: number = Date.now(), offeredBy?: OfferedBy): InboxRecord | null {
  const updated = tryUpdate(dir, messageId, (record) => {
    if (record.state !== "accepted" && record.state !== "offered") return null;
    const { retry: _retry, ...rest } = record;
    return { ...rest, state: "offered", offers: (record.offers ?? 0) + 1, offeredAt: new Date(now).toISOString(), ...(offeredBy ? { offeredBy } : {}) };
  });
  return updated?.written ? updated.record : null;
}

// Flags an offered message for an immediate new offer; false when it is not
// offered or stayed locked (it is offered again after REOFFER_AFTER_MS instead).
export function markRetry(dir: string, messageId: string): boolean {
  return tryUpdate(dir, messageId, (record) => record.state === "offered" ? { ...record, retry: true } : null)?.written ?? false;
}

// toSession hands the message to another session of this node, the intercom
// session of its sender (issue #105); closedTo keeps the session it was sent to.
export function markClosedAttempt(dir: string, messageId: string, now: number = Date.now(), toSession?: string): void {
  updateRecord(dir, messageId, (record) => {
    const moved = toSession !== undefined && toSession !== record.toSession ? { toSession, closedTo: record.toSession } : {};
    return { ...record, ...moved, closedAttempt: new Date(now).toISOString() };
  });
}

// Refuses a message that still waits for its session; true when it did, false
// when it did not wait, is not in the inbox or stayed locked (the next round
// judges it again). still: judged on the file under its lock, not on a
// caller's copy (#589, #627); it runs inside the lock and must stay pure: no
// other record lock, no inbox write.
export function markRefused(dir: string, messageId: string, reason: string, still = (r: InboxRecord): boolean => r.state === "accepted" || r.state === "offered"): boolean {
  return tryUpdate(dir, messageId, (record) => still(record) ? { ...record, state: "refused", reason } : null)?.written ?? false;
}

// Local progress that needs a persistence receipt. offered is intentionally
// local-only and therefore continues to report accepted until delivered.
function reportState(record: InboxRecord): ReportedState | null {
  if (record.state === "accepted" || record.state === "offered") return "accepted";
  return record.state === "delivered" || record.state === "refused" ? record.state : null;
}

// records and receiptOf: the daemon's index (inbox-index.mts, issue #487)
// supplies both; every other caller reads the files.
export type UnreportedStatus = InboxRecord & { state: ReportedState; progress?: MessageProgress };
export function unreportedStatuses(dir: string, now: number = Date.now(), records: InboxRecord[] = listInbox(dir),
  receiptOf: (record: InboxRecord) => ReceiptRecord | null = (record) => getReceipt(dir, record.messageId)): UnreportedStatus[] {
  return records.flatMap((record) => {
    const state = reportState(record);
    if (!state) return [];
    const receipt = receiptOf(record);
    const statePending = receipt?.reportedState !== state;
    const progress = state === "accepted" ? getMessageProgress(dir, record.messageId) : null;
    const reportedProgressAt = Date.parse(receipt?.reportedProgressAt ?? "");
    const progressPending = progress !== null
      && (Number.isNaN(reportedProgressAt) || reportedProgressAt < Date.parse(progress.observedAt))
      && now >= Date.parse(receipt?.progressRetryAt ?? new Date(0).toISOString());
    return statePending || progressPending ? [{ ...record, state, ...(progress ? { progress } : {}) }] : [];
  });
}

export function markReported(dir: string, messageId: string, state: ReportedState, workerState: MessageState,
  now: number = Date.now(), storedProgressAt?: string): void {
  const record = getMessage(dir, messageId);
  if (!record || reportState(record) !== state) return;
  const existing = getReceipt(dir, messageId);
  const progress = state === "accepted" ? getMessageProgress(dir, messageId) : null;
  const coversProgress = progress !== null && storedProgressAt !== undefined
    && Date.parse(storedProgressAt) >= Date.parse(progress.observedAt);
  const progressPending = progress !== null && !coversProgress;
  ensureDir(path.dirname(receiptFileOf(dir, messageId)));
  writeJsonAtomic(receiptFileOf(dir, messageId), {
    reportedAt: new Date(now).toISOString(), reportedState: state, workerState,
    ...(coversProgress ? { reportedProgressAt: progress.observedAt } : existing?.reportedProgressAt
      ? { reportedProgressAt: existing.reportedProgressAt } : {}),
    ...(progressPending && storedProgressAt === undefined
      ? { progressRetryAt: new Date(now + PROGRESS_RETRY_BACKOFF_MS).toISOString() } : {}),
  } satisfies ReceiptRecord);
}

// Positive terminal metadata may refuse an unlisted target. Absence, even
// after the legacy age bound, is not proof. Recheck the exact current address
// and message state under the existing record lock. Returns the refused IDs.
export function refuseUndeliverable(dir: string, sessions: SessionInfo[], now: number = Date.now(),
  afterMs: number = UNDELIVERABLE_AFTER_MS, records: InboxRecord[] = listInbox(dir),
  terminal: (ref: string) => boolean = () => false, closed: (ref: string) => boolean = () => false): string[] {
  const live = new Set(sessions.filter(s => !["closed", "archived", "deleted"].includes(s.state))
    .flatMap((s) => s.name ? [s.sessionId, s.name] : [s.sessionId]));
  const since = (r: InboxRecord): number => Date.parse((r.closedTo && r.closedAttempt) || r.receivedAt);
  const refusable = (r: InboxRecord): boolean => (r.state === "accepted" || r.state === "offered") && !live.has(r.toSession)
    && (terminal(r.toSession) || now - since(r) > afterMs && closed(r.toSession));
  return records.filter(refusable).filter((r) => markRefused(dir, r.messageId, "target session not running", refusable))
    .map((r) => r.messageId);
}
