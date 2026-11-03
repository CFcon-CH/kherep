import { MessageReferenceResolver } from "./message-reference.mts";
import { wasGuardedMcpReply } from "./guarded-replies.mts";
import { isLoopAdmissionV1 } from "../protocol-loop-brake.mts";
import fs from "node:fs";
import path from "node:path";

import {
  isDirectoryBody, isMessageId, isMessageSendBody, type DirectoryBody, type MessageDeliverBody, type MessageProgress, type MessageSendBody,
} from "../protocol-messages.mts";
import type { ClientOptions, NodeClient, SentState } from "./client.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readLocalSessions } from "./exchange-sessions.mts";
import { markReported, messageIds, readJson, unreportedStatuses, writeJsonAtomic, type UnreportedStatus } from "./inbox.mts";
import { directoryDue, sendSchedule } from "./send-schedule.mts";
export {
  addLocalSession, localSessionName, readLocalSessions, recordingSessions, writeLocalSessions, type LocalSession,
} from "./exchange-sessions.mts";

// The local exchange between the daemon and the session tools (issue #31,
// step 3a): plain files in the node's config directory, no local socket.
//   outbox/<id>.json    written by the msg CLI, sent by the daemon
//   sent/<id>.json      moved there by the daemon, updated with every status
//   directory.json      the last directory frame
//   sessions.json       this node's sessions from the last successful listing
//   directory.request   touched by the msg CLI to ask for a fresh directory

export const EXCHANGE_INTERVAL_MS = 2_000;
export const DIRECTORY_INTERVAL_MS = 60_000;
// An outbox record the Worker has not answered is sent again on the same
// connection, first SEND_RETRY_MS after it went out and then with backoff, so a
// lost answer on a live connection heals without a reconnect (issues #195,
// #308). The Worker deduplicates by messageId.
export { SEND_RETRY_MS } from "./send-schedule.mts";

// depth: the reply depth (inbox.mts InboxRecord.depth); fromSessionId: the
// sender session's id where fromSession is its name (the reply grant,
// wake-reply.mts). Both stay local: toSendBody builds the frame without them.
export interface OutboxRecord extends MessageSendBody { createdAt: string; depth?: number; fromSessionId?: string; guarded?: true }
// A malformed outbox file leaves a sent record with only messageId and state error.
// noticedAt: when the delivery hook told the sending session that the message
// failed or was received (sent-notices.mts); a record is told at most once.
export type SentRecord = Partial<OutboxRecord> & {
  messageId: string; state: SentState; reason?: string; progress?: MessageProgress; updatedAt: string; noticedAt?: string;
};
// Issue #408, PR 4 (design r3 section 2.5): the send gate of proxy answers.
// allow decides at each send, resends included; sent is told each send.
export interface ProxySend { allow(record: OutboxRecord, now: number): boolean; sent(messageId: string): void }

const fileOf = (dir: string, messageId: string): string => path.join(dir, `${messageId}.json`);

const SENT_RANK: Partial<Record<SentState, number>> = { queued: 0, accepted: 1, delivered: 2, replied: 3 };

function mayAdvanceSent(from: SentState, to: SentState): boolean {
  if (from === to || from === "refused" || from === "expired" || from === "error" || from === "replied") return false;
  if (to === "refused") return from === "queued" || from === "accepted";
  if (to === "expired") return from === "queued";
  if (to === "error") return false;
  const current = SENT_RANK[from];
  const next = SENT_RANK[to];
  return current !== undefined && next !== undefined && next > current;
}

function receiptSettles(requested: "accepted" | "delivered" | "refused", stored: SentState): boolean {
  if (requested === "refused") return stored === "delivered" || stored === "replied" || stored === "expired" || stored === "refused";
  const current = SENT_RANK[requested];
  const durable = SENT_RANK[stored];
  if (current !== undefined && durable !== undefined && durable >= current) return true;
  return stored === "refused" || stored === "expired";
}

export function writeOutbox(paths: NodePaths, record: OutboxRecord): void {
  ensureDir(paths.outbox);
  writeJsonAtomic(fileOf(paths.outbox, record.messageId), record);
}

export function getOutbox(paths: NodePaths, messageId: string): OutboxRecord | null {
  return readJson<OutboxRecord>(fileOf(paths.outbox, messageId));
}

export function getSent(paths: NodePaths, messageId: string): SentRecord | null {
  return readJson<SentRecord>(fileOf(paths.sent, messageId));
}

