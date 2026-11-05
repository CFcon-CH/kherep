import { RESOLUTION_REQUIRED } from "../../protocol-message-binding.mts";
import { LOOP_STALE } from "../../protocol-loop-brake.mts";
import { storedMessageBinding } from "./message-binding-store.mts";
import type { NewMessage, PreparedLoop } from "./message-store.mts";
import { sameBinding } from "./message-semantic-identity.mts";
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
  if (row.to_node !== message.to.nodeId || !sameBinding(stored, selected.binding)
    || row.delivery_pair !== selected.denyKey || row.in_reply_to !== (message.inReplyTo ?? null)
    || row.proxy_of !== (message.proxyOf ?? null) || row.task_id !== (message.taskId ?? null)
    || row.text !== null && row.text !== message.text) return "duplicate messageId";
  return null;
}

// The MCP registry has already verified the native claimant and argument digest.
// Recovery reads only a live row's source; it does not resolve its destination.
export function recoveryOwnerError(row: Row, nodeId: string, sessionId: string, runtime: string): string | null {
  if (row.from_node !== nodeId) return "duplicate messageId";
  const binding = storedMessageBinding(row);
  if (binding === "invalid") return RESOLUTION_REQUIRED;
  return binding && (binding.from.sessionId !== sessionId || binding.from.runtime !== runtime) ? "duplicate messageId" : null;
}
