import { isMessageDiagnostic, renderMessageDiagnostic } from "../protocol-diagnostics.mts";
import { ACCEPTED_SILENCE_CAUSES, isMessageId, senderState, silentlyAccepted } from "../protocol-messages.mts";
import { getOutbox, getSent, type SentRecord } from "./exchange.mts";
import { getMessage, getMessageDiagnostic, getMessageProgress } from "./inbox.mts";
import type { Io } from "./msg-cli.mts";
import { offerLine, replyLines } from "./msg-inbox.mts";
import { targetLine } from "./msg-intake.mts";
import { directoryFor } from "./msg-sessions.mts";

function fail(io: Io, message: string): number { io.err(`kherep-node msg: ${message}`); return 1; }

const PROGRESS_TEXT: Record<string, string> = {
  "awaiting-user-turn": "waiting for the target session's next turn; delivery is not confirmed",
  "awaiting-turn-confirmation": "the target turn received it and has not confirmed completion",
  "target-busy": "the target session is busy",
  "wake-unconfirmed": "the automatic wake was not confirmed; start the target turn to retry delivery",
  "retry-pending": "delivery is waiting to retry",
  "wake-disabled": "automatic wake is disabled on the target node; start the target turn to retry delivery",
  "wake-not-authorized": "the target node's policy did not authorize automatic delivery; start the target turn to retry delivery",
  "permission-restricted": "the target permission mode blocks automatic wake; start the target turn to retry delivery",
  "operator-stopped": "the target session was stopped by its operator and requires an explicit continue",
  "reply-limit": "the automatic reply depth limit was reached",
  "budget-exhausted": "the target's autonomous-turn budget is exhausted",
  "ambiguous-target": "the target session name is ambiguous; send to its full session id",
  "cwd-refused": "the last closed-session delivery attempt was refused: the closed session's working directory is not usable on the "
    + "target node (not absolute, missing, or outside its workspace roots); the message stays queued and is tried again each round",
  "wake-pending": "awaiting automatic wake confirmation",
  "fallback-starting": "a local delivery session is starting",
  "fallback-running": "a local delivery session is running",
  "wake-failed": "the automatic wake failed; start the target turn to retry delivery",
  "fallback-failed": "the local delivery session failed; delivery is not confirmed",
};

// The sender state (accepted, running, stopped, ...) with its reason (issue #197).
export function stateText(record: SentRecord, now: number): string {
  const state = senderState(record.state, record.progress);
  if (silentlyAccepted(record.state, record.progress, Date.parse(record.updatedAt), now)) {
    return `${state}: no delivery progress from the target node since ${record.updatedAt}; ${ACCEPTED_SILENCE_CAUSES}; check \`kherep-node msg sessions\``;
  }
  return `${state}${progressText(record, now)}`;
}

function progressText(record: Pick<SentRecord, "progress" | "reason" | "diagnostic">, now: number): string {
  if (!record.progress) return record.reason ? `: ${record.reason}` : "";
  const retryAt = record.progress.retryAt;
  const expired = record.progress.code === "budget-exhausted" && retryAt && Date.parse(retryAt) <= now;
  const retry = retryAt ? expired ? `; retry time ${retryAt} has elapsed; current hold unknown` : `; retry after ${retryAt}` : "";
  const label = isMessageDiagnostic(record.diagnostic) ? "" : `: ${PROGRESS_TEXT[record.progress.code]}`;
  return `${label} [${record.progress.phase}/${record.progress.code}; observed ${record.progress.observedAt}${retry}]`;
}

export function status(io: Io, messageId: string): number {
  if (!isMessageId(messageId)) return fail(io, `not a message id: "${messageId}"`);
  const sent = getSent(io.paths, messageId);
  if (sent) {
    io.out(`${messageId} ${stateText(sent, io.now())} (updated ${sent.updatedAt})`);
    if (isMessageDiagnostic(sent.diagnostic)) io.out(renderMessageDiagnostic(sent.diagnostic, sent.state));
    // Issue #441: while queued, whether its target node takes its messages.
    if (sent.state === "queued" && sent.to?.nodeId) io.out(targetLine(directoryFor(io), sent.to.nodeId, io.now()));
    if (!isMessageDiagnostic(sent.diagnostic) && (sent.state === "queued"
      || sent.state === "accepted" && (!sent.progress || ["retry-pending", "target-busy"].includes(sent.progress.code)))) io.out(renderMessageDiagnostic(null, sent.state));
    for (const line of replyLines(io.paths, sent)) io.out(line);
    return 0;
  }
  if (getOutbox(io.paths, messageId)) {
    io.out(`${messageId} pending: no control-plane confirmation received`);
    return 0;
  }
  // Issue #417: a message this node received.
  const received = getMessage(io.paths.inbox, messageId);
  if (received) {
    const diagnostic = getMessageDiagnostic(io.paths.inbox, messageId);
    const progress = getMessageProgress(io.paths.inbox, messageId);
    // A delivered message keeps its progress file; what it waited for is over.
    // Progress older than the offer describes a wait the offer ended; without a
    // readable offer time nothing says it ended.
    const offeredAt = Date.parse(received.offeredAt ?? "");
    const live = received.state === "accepted"
      || received.state === "offered" && (!progress || Number.isNaN(offeredAt) || Date.parse(progress.observedAt) >= offeredAt);
    io.out(`${messageId} ${received.state}${live ? progressText({ progress: progress ?? undefined,
      diagnostic: diagnostic ?? undefined }, io.now()) : ""} (received ${received.receivedAt})`);
    if (diagnostic) io.out(renderMessageDiagnostic(diagnostic, received.state));
    for (const line of offerLine(received)) io.out(line);
    if (!diagnostic && live
      && (!progress || ["retry-pending", "target-busy"].includes(progress.code))) io.out(renderMessageDiagnostic(null, received.state));
    return 0;
  }
  return fail(io, `unknown message ${messageId}: not in the outbox, sent messages or inbox of this node`);
}