// Moves an outbox record to sent/ with the given state, or updates the state
// of one already there. Returns false for a message this node does not know.
export function recordSent(paths: NodePaths, messageId: string, state: SentState, reason?: string, now: number = Date.now(),
  progress?: MessageProgress): boolean {
  let pending: OutboxRecord | null = null;
  try {
    pending = getOutbox(paths, messageId);
  } catch {
    // unparseable outbox file: replaced by a bare record below
  }
  const outboxExists = fs.existsSync(fileOf(paths.outbox, messageId));
  const recorded = getSent(paths, messageId);
  const base: Partial<SentRecord> | null = pending ?? recorded ?? (outboxExists ? { messageId } : null);
  if (!base) return false;
  if (recorded && !mayAdvanceSent(recorded.state, state)) {
    if (recorded.state === "accepted" && state === "accepted" && progress
      && (!recorded.progress || Date.parse(progress.observedAt) > Date.parse(recorded.progress.observedAt))) {
      writeJsonAtomic(fileOf(paths.sent, messageId), { ...recorded, progress, updatedAt: new Date(now).toISOString() });
    }
    if (outboxExists) fs.rmSync(fileOf(paths.outbox, messageId), { force: true });
    return true;
  }
  const { state: _state, reason: _reason, progress: _progress, updatedAt: _updated, ...message } = base;
  ensureDir(paths.sent);
  writeJsonAtomic(fileOf(paths.sent, messageId),
    { ...message, messageId, state, ...(reason ? { reason } : {}), ...(state === "accepted" && progress ? { progress } : {}),
      updatedAt: new Date(now).toISOString() });
  if (outboxExists) fs.rmSync(fileOf(paths.outbox, messageId), { force: true });
  return true;
}

// The depth of an arriving message: one more than this node's sent message it
// answers, 0 for a new message or an answer to something this node did not send.
export function replyDepth(paths: NodePaths, inReplyTo: string | undefined): number {
  if (!inReplyTo || !isMessageId(inReplyTo)) return 0;
  try {
    const sent = getSent(paths, inReplyTo);
    return sent ? (sent.depth ?? 0) + 1 : 0;
  } catch {
    return 0;
  }
}

// A delivered reply or proxy answer (issue #408) is one hop deeper than the
// message of this node it answers.
export function deliveryDepth(paths: NodePaths, body: MessageDeliverBody): number {
  if (Object.hasOwn(body, "loop")) {
    if (!isLoopAdmissionV1(body.loop)) throw new Error("invalid loop admission");
    return body.loop.depth;
  }
  const parent = body.proxyOf ?? body.inReplyTo;
  if (parent && wasGuardedMcpReply(paths, parent)) throw new Error("loop-lineage-unavailable");
  let sent: SentRecord | null = null;
  try { sent = parent ? getSent(paths, parent) : null; } catch { /* legacy fail-soft reconstruction remains below */ }
  if (sent?.guarded) throw new Error("loop-lineage-unavailable");
  return replyDepth(paths, parent);
}

export function markNoticed(paths: NodePaths, messageId: string, now: number = Date.now()): void {
  const record = getSent(paths, messageId);
  if (record) writeJsonAtomic(fileOf(paths.sent, messageId), { ...record, noticedAt: new Date(now).toISOString() });
}

export function writeDirectory(paths: NodePaths, body: DirectoryBody): void {
  ensureDir(paths.dir);
  writeJsonAtomic(paths.directory, body);
}

// null when the file is missing or not a valid directory.
export function readDirectory(paths: NodePaths): DirectoryBody | null {
  const value = readJson<unknown>(paths.directory);
  return isDirectoryBody(value) ? value : null;
}

export function requestDirectory(paths: NodePaths): void {
  ensureDir(paths.dir);
  fs.writeFileSync(paths.directoryRequest, "", { mode: 0o600 });
}

