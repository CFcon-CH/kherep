import type { MessageAddress } from "../../protocol-messages.mts";
import { isLoopAdmissionV1, safeLoopReason, MESSAGING_LOOP_BRAKE_CAPABILITY, LOOP_COMPATIBILITY, LOOP_LINEAGE, type LoopAdmissionV1 } from "../../protocol-loop-brake.mts";
export const LOOP_COLUMNS = "loop_thread, loop_pair, loop_generation, loop_ordinal, loop_direction";
export const LOOP_FIELDS = ["loop_thread", "loop_pair", "loop_generation", "loop_ordinal", "loop_direction"] as const;
type Row = Record<string, SqlStorageValue>;
export type StoredLoopLineage = { kind: "legacy" | "guarded-invalid" }
  | { kind: "guarded"; loop: LoopAdmissionV1; pair: string; direction: 0 | 1 };

// The same complete proof gates parent authority, projection, replay and push.
// Missing columns are not all-NULL legacy and never receive defaults.
export function storedLoopLineage(row: Row): StoredLoopLineage {
  if (LOOP_FIELDS.every((field) => row[field] === null)) return { kind: "legacy" };
  const loop = { version: 1, threadId: row.loop_thread, depth: row.depth, generation: row.loop_generation, ordinal: row.loop_ordinal };
  if (!isLoopAdmissionV1(loop) || typeof row.loop_pair !== "string" || !/^[0-9a-f]{64}$/.test(row.loop_pair)
    || (row.loop_direction !== 0 && row.loop_direction !== 1)) return { kind: "guarded-invalid" };
  return { kind: "guarded", loop, pair: row.loop_pair, direction: row.loop_direction };
}
export type Parent = { kind: "missing" } | { kind: "legacy" | "guarded-invalid"; row: Row }
  | { kind: "guarded"; row: Row; threadId: string; pair: string; generation: number; ordinal: number; direction: 0 | 1; depth: number };
export function parentOf(sql: SqlStorage, id?: string): Parent {
  if (!id) return { kind: "missing" };
  const row = sql.exec(`SELECT from_node, to_node, from_session, to_session, state, reason, depth, ${LOOP_COLUMNS} FROM messages WHERE id = ?`, id).toArray()[0]
    ?? sql.exec(`SELECT from_node, to_node, NULL AS from_session, NULL AS to_session, state, reason, depth, ${LOOP_COLUMNS} FROM message_tombstones WHERE id = ?`, id).toArray()[0];
  if (!row) return { kind: "missing" };
  const lineage = storedLoopLineage(row);
  return lineage.kind === "guarded" ? { kind: "guarded", row, ...lineage.loop, pair: lineage.pair, direction: lineage.direction }
    : { kind: lineage.kind, row };
}
export interface LoopSnapshot {
  from: MessageAddress | null; to: MessageAddress | null; both: boolean; parent: Parent; encoding: string | null; direction: 0 | 1 | null;
}
// Byte ordering is stable across hosts/locales; identifiers are not normalized.
function compare(a: string, b: string): number {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
export function pairIdentity(from: MessageAddress, to: MessageAddress): { encoding: string; direction: 0 | 1 } | null {
  const order = compare(from.nodeId, to.nodeId) || compare(from.session, to.session);
  if (!order) return null;
  const [lo, hi] = order < 0 ? [from, to] : [to, from];
  return { encoding: JSON.stringify(["kherep-loop-pair-v1", lo.nodeId, lo.session, hi.nodeId, hi.session]), direction: order < 0 ? 0 : 1 };
}
export class LoopIdentity {
  constructor(sql: SqlStorage, capabilities: (id: string) => string[] | null) {
    this.sql = sql; this.capabilities = capabilities;
    sql.exec("CREATE INDEX IF NOT EXISTS sessions_loop_name ON sessions(node_id, name)");
  }
  private readonly sql: SqlStorage;
  private readonly capabilities: (id: string) => string[] | null;
  resolve(endpoint: MessageAddress): MessageAddress | null {
    const exact = this.sql.exec("SELECT session_id FROM sessions WHERE node_id = ? AND session_id = ? AND state NOT IN ('unknown','closed','archived','deleted')", endpoint.nodeId, endpoint.session).toArray();
    if (exact.length === 1) return { nodeId: endpoint.nodeId, session: String(exact[0].session_id) };
    const names = this.sql.exec("SELECT session_id FROM sessions WHERE node_id = ? AND name = ? AND state NOT IN ('unknown','closed','archived','deleted') LIMIT 2", endpoint.nodeId, endpoint.session).toArray();
    return names.length === 1 ? { nodeId: endpoint.nodeId, session: String(names[0].session_id) } : null;
  }
  snapshot(fromRef: MessageAddress, toRef: MessageAddress, parentId?: string): LoopSnapshot {
    const from = this.resolve(fromRef), to = this.resolve(toRef);
    const both = [fromRef, toRef].every((e) => this.capabilities(e.nodeId)?.includes(MESSAGING_LOOP_BRAKE_CAPABILITY));
    const pair = from && to ? pairIdentity(from, to) : null;
    return { from, to, both, parent: parentOf(this.sql, parentId), encoding: pair?.encoding ?? null, direction: pair?.direction ?? null };
  }
  // Returns legacy, guarded, or a fixed refusal. Pair HMAC was computed before this transaction.
  validate(snapshot: LoopSnapshot, key: string | null, hasParent: boolean): "legacy" | "guarded" | { reason: string } {
    const { parent: p, from, to } = snapshot;
    if (p.kind === "guarded-invalid") return { reason: LOOP_LINEAGE };
    if (p.kind === "guarded") {
      if (!snapshot.both || !from || !to || snapshot.direction === null) return { reason: LOOP_COMPATIBILITY };
      if (p.pair !== key || snapshot.direction !== 1 - p.direction || p.row.from_node !== to.nodeId || p.row.to_node !== from.nodeId
        || !["accepted", "delivered", "replied"].includes(String(p.row.state))) return { reason: LOOP_LINEAGE };
      if (p.row.from_session !== null) {
        const pf = this.resolve({ nodeId: String(p.row.from_node), session: String(p.row.from_session) });
        const pt = this.resolve({ nodeId: String(p.row.to_node), session: String(p.row.to_session) });
        if (pf?.session !== to.session || pt?.session !== from.session) return { reason: LOOP_LINEAGE };
      }
      return "guarded";
    }
    // A refused guarded attempt has no admitted ordinal. Its fixed Worker refusal
    // is deny-only provenance, never a legacy parent after operator release.
    if (p.kind === "legacy" && safeLoopReason(p.row.reason)) return { reason: LOOP_LINEAGE };
    if (hasParent && p.kind === "legacy") return "legacy";
    if (!snapshot.both) return "legacy";
    if (!from || !to) return hasParent ? { reason: LOOP_LINEAGE } : "legacy";
    if (snapshot.direction === null || (hasParent && p.kind === "missing")) return { reason: LOOP_LINEAGE };
    return "guarded";
  }
}
