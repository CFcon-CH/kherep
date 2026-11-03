import { safeLoopReason } from "../../protocol-loop-brake.mts";
import { LOOP_COLUMNS, ALL_LOOP_FIELDS, loopColumnType, parentOf } from "./message-loop-identity.mts";
import type { McpInboxItem } from "../../protocol-mcp.mts";
import {
  isFinalMessageState, MESSAGING_ACK_CAPABILITY, type MessageAddress, type MessageReceiptBody, type MessageState,
  type MessageStatusAckBody, type MessageStatusBody, type NodeReportedState,
} from "../../protocol-messages.mts";
import { depthExceeded, replyDepth } from "./message-depth.mts";

// Deletes a message once its sender acknowledged the final status (issue
// #308, PR 4). A 24 h tombstone keeps metadata only (no text, no sessions) so
// that a late resend, a late target report, MCP status, task-control
// provenance and reply depth still resolve. Only rows stored by this Worker
// version carry `deletable = 1`; rows stored before it are never deleted here,
// however they are acknowledged, swept or revoked (operator decision). A row
// stored before this version is settled on its sender's acknowledgement
// instead (issue #493), never deleted.
export const TOMBSTONE_TTL_MS = 24 * 60 * 60_000;
// Senders without messaging.ack.v1, and the operator API, never acknowledge.
export const FALLBACK_DELETE_MS = 24 * 60 * 60_000;
export const RETENTION_BATCH = 64;

// Runs after MessageStore added the deletable and delete_after columns.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS message_tombstones (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  depth INTEGER,
  reply_message_id TEXT,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tombstones_deleted_at ON message_tombstones (deleted_at);
