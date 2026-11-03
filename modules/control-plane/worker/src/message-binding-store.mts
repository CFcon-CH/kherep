import { isMessageBinding, type MessageBinding } from "../../protocol-message-binding.mts";
type Row = Record<string, SqlStorageValue>;
export const BINDING_COLUMNS = "delivery_binding, delivery_pair";
export function migrateMessageBinding(sql: SqlStorage): void {
  const columns = sql.exec("PRAGMA table_info(messages)").toArray().map(c => c.name);
  for (const name of ["delivery_binding", "delivery_pair"]) if (!columns.includes(name)) sql.exec(`ALTER TABLE messages ADD COLUMN ${name} TEXT`);
  sql.exec("CREATE INDEX IF NOT EXISTS messages_delivery_pair ON messages(delivery_pair,state)");
}
export function storedMessageBinding(row: Row): MessageBinding | null | "invalid" {
  if (row.delivery_binding === null && row.delivery_pair === null) return null;
  if (typeof row.delivery_binding !== "string" || row.delivery_pair !== null
    && (typeof row.delivery_pair !== "string" || !/^[0-9a-f]{64}$/.test(row.delivery_pair))) return "invalid";
  let binding: unknown; try { binding = JSON.parse(row.delivery_binding); } catch { return "invalid"; }
  return isMessageBinding(binding) && JSON.stringify(binding) === row.delivery_binding
    && binding.from.sessionId === row.from_session && binding.to.sessionId === row.to_session ? binding : "invalid";
}
