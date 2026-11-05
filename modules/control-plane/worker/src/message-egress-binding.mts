import type { DeliveryBinding } from "../../protocol-message-binding.mts";
import { bindingContext, type PreparedBinding } from "./message-binding.mts";
import { storedMessageBinding } from "./message-binding-store.mts";
import { sameBinding } from "./message-semantic-identity.mts";
type Row = Record<string, SqlStorageValue>;

// A retry may renew the lease, never the durable owner binding. In particular,
// a historical row cannot acquire a binding, even with a retained loop proof:
// the Node may already have stored its first unbound frame before losing ACK.
export function egressBinding(sql: SqlStorage, row: Row, prepared: PreparedBinding | null, required: boolean,
  phase?: "auth" | "registration"): { binding?: DeliveryBinding } | null {
  const stored = storedMessageBinding(row);
  if (stored === "invalid" || phase === "auth" && required || phase === "registration" && !required) return null;
  if (!required) return {};
  const message = { messageId: String(row.id), from: { nodeId: String(row.from_node), session: String(row.from_session) },
    to: { nodeId: String(row.to_node), session: String(row.to_session) } };
  if (!stored || !prepared?.binding || !prepared.leaseId || prepared.error
    || prepared.stamp !== bindingContext(sql, message).stamp
    || stored && !sameBinding(stored, prepared.binding)) return null;
  return { binding: { ...prepared.binding, leaseId: prepared.leaseId, localGeneration: prepared.localGeneration } };
}