CREATE INDEX IF NOT EXISTS messages_delete_after ON messages (delete_after) WHERE delete_after IS NOT NULL;
`;

const FINAL = "('delivered', 'replied', 'refused', 'expired')";
const ROW_COLUMNS = "id, from_node, to_node, state, reason, depth, reply_message_id, deletable, settled_state, " + LOOP_COLUMNS;
const ROW = `SELECT ${ROW_COLUMNS} FROM messages WHERE id = ?`;
const TOMBSTONE = `SELECT id, from_node, to_node, state, reason, depth, reply_message_id, deleted_at, ${LOOP_COLUMNS} FROM message_tombstones WHERE id = ?`;
// Due rows in deadline order, whatever they are: a deadline the sweep must not
// act on (a row stored before this version, or not final) is cleared instead, or
// the alarm would re-arm on it forever.
const SWEEP_DUE = `SELECT ${ROW_COLUMNS} FROM messages INDEXED BY messages_delete_after
  WHERE delete_after <= ? ORDER BY delete_after LIMIT ?`;
const CLEAR_DUE = "UPDATE messages SET delete_after = NULL WHERE id = ?";
const NEXT_DELETE = "SELECT MIN(delete_after) AS next FROM messages INDEXED BY messages_delete_after WHERE delete_after IS NOT NULL";
const PRUNE_DUE = `SELECT id FROM message_tombstones INDEXED BY tombstones_deleted_at
  WHERE deleted_at <= ? ORDER BY deleted_at LIMIT ?`;
const OLDEST_TOMBSTONE = "SELECT MIN(deleted_at) AS oldest FROM message_tombstones INDEXED BY tombstones_deleted_at";
const SENDER_DUE = `UPDATE messages INDEXED BY messages_from_node SET delete_after = ?
  WHERE from_node = ? AND deletable = 1 AND state IN ${FINAL}`;
// Exported with sample bindings for the query-plan test.
export const RETENTION_QUERIES = {
  row: { sql: ROW, args: ["id"] },
  tombstone: { sql: TOMBSTONE, args: ["id"] },
  sweepDue: { sql: SWEEP_DUE, args: [0, RETENTION_BATCH] },
  nextDelete: { sql: NEXT_DELETE, args: [] },
  pruneDue: { sql: PRUNE_DUE, args: [0, RETENTION_BATCH] },
  oldestTombstone: { sql: OLDEST_TOMBSTONE, args: [] },
  senderDue: { sql: SENDER_DUE, args: [0, "node"] },
} as const;

interface Tombstone {
  messageId: string; fromNode: string; toNode: string; state: MessageState; reason: string | null;
  depth: number | null; replyMessageId: string | null; deletedAt: number;
}
// What MCP status reads from a message row or, after deletion, its tombstone.
export interface MessageStatusView {
  state: MessageState; reason?: string; progress: MessageStatusBody["progress"] | null; updatedAt: number; replyMessageId?: string;
}

type Audit = (actor: string, action: string, target: string | null, detail: unknown) => void;

// The earliest of the known times, or null.
export function earliest(...times: (number | null)[]): number | null {
  const known = times.filter((t) => t !== null);
  return known.length === 0 ? null : Math.min(...known);
}
type Capabilities = (nodeId: string) => string[] | null;
type Row = Record<string, SqlStorageValue>;

export class MessageRetention {
  private readonly sql: SqlStorage;
  private readonly audit: Audit;
  private readonly capabilities: Capabilities;

  constructor(sql: SqlStorage, audit: Audit, capabilities: Capabilities) {
    this.sql = sql;
    this.audit = audit;
    this.capabilities = capabilities;
    this.sql.exec(SCHEMA);
    const columns = this.sql.exec("PRAGMA table_info(message_tombstones)").toArray().map((c) => String(c.name));
    for (const field of ALL_LOOP_FIELDS) if (!columns.includes(field)) {
      this.sql.exec(`ALTER TABLE message_tombstones ADD COLUMN ${field} ${loopColumnType(field)}`);
    }
  }

  private tombstone(messageId: string): Tombstone | null {
    const row = this.sql.exec(TOMBSTONE, messageId).toArray()[0];
    return row ? {
      messageId: String(row.id), fromNode: String(row.from_node), toNode: String(row.to_node), state: row.state as MessageState,
      reason: row.reason as string | null, depth: row.depth === null ? null : Number(row.depth),
      replyMessageId: row.reply_message_id as string | null, deletedAt: Number(row.deleted_at),
    } : null;
  }

  // A final state was stored. Its sender will not acknowledge it when it is
  // the operator API or a node without messaging.ack.v1: delete it in 24 h.
  finalized(messageId: string, fromNode: string, state: MessageState, now: number): void {
    if (!isFinalMessageState(state) || this.capabilities(fromNode)?.includes(MESSAGING_ACK_CAPABILITY)) return;
    this.sql.exec("UPDATE messages SET delete_after = ? WHERE id = ? AND deletable = 1", now + FALLBACK_DELETE_MS, messageId);
  }

  // The sender acknowledged a final status. Anything else is a no-op: an
  // unknown or already deleted message, another sender, a state that is not
  // final or not the stored one (a later status gets its own ack). A row this
  // Worker may delete (deletable = 1) goes; a row it may not (stored before
  // PR 4, operator decision) is settled instead (issue #493): it keeps the
  // acknowledged state in settled_state and is replayed again only when its
  // state moves on, whichever Worker version moves it.
  ack(nodeId: string, body: MessageStatusAckBody, now: number): void {
    const row = this.sql.exec(ROW, body.messageId).toArray()[0];
    if (!row || String(row.from_node) !== nodeId || row.state !== body.state || !isFinalMessageState(row.state)) return;
    if (row.deletable === 1) return this.remove(row, `node:${nodeId}`, "ack", now);
    if (row.settled_state === row.state) return; // settled by an earlier ack of this state
    this.sql.exec("UPDATE messages SET settled_state = ? WHERE id = ?", row.state, row.id);
    this.audit(`node:${nodeId}`, "message.settle", String(row.to_node), { messageId: String(row.id) });
  }

  // Deletes up to `limit` rows whose fallback deadline passed; true when the
  // batch was full and more may be due.
  sweepDue(now: number): boolean {
    const rows = this.sql.exec(SWEEP_DUE, now, RETENTION_BATCH).toArray();
    for (const row of rows) {
      if (row.deletable === 1 && isFinalMessageState(row.state)) this.remove(row, "system", "fallback", now);
      else this.sql.exec(CLEAR_DUE, row.id);
    }
    return rows.length === RETENTION_BATCH;
  }

  // Drops up to `limit` tombstones older than TOMBSTONE_TTL_MS; true when full.
  pruneTombstones(now: number): boolean {
    const ids = this.sql.exec(PRUNE_DUE, now - TOMBSTONE_TTL_MS, RETENTION_BATCH).toArray();
    for (const { id } of ids) this.sql.exec("DELETE FROM message_tombstones WHERE id = ?", id);
    return ids.length === RETENTION_BATCH;
  }

  // The earliest fallback deadline or tombstone expiry, or null.
  nextDue(): number | null {
    const next = this.sql.exec(NEXT_DELETE).one().next;
    const oldest = this.sql.exec(OLDEST_TOMBSTONE).one().oldest;
    return earliest(next === null ? null : Number(next), oldest === null ? null : Number(oldest) + TOMBSTONE_TTL_MS);
  }

  // A revoked node acknowledges nothing more: its final rows are due now.
  senderRevoked(nodeId: string, now: number): void {
    this.sql.exec(SENDER_DUE, now, nodeId);
  }

  // Status metadata only: MessageStore refuses a repeated send once its binding
  // is pruned. This accessor cannot authorize a new send or native effect.
  // A resend of a deleted message: its final status, or the duplicate error
  // when another node uses the id. null when no tombstone exists.
  resend(messageId: string, fromNode: string): { ok: true; status: MessageStatusBody } | { ok: false; error: string } | null {
    const tombstone = this.tombstone(messageId);
    if (!tombstone) return null;
    if (tombstone.fromNode !== fromNode) return { ok: false, error: "duplicate messageId" };
    return { ok: true, status: { messageId, state: tombstone.state, ...(tombstone.reason === null ? {} : { reason: tombstone.reason }) } };
  }

  // A target report for a message without a row settles from the tombstone.
  // After the prune nothing is left to compare, so the receipt says expired:
  // every node settles on it and stops re-reporting. A tombstone of another
  // target node gets no receipt.
  lateReceipt(nodeId: string, status: { messageId: string; state: NodeReportedState }): MessageReceiptBody | null {
    const tombstone = this.tombstone(status.messageId);
    if (tombstone && tombstone.toNode !== nodeId) return null;
    return { name: "message.receipt", messageId: status.messageId, requestedState: status.state, storedState: tombstone?.state ?? "expired" };
  }

  // The reply target of an MCP reply whose parent row is gone: the inbox item
  // the replying node returned for that id and session, checked against the
  // tombstone when one is left, within the depth the Worker derives itself.
  inboxReplyTarget(claimant: MessageAddress, inReplyTo: string, item: McpInboxItem | null): MessageAddress | null {
    const nodeId = claimant.nodeId;
    if (item?.messageId !== inReplyTo) return null;
    const provenance = parentOf(this.sql, inReplyTo);
    if (provenance.kind === "guarded-invalid") return null;
    if (provenance.kind !== "guarded" && depthExceeded(replyDepth(this.sql, inReplyTo))) return null;
    const tombstone = this.tombstone(inReplyTo);
    if (tombstone && (tombstone.toNode !== nodeId || tombstone.fromNode !== item.from.nodeId)) return null;
    return { nodeId: item.from.nodeId, session: item.from.session };
  }

  source(messageId: string): { ownerNodeId: string; targetNodeId: string } | null {
    const tombstone = this.tombstone(messageId);
    return tombstone ? { ownerNodeId: tombstone.fromNode, targetNodeId: tombstone.toNode } : null;
  }

  statusFor(nodeId: string, messageId: string): MessageStatusView | null {
    const tombstone = this.tombstone(messageId);
    if (!tombstone || (tombstone.fromNode !== nodeId && tombstone.toNode !== nodeId)) return null;
    return { state: tombstone.state, progress: null, updatedAt: tombstone.deletedAt,
      ...(safeLoopReason(tombstone.reason) ? { reason: safeLoopReason(tombstone.reason) } : {}),
      ...(tombstone.replyMessageId ? { replyMessageId: tombstone.replyMessageId } : {}) };
  }

  // One transaction (the caller's): the tombstone, the delete, and an audit
  // entry with ids only.
  private remove(row: Row, actor: string, via: "ack" | "fallback", now: number): void {
    this.sql.exec(`INSERT OR REPLACE INTO message_tombstones (id, from_node, to_node, state, reason, depth, reply_message_id, deleted_at, ${LOOP_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.from_node, row.to_node, row.state, row.reason, row.depth, row.reply_message_id, now, ...ALL_LOOP_FIELDS.map((f) => row[f]));
    this.sql.exec("DELETE FROM messages WHERE id = ?", row.id);
    this.audit(actor, "message.delete", String(row.to_node), { messageId: String(row.id), via });
  }
}
