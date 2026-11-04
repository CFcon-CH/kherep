import { RESOLUTION_REQUIRED } from "../../protocol-message-binding.mts";
import { LOOP_STALE } from "../../protocol-loop-brake.mts";
import { storedMessageBinding } from "./message-binding-store.mts";
import type { NewMessage, PreparedLoop } from "./message-store.mts";
type Row = Record<string, SqlStorageValue>;

// Payload-bearing retries prove the current selected owners. Status queries
// remain separate and never turn into new admission or delivery authority.
export function duplicateSendError(row: Row, message: NewMessage, prepared: PreparedLoop | undefined, contextMatches: boolean): string | null {
  if (row.from_node !== message.from.nodeId) return "duplicate messageId";
  const stored = storedMessageBinding(row);
  if (stored === "invalid") return RESOLUTION_REQUIRED;
  if (!stored) return null; // Existing unbound compatibility is unchanged.
  if (prepared?.error || prepared?.binding?.error) return prepared.error ?? prepared.binding!.error!;
  if (!contextMatches) return LOOP_STALE;
  const selected = prepared?.binding;
  if (!selected?.binding) return RESOLUTION_REQUIRED;
  if (row.to_node !== message.to.nodeId || JSON.stringify(stored) !== JSON.stringify(selected.binding)
    || row.delivery_pair !== selected.denyKey || row.in_reply_to !== (message.inReplyTo ?? null)
    || row.proxy_of !== (message.proxyOf ?? null) || row.task_id !== (message.taskId ?? null)
    || row.text !== null && row.text !== message.text) return "duplicate messageId";
  return null;
}

// The MCP registry has already verified the native claimant and argument digest.
// Recovery reads only a live row's source; it does not resolve its destination.
export function recoveryOwnerError(row: Row, nodeId: string, sessionId: string, runtime: string): string | null {
  if (row.from_node !== nodeId || row.from_session !== sessionId) return "duplicate messageId";
  const binding = storedMessageBinding(row);
  if (binding === "invalid") return RESOLUTION_REQUIRED;
  return binding && (binding.from.sessionId !== sessionId || binding.from.runtime !== runtime) ? "duplicate messageId" : null;
}

// An authenticated intent proves its actual arguments, not a same-ID row.
// Body erasure is safe only while the original production digest survives.
export function recoveryPayloadError(row: Row, message: NewMessage, fingerprint: string): string | null {
  if (row.from_node !== message.from.nodeId || row.from_session !== message.from.session
    || row.to_node !== message.to.nodeId || row.to_session !== message.to.session
    || row.in_reply_to !== (message.inReplyTo ?? null) || row.proxy_of !== (message.proxyOf ?? null)
    || row.task_id !== (message.taskId ?? null)) return "duplicate messageId";
  if ((row.sender_sent_at ?? null) !== (message.senderOrigin?.sentAt ?? null)) return "conflicting message binding";
  if (row.message_binding != null) {
    if (typeof row.message_binding !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.message_binding)) return "message binding unavailable";
    return row.message_binding === fingerprint ? null : "conflicting message binding";
  }
  if (typeof row.text !== "string") return "message binding unavailable";
  return row.text === message.text ? null : "conflicting message binding";
}
