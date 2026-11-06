import { parseIdentityBinding } from "../../protocol-session-identity.mts";
import { RegistrySessionIdentity } from "./registry-session-identity.mts";
import { sameLoopIdentity, semanticNodes, semanticReference } from "./message-semantic-identity.mts";
import type { MessageAddress } from "../../protocol-messages.mts";
import { isLoopAdmissionV1, safeLoopReason, MESSAGING_LOOP_BRAKE_CAPABILITY, LOOP_COMPATIBILITY, LOOP_LINEAGE, type LoopAdmissionV1 } from "../../protocol-loop-brake.mts";
export const LOOP_COLUMNS = "loop_thread, loop_pair, loop_generation, loop_ordinal, loop_direction, loop_identity";
export const LOOP_FIELDS = ["loop_thread", "loop_pair", "loop_generation", "loop_ordinal", "loop_direction"] as const;
export const ALL_LOOP_FIELDS = [...LOOP_FIELDS, "loop_identity"] as const;
export const loopColumnType = (field: string): "TEXT" | "INTEGER" => ["loop_thread", "loop_pair", "loop_identity"].includes(field) ? "TEXT" : "INTEGER";
type Row = Record<string, SqlStorageValue>;
export type StoredLoopLineage = { kind: "legacy" | "guarded-invalid" }
  | { kind: "guarded"; loop: LoopAdmissionV1; pair: string; direction: 0 | 1; identityBinding: string | null };

// The same complete proof gates parent authority, projection, replay and push.
// Missing columns are not all-NULL legacy and never receive defaults.
export function storedLoopLineage(row: Row): StoredLoopLineage {
  const binding = row.loop_identity ?? null;
  if (binding !== null && !parseIdentityBinding(binding)) return { kind: "guarded-invalid" };
  if (LOOP_FIELDS.every((field) => row[field] === null)) return { kind: binding === null ? "legacy" : "guarded-invalid" };
  const loop = { version: 1, threadId: row.loop_thread, depth: row.depth, generation: row.loop_generation, ordinal: row.loop_ordinal };
  if (!isLoopAdmissionV1(loop) || typeof row.loop_pair !== "string" || !/^[0-9a-f]{64}$/.test(row.loop_pair)
    || (row.loop_direction !== 0 && row.loop_direction !== 1)) return { kind: "guarded-invalid" };
  return { kind: "guarded", loop, pair: row.loop_pair, direction: row.loop_direction, identityBinding: binding as string | null };
}
export type Parent = { kind: "missing" } | { kind: "legacy" | "guarded-invalid"; row: Row }
  | { kind: "guarded"; row: Row; threadId: string; pair: string; generation: number; ordinal: number; direction: 0 | 1; depth: number; identityBinding: string | null };
