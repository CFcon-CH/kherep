import { LOOP_IDLE_MS, LOOP_PAIRS, LOOP_RING, LOOP_SEGMENT, LOOP_STRIKES, LOOP_LINEAGE, loopHeldReason, type LoopAdmissionV1, type LoopHoldCode, safeLoopReason } from "../../protocol-loop-brake.mts";
import type { LoopSignal } from "./message-loop-signals.mts";
type Row = Record<string, SqlStorageValue>;
const SCHEMA = `CREATE TABLE IF NOT EXISTS message_loop_pairs (
 pair_key TEXT PRIMARY KEY, from_node TEXT NOT NULL, to_node TEXT NOT NULL,
 generation INTEGER NOT NULL, version INTEGER NOT NULL, last_activity INTEGER NOT NULL,
 admitted_count INTEGER NOT NULL, no_progress_count INTEGER NOT NULL, fingerprints TEXT NOT NULL,
 hold_id TEXT, hold_code TEXT, trigger_id TEXT, held_at INTEGER, released_id TEXT, released_version INTEGER
);
CREATE INDEX IF NOT EXISTS loop_idle ON message_loop_pairs(last_activity) WHERE hold_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS loop_hold ON message_loop_pairs(hold_id) WHERE hold_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS loop_released ON message_loop_pairs(released_id) WHERE released_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_loop_pair ON messages(loop_pair);
CREATE INDEX IF NOT EXISTS messages_loop_queued ON messages(loop_pair, state) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS tombstones_loop_pair ON message_tombstones(loop_pair);`;
const DUE = `SELECT pair_key FROM message_loop_pairs INDEXED BY loop_idle WHERE hold_id IS NULL AND last_activity <= ?
 AND NOT EXISTS (SELECT 1 FROM messages INDEXED BY messages_loop_pair WHERE loop_pair = pair_key)
 AND NOT EXISTS (SELECT 1 FROM message_tombstones INDEXED BY tombstones_loop_pair WHERE loop_pair = pair_key)
 ORDER BY last_activity LIMIT 64`;
const NEXT = `SELECT MIN(last_activity) AS next FROM message_loop_pairs INDEXED BY loop_idle WHERE hold_id IS NULL
 AND NOT EXISTS (SELECT 1 FROM messages INDEXED BY messages_loop_pair WHERE loop_pair = pair_key)
 AND NOT EXISTS (SELECT 1 FROM message_tombstones INDEXED BY tombstones_loop_pair WHERE loop_pair = pair_key)`;
export const LOOP_QUERIES = { loopDue: { sql: DUE, args: [0] }, loopNext: { sql: NEXT, args: [] },
  loopPair: { sql: "SELECT * FROM message_loop_pairs WHERE pair_key = ?", args: ["key"] } } as const;