function takeDirectoryRequest(paths: NodePaths): boolean {
  try {
    fs.rmSync(paths.directoryRequest);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// The client callbacks that record directory frames and sent states, and read
// the local session listing for the messaging policy.
export function exchangeOptions(paths: NodePaths, now: () => number = Date.now):
  Pick<ClientOptions, "storeDirectory" | "sentUpdate" | "receiptUpdate" | "localSessions" | "selectedReferences"> {
  return {
    selectedReferences: new MessageReferenceResolver(paths, now),
    storeDirectory: (body) => writeDirectory(paths, body),
    sentUpdate: (messageId, state, reason, progress) => { recordSent(paths, messageId, state, reason, now(), progress); },
    receiptUpdate: (body) => {
      if ((body.requestedState === "accepted" || body.requestedState === "delivered" || body.requestedState === "refused")
        && receiptSettles(body.requestedState, body.storedState)) {
        markReported(paths.inbox, body.messageId, body.requestedState, body.storedState, now(), body.storedProgressAt);
      }
    },
    localSessions: () => readLocalSessions(paths),
  };
}

function toSendBody(record: OutboxRecord): MessageSendBody | null {
  const body: MessageSendBody = { messageId: record.messageId, fromSession: record.fromSession, to: record.to, text: record.text,
    ...(record.inReplyTo ? { inReplyTo: record.inReplyTo } : {}), ...(record.proxyOf ? { proxyOf: record.proxyOf } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.senderSentAt === undefined ? {} : { senderSentAt: record.senderSentAt }) };
  return isMessageSendBody(body) ? body : null;
}

// A status report's identity: a new state or new progress is a new report.
function reportKey(record: { messageId: string; state: string; progress?: MessageProgress }): string {
  return `${record.messageId} ${record.state} ${record.progress?.observedAt ?? ""}`;
}

// One exchange round while connected: a requested directory refresh, unless
// this connection asked within DIRECTORY_COALESCE_MS (the request then waits),
// every outbox record that is due, and the status of every inbox record not
// yet confirmed by a receipt. inflight maps each outbox record to the time it
// last went out on this connection; the backoff schedule (send-schedule.mts)
// lives beside it. A status report is due at once for each new (state,
// progress), later with the same backoff. send returns false when the socket
// is gone; nothing counts as sent or reported unless it went out. A proxy
// answer (proxyOf) goes out only when proxySend allows it at that moment;
// without proxySend it is held. Issue #487: the daemon passes its inbox index
// as unreported, and counts adds up the status and outbox frames sent (D1).
export interface ExchangeCounts { status: number; outbox: number }
export interface ExchangeSources { unreported?: (now: number) => UnreportedStatus[]; counts?: ExchangeCounts }
export function pollExchange(client: NodeClient, paths: NodePaths, inflight: Map<string, number>, send: (frame: string) => boolean,
  now: number = Date.now(), random: () => number = Math.random, proxySend?: ProxySend, sources: ExchangeSources = {}): void {
  const counts = sources.counts ?? { status: 0, outbox: 0 };
  const sendAll = (frames: string[]): boolean => frames.length > 0 && frames.every(send);
  const schedule = sendSchedule(inflight);
  if (directoryDue(schedule, now) && takeDirectoryRequest(paths) && sendAll(client.directoryRequest())) schedule.directorySentAt = now;
  const outbox = messageIds(paths.outbox);
  const listed = new Set(outbox);
  // A record that left the outbox was answered: it starts over if it comes back.
  for (const messageId of inflight.keys()) if (!listed.has(messageId)) inflight.delete(messageId);
  schedule.outbox.retain(inflight.keys());
  for (const messageId of outbox) {
    if (!schedule.outbox.due(messageId, now)) continue;
    let record: OutboxRecord | null | undefined;
    try {
      record = getOutbox(paths, messageId);
    } catch {
      record = undefined; // not JSON
    }
    if (record === null) continue; // gone since the listing
    const body = record ? toSendBody(record) : null;
    if (!body || body.messageId !== messageId) {
      recordSent(paths, messageId, "error", "invalid outbox record");
      continue;
    }
    if (body.proxyOf && !proxySend?.allow(record!, now)) continue;
    // The Worker deduplicates by messageId, so a resend is safe.
    if (sendAll(client.sendMessage(body))) {
      inflight.set(messageId, now);
      schedule.outbox.sent(messageId, now, random);
      if (body.proxyOf) proxySend?.sent(messageId);
      counts.outbox++;
    }
  }
  const pending = sources.unreported?.(now) ?? unreportedStatuses(paths.inbox, now);
  schedule.reports.retain(pending.map(reportKey));
  for (const record of pending) {
    const key = reportKey(record);
    if (schedule.reports.due(key, now) && sendAll(client.reportStatus(record.messageId, record.state, record.reason, record.progress))) {
      schedule.reports.sent(key, now, random);
      counts.status++;
    }
  }
}