export function parentOf(sql: SqlStorage, id?: string): Parent {
  if (!id) return { kind: "missing" };
  const row = sql.exec(`SELECT from_node, to_node, from_session, to_session, state, reason, depth, ${LOOP_COLUMNS} FROM messages WHERE id = ?`, id).toArray()[0]
    ?? sql.exec(`SELECT from_node, to_node, NULL AS from_session, NULL AS to_session, state, reason, depth, ${LOOP_COLUMNS} FROM message_tombstones WHERE id = ?`, id).toArray()[0];
  if (!row) return { kind: "missing" };
  const lineage = storedLoopLineage(row);
  return lineage.kind === "guarded" ? { kind: "guarded", row, ...lineage.loop, pair: lineage.pair, direction: lineage.direction, identityBinding: lineage.identityBinding }
    : { kind: lineage.kind, row };
}
export interface LoopSnapshot {
  from: MessageAddress | null; to: MessageAddress | null; both: boolean; parent: Parent; encoding: string | null; direction: 0 | 1 | null; identityBinding: string | null; compatibility: boolean; proofs: unknown; connections: ReturnType<typeof semanticNodes>;
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
    this.sql = sql; this.capabilities = capabilities; this.references = new RegistrySessionIdentity(sql);
    sql.exec("CREATE INDEX IF NOT EXISTS sessions_loop_name ON sessions(node_id, name)");
  }
  private readonly sql: SqlStorage;
  private readonly references: RegistrySessionIdentity;
  private readonly capabilities: (id: string) => string[] | null;
  resolve(endpoint: MessageAddress, now = Date.now()): MessageAddress | null {
    const result = this.references.resolveCanonicalReference(endpoint, now);
    return result.eligible ? result.address : null;
  }
  snapshot(fromRef: MessageAddress, toRef: MessageAddress, parentId?: string, now = Date.now()): LoopSnapshot {
    const f = this.references.resolveCanonicalReference(fromRef, now), t = this.references.resolveCanonicalReference(toRef, now);
    const both = [fromRef, toRef].every((e) => this.capabilities(e.nodeId)?.includes(MESSAGING_LOOP_BRAKE_CAPABILITY));
    // Structural matches may only retain a hold. Positive eligibility is separate.
    const literal = (r: typeof f, ref: MessageAddress) => r.address ?? (r.code === "MISSING" ? ref : null);
    const df = literal(f, fromRef), dt = literal(t, toRef);
    const pair = df && dt ? pairIdentity(df, dt) : null;
    const attested = f.address && t.address && f.eligible && t.eligible && f.proof && t.proof;
    const compatibility = !!(f.address && t.address && f.eligible && t.eligible && !f.unknown && !t.unknown);
    const qualified = attested || compatibility;
    const lo = pair?.direction === 0 ? f : t, hi = pair?.direction === 0 ? t : f;
    const identityBinding = attested && lo.address && hi.address && lo.proof && hi.proof
      ? JSON.stringify([1, lo.proof.runtime, lo.proof.lifecycleGeneration, hi.proof.runtime, hi.proof.lifecycleGeneration]) : null;
    return { from: qualified ? f.address : null, to: qualified ? t.address : null, both,
      parent: parentOf(this.sql, parentId), encoding: pair?.encoding ?? null, direction: pair?.direction ?? null,
      identityBinding, compatibility, proofs: [f, t].map(semanticReference), connections: semanticNodes(this.sql, [fromRef.nodeId, toRef.nodeId]) };
  }
  deliveryValid(row: Row, binding: string, now: number): boolean {
    const snapshot = this.snapshot({ nodeId: String(row.from_node), session: String(row.from_session) },
      { nodeId: String(row.to_node), session: String(row.to_session) }, undefined, now);
    return snapshot.both && !!snapshot.from && !!snapshot.to && snapshot.identityBinding === binding;
  }
  // Only validated forward retirement may omit the old live parent sessions.
  parentRetirementEquivalent(before: LoopSnapshot, after: LoopSnapshot, key: string | null, now: number): boolean {
    const a = before.parent, b = after.parent;
    if (a.kind !== "guarded" || b.kind !== "guarded" || a.identityBinding !== b.identityBinding
      || typeof a.row.from_session !== "string" || typeof a.row.to_session !== "string"
      || b.row.from_session !== null || b.row.to_session !== null
      || (a.identityBinding === null && (!before.compatibility || !after.compatibility))) return false;
    // Compare only parent lineage here; remaining context still compares normally.
    // Validate the old live endpoints too: retirement must not erase a bad owner.
    return sameLoopIdentity(before, { ...before, parent: b }, { parentRetirementEquivalent: true })
      && this.validate(before, key, true, now) === "guarded" && this.validate(after, key, true, now) === "guarded";
  }
  validate(snapshot: LoopSnapshot, key: string | null, hasParent: boolean, now = Date.now()): "legacy" | "guarded" | { reason: string } {
    const { parent: p, from, to } = snapshot;
    if (p.kind === "guarded-invalid") return { reason: LOOP_LINEAGE };
    if (p.kind === "guarded") {
      if (!snapshot.both || !from || !to || snapshot.direction === null) return { reason: LOOP_COMPATIBILITY };
      if (p.identityBinding === null ? !snapshot.compatibility : p.identityBinding !== snapshot.identityBinding) return { reason: LOOP_COMPATIBILITY };
      if (p.pair !== key || snapshot.direction !== 1 - p.direction || p.row.from_node !== to.nodeId || p.row.to_node !== from.nodeId
        || !["accepted", "delivered", "replied"].includes(String(p.row.state))) return { reason: LOOP_LINEAGE };
      if (p.row.from_session !== null) {
        const pf = this.resolve({ nodeId: String(p.row.from_node), session: String(p.row.from_session) }, now);
        const pt = this.resolve({ nodeId: String(p.row.to_node), session: String(p.row.to_session) }, now);
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
