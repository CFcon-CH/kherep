import { isCommandBody, isPhase1Command, isSessionCommand, parseEnvelope, PONG_FRAME } from "../protocol.mts";
import { isMessageReceiptBody, isMessageStatusBody } from "../protocol-messages.mts";
import { isTaskControlExecuteBody } from "../protocol-task-control.mts";

// Issue #493 D2: the inbound items a round's counters line reports, counted by
// kind. TALLY_KINDS is the only vocabulary the tally stores or prints: each
// label is a literal matched from a closed set of the protocol, or a fixed
// bucket. A received string never becomes a label, so the map stays bounded.
export const TALLY_KINDS = [
  "pong", "frame:invalid", "auth", "frame:event:receipt", "task-control:status", "task-control:stop", "frame:event",
  "command:node.status", "command:runtime.list", "command:session.list",
  "command:session.start", "command:session.stop", "command:session.continue", "command:unknown", "command:invalid",
  "frame:message.status:queued", "frame:message.status:accepted", "frame:message.status:delivered",
  "frame:message.status:replied", "frame:message.status:expired", "frame:message.status:refused", "frame:message.status:invalid",
  "frame:challenge", "frame:auth", "frame:register", "frame:capabilities.update", "frame:sessions.snapshot",
  "frame:command.ack", "frame:command.result", "frame:error", "frame:message.send", "frame:message.deliver",
  "frame:message.resolve.request", "frame:message.resolve.response",
  "frame:directory.get", "frame:directory", "frame:task.report", "frame:task.request",
  "frame:mcp.credential.rotate", "frame:mcp.credential", "frame:mcp.intent.register", "frame:mcp.intent.receipt",
  "frame:mcp.inbox.request", "frame:mcp.inbox.response",
  "frame:mcp.lead.confirm.request", "frame:mcp.lead.confirm.response",
  "unknown",
] as const;
export type TallyKind = (typeof TALLY_KINDS)[number];

// The member of TALLY_KINDS equal to a candidate built from validated fields, or `unknown`.
const member = (candidate: string): TallyKind => TALLY_KINDS.find((kind) => kind === candidate) ?? "unknown";

export function tallyKind(data: string): TallyKind {
  if (data === PONG_FRAME) return "pong";
  const parsed = parseEnvelope(data);
  if (!parsed.ok) return "frame:invalid"; // oversize, non-JSON, unknown type, bad envelope
  const { type, body } = parsed.envelope;
  if (type === "message.status") return isMessageStatusBody(body) ? member(`frame:message.status:${body.state}`) : "frame:message.status:invalid";
  if (type === "command") {
    if (!isCommandBody(body)) return "command:invalid";
    return isPhase1Command(body.command) || isSessionCommand(body.command) ? member(`command:${body.command}`) : "command:unknown";
  }
  if (type !== "event") return member(`frame:${type}`); // a MESSAGE_TYPES member: parseEnvelope admits no other
  if ((body as { name?: unknown }).name === "auth.ok") return "auth";
  if (isMessageReceiptBody(body)) return "frame:event:receipt";
  if (isTaskControlExecuteBody(body)) return member(`task-control:${body.action}`);
  return "frame:event";
}

export interface RoundTally {
  add(kind: string, count?: number): void;
  // The total and the top kinds as `<kind> <n>, ..., other <n>` since the previous call; resets.
  take(): { total: number; summary: string };
}

export const TALLY_TOP = 8;

export function roundTally(): RoundTally {
  const counts = new Map<TallyKind, number>();
  return {
    add(kind, count = 1) {
      const key = member(kind);
      counts.set(key, (counts.get(key) ?? 0) + count);
    },
    take() {
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      const top = [...counts].sort(([a, x], [b, y]) => y - x || TALLY_KINDS.indexOf(a) - TALLY_KINDS.indexOf(b)).slice(0, TALLY_TOP);
      const shown = top.reduce((sum, [, n]) => sum + n, 0);
      const parts = top.map(([kind, n]) => `${kind} ${n}`);
      if (total > shown) parts.push(`other ${total - shown}`);
      counts.clear();
      return { total, summary: parts.join(", ") };
    },
  };
}

// D2b: the socket error classes the disconnected line may name.
export const SOCKET_ERROR_CODES = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"] as const;
export type SocketErrorClass = (typeof SOCKET_ERROR_CODES)[number] | "unknown" | "missing";

// Reads only `event.error.code`: a listed code, `unknown` for another string,
// `missing` when absent or not a string. Never a message, reason, cause or URL.
export function classifySocketError(event: unknown): SocketErrorClass {
  const code = (event as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code !== "string") return "missing";
  return SOCKET_ERROR_CODES.find((known) => known === code) ?? "unknown";
}