export interface LoopCandidate {
  key: string; fromNode: string; toNode: string; messageId: string; threadId: string; depth: number;
  parentGeneration?: number; signal: LoopSignal; now: number;
}
const natural = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
export class MessageLoopStore {
  private readonly sql: SqlStorage;
  constructor(sql: SqlStorage) { this.sql = sql; sql.exec(SCHEMA); }
  private read(key: string): Row | null {
    const r = this.sql.exec("SELECT * FROM message_loop_pairs WHERE pair_key = ?", key).toArray()[0];
    if (!r) return null;
    let ring: unknown;
    try { ring = JSON.parse(String(r.fingerprints)); } catch { throw new Error("loop-state-unavailable"); }
    if (![r.generation, r.version, r.last_activity, r.admitted_count, r.no_progress_count].every(natural)
      || Number(r.admitted_count) > LOOP_SEGMENT || Number(r.no_progress_count) > LOOP_STRIKES || !Array.isArray(ring)
      || ring.length > LOOP_RING || ring.some((x) => typeof x !== "string" || !/^[0-9a-f]{64}$/.test(x))
      || (r.hold_id !== null && !safeLoopReason(loopHeldReason(r.hold_code as LoopHoldCode, String(r.hold_id))))
      || (r.hold_id === null && (r.hold_code !== null || r.trigger_id !== null || r.held_at !== null))) {
      throw new Error("loop-state-unavailable");
    }
    return r;
  }
  held(key: string): string | null {
    const r = this.read(key);
    return r?.hold_id ? loopHeldReason(r.hold_code as LoopHoldCode, String(r.hold_id)) : null;
  }
  admit(c: LoopCandidate): { loop: LoopAdmissionV1 } | { reason: string } {
    let r = this.read(c.key);
    if (r?.hold_id) return { reason: loopHeldReason(r.hold_code as LoopHoldCode, String(r.hold_id)) };
    if (c.parentGeneration !== undefined && (!r || c.parentGeneration > Number(r.generation))) return { reason: LOOP_LINEAGE };
    if (!r) {
      const count = Number(this.sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs").one().n);
      if (count >= LOOP_PAIRS) return { reason: "loop-capacity" };
      this.sql.exec(`INSERT INTO message_loop_pairs (pair_key, from_node, to_node, generation, version, last_activity,
        admitted_count, no_progress_count, fingerprints) VALUES (?, ?, ?, 0, 0, ?, 0, 0, '[]')`, c.key, c.fromNode, c.toNode, c.now);
      r = this.read(c.key)!;
    }
    const ring = JSON.parse(String(r.fingerprints)) as string[];
    const strikes = c.signal.acknowledgement || ring.includes(c.signal.fingerprint) ? Number(r.no_progress_count) + 1 : 0;
    const code = Number(r.admitted_count) >= LOOP_SEGMENT ? "segment-limit" : strikes >= LOOP_STRIKES ? "ack-or-repeat" : null;
    if (code) {
      if (Number(r.version) >= Number.MAX_SAFE_INTEGER) throw new Error("loop-state-unavailable");
      const id = crypto.randomUUID();
      this.sql.exec(`UPDATE message_loop_pairs SET hold_id = ?, hold_code = ?, trigger_id = ?, held_at = ?,
        version = version + 1, no_progress_count = ?, last_activity = ? WHERE pair_key = ?`,
      id, code, c.messageId, c.now, Math.min(strikes, LOOP_STRIKES), c.now, c.key);
      return { reason: loopHeldReason(code, id) };
    }
    const ordinal = Number(r.admitted_count) + 1;
    this.sql.exec(`UPDATE message_loop_pairs SET admitted_count = ?, no_progress_count = ?, fingerprints = ?, last_activity = ?
      WHERE pair_key = ?`, ordinal, strikes, JSON.stringify([...ring, c.signal.fingerprint].slice(-LOOP_RING)), c.now, c.key);
    return { loop: { version: 1, threadId: c.threadId, depth: c.depth, generation: Number(r.generation), ordinal } };
  }
  listHolds(limit: number) {
    return this.sql.exec(`SELECT hold_id AS holdId, hold_code AS reason, from_node AS fromNode, to_node AS toNode,
      trigger_id AS triggerMessageId, held_at AS heldAt, generation, version, admitted_count AS admittedCount,
      no_progress_count AS noProgressCount FROM message_loop_pairs WHERE hold_id IS NOT NULL ORDER BY held_at, hold_id LIMIT ?`, limit).toArray();
  }
  release(id: string, expectedVersion: number, now: number): { status: number; holdId?: string; generation?: number; version?: number; changed?: boolean } {
    const row = this.sql.exec("SELECT pair_key FROM message_loop_pairs WHERE hold_id = ? OR released_id = ?", id, id).toArray()[0];
    if (!row) return { status: 404 };
    const r = this.read(String(row.pair_key))!;
    if (r.released_id === id && r.released_version === expectedVersion) {
      return { status: 200, holdId: id, generation: Number(r.generation), version: expectedVersion + 1 };
    }
    if (r.hold_id !== id || r.version !== expectedVersion) return { status: 409 };
    const generation = Number(r.generation) + 1, version = Number(r.version) + 1;
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(version)) throw new Error("loop-state-unavailable");
    this.sql.exec(`UPDATE message_loop_pairs SET generation = ?, version = ?, hold_id = NULL, hold_code = NULL,
      trigger_id = NULL, held_at = NULL, admitted_count = 0, no_progress_count = 0, last_activity = ?,
      released_id = ?, released_version = ? WHERE pair_key = ?`, generation, version, now, id, expectedVersion, row.pair_key);
    return { status: 200, holdId: id, generation, version, changed: true };
  }
  revoke(nodeId: string): void { this.sql.exec("DELETE FROM message_loop_pairs WHERE from_node = ? OR to_node = ?", nodeId, nodeId); }
  cleanup(now: number): boolean {
    const rows = this.sql.exec(DUE, now - LOOP_IDLE_MS).toArray();
    for (const r of rows) this.sql.exec("DELETE FROM message_loop_pairs WHERE pair_key = ?", r.pair_key);
    return rows.length === 64;
  }
  nextExpiry(): number | null {
    const next = this.sql.exec(NEXT).one().next;
    return next === null ? null : Number(next) + LOOP_IDLE_MS;
  }
}
