import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_DIRECTORY_NODES, MESSAGE_STATUS_ACK, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { HOT_MESSAGE_QUERIES } from "../src/message-store.mts";
import { RETENTION_BATCH } from "../src/message-retention.mts";
import type { Registry } from "../src/registry.mts";
import type { SqlRows } from "../src/sql-meter.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

// Issue #308: one Registry request must read a bounded number of SQLite rows,
// however many final-state messages and tombstones the tables hold.
const M = 2000;
const SESSIONS = 500;
const BOUND = 32;
const SEED_SENDER = "00000000-0000-4000-8000-00000000c0de";
const REPLAY_NODE = "00000000-0000-4000-8000-00000000beef";
const DAY = 24 * 60 * 60_000;
// A full alarm deletes one batch of rows and prunes one batch of tombstones;
// each item reads a few rows (its row, the delete, the audit).
const ALARM_BOUND = BOUND + 3 * 2 * RETENTION_BATCH;

// Seeds final-state messages straight into SQLite, outside the meter. Rows
// from before PR 4 (deletable NULL), or rows of this version with a fallback
// deadline.
async function seed(from: string, to: string, prefix: string, count: number, deleteAfter?: number): Promise<void> {
  await runInDurableObject(registry(), (_instance, state) => {
    state.storage.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO messages (id, from_node, from_session, to_node, to_session, text, state, created_at, updated_at, expires_at,
        deletable, delete_after)
      SELECT ? || i, ?, 's', ?, 't', NULL, CASE i % 3 WHEN 0 THEN 'delivered' WHEN 1 THEN 'refused' ELSE 'expired' END, i, i, i, ?, ?
      FROM n`, count, prefix, from, to, deleteAfter === undefined ? null : 1, deleteAfter ?? null);
  });
}

async function seedTombstones(prefix: string, count: number, deletedAt: number): Promise<void> {
  await runInDurableObject(registry(), (_instance, state) => {
    state.storage.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO message_tombstones (id, from_node, to_node, state, depth, deleted_at)
      SELECT ? || i, ?, ?, 'delivered', 0, ? FROM n`, count, prefix, SEED_SENDER, REPLAY_NODE, deletedAt);
  });
}

// The rows one Registry request path logged.
async function measure(path: string, call: (instance: Registry) => unknown): Promise<SqlRows> {
  const log = vi.spyOn(console, "log");
  try {
    await runInDurableObject(registry(), async (instance) => { await call(instance); });
    const lines = log.mock.calls.map(([line]) => line as { event?: string; path?: string } & SqlRows)
      .filter((line) => line?.event === "registry.sql" && line.path === path);
    expect(lines).toHaveLength(1);
    return { rowsRead: lines[0]!.rowsRead, rowsWritten: lines[0]!.rowsWritten };
  } finally {
    log.mockRestore();
  }
}

// The rows of every call to one path within a single Durable Object turn: no
// alarm or other request can run between them (issue #441: a due alarm, left by
// the alarm test's retention backlog, drops the cached directory on its own).
async function measureTurn(path: string, call: (instance: Registry) => void): Promise<SqlRows[]> {
  const log = vi.spyOn(console, "log");
  try {
    await runInDurableObject(registry(), (instance) => { call(instance); });
    return log.mock.calls.map(([line]) => line as { event?: string; path?: string } & SqlRows)
      .filter((line) => line?.event === "registry.sql" && line.path === path)
      .map((line) => ({ rowsRead: line.rowsRead, rowsWritten: line.rowsWritten }));
  } finally {
    log.mockRestore();
  }
}

async function round(sender: string, target: string, label: string) {
  const messageId = crypto.randomUUID();
  const send = await measure("sendMessage", (r) => r.sendMessage({
    messageId, from: { nodeId: sender, session: "s" }, to: { nodeId: target, session: "t" }, text: label,
  }, "test"));
  const report = await measure("reportMessageStatus", (r) => r.reportMessageStatus(target, { messageId, state: "accepted" }));
  await measure("setStatus", (r) => r.setStatus(target, "online", Date.now()));
  const directory = await measure("directory", (r) => r.directory());
  const cached = await measure("directory", (r) => r.directory());
  const replay = await measure("messageStatusPageFor", (r) => r.messageStatusPageFor(REPLAY_NODE, 0, 128));
  // Issue #308: the final report, the sender's ack, and a reply to the deleted message.
  const final = await measure("reportMessageStatus", (r) => r.reportMessageStatus(target, { messageId, state: "delivered" }));
  const ack = await measure("ackMessageStatus", (r) => r.ackMessageStatus(sender,
    { name: MESSAGE_STATUS_ACK, messageId, state: "delivered" }));
  // The reply goes back to the sender, which takes no messages, so it queues nothing for the next round.
  const reply = await measure("sendMessage", (r) => r.sendMessage({ messageId: crypto.randomUUID(),
    from: { nodeId: target, session: "t" }, to: { nodeId: sender, session: "s" }, text: label, inReplyTo: messageId }, "test"));
  return { send, report, directory, cached, replay, final, ack, reply };
}

describe("Registry read budget", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads a bounded number of rows per request, independent of the message count", async () => {
    const sender = await enroll(await newKey(), "budget-sender");
    const target = await enroll(await newKey(), "budget-target");
    await registry().updateRegistration(target, FACTS, [], [MESSAGING_CAPABILITY]);
    await registry().replaceSessions(target, Array.from({ length: SESSIONS }, (_, i) => ({
      sessionId: `session-${i}`, runtime: "claude-code", state: "idle",
    })));
    const later = Date.now() + DAY;
    // Issue #493: settled rows of the replaying sender, below its unsettled ones.
    await seed(REPLAY_NODE, target, "settled-", M);
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE messages SET settled_state = state WHERE id LIKE 'settled-%'");
    });
    await seed(REPLAY_NODE, target, "replay-", 3);
    await seed(SEED_SENDER, target, "seed-a-", M);
    await seed(SEED_SENDER, target, "due-a-", M, later);
    await seedTombstones("tomb-a-", M, Date.now());

    const first = await round(sender, target, "first");
    await seed(SEED_SENDER, target, "seed-b-", M);
    await seed(SEED_SENDER, target, "due-b-", M, later);
    await seedTombstones("tomb-b-", M, Date.now());
    const second = await round(sender, target, "second");

    // The meter counts in workerd: an uncached directory reads every session.
    expect(first.directory.rowsRead).toBeGreaterThanOrEqual(SESSIONS);
    for (const path of ["send", "report", "cached", "replay", "final", "ack", "reply"] as const) {
      expect(first[path].rowsRead, path).toBeLessThanOrEqual(BOUND);
    }
    expect(first.cached.rowsRead).toBe(0);
    expect(second).toEqual(first);

    // Issue #493: the ack that settles a row stored before PR 4.
    await seed(REPLAY_NODE, target, "legacy-ack-", 1);
    const settle = await measure("ackMessageStatus", (r) => r.ackMessageStatus(REPLAY_NODE,
      { name: MESSAGE_STATUS_ACK, messageId: "legacy-ack-1", state: "refused" }));
    expect(settle.rowsRead).toBeLessThanOrEqual(BOUND);
    expect(settle.rowsWritten).toBeGreaterThanOrEqual(2);

    const totals = await runInDurableObject(registry(), (instance) => instance.sqlStats());
    expect(totals.rowsRead).toBeGreaterThanOrEqual(first.directory.rowsRead + second.directory.rowsRead);
  });

  it("bounds an alarm by its batches, however much is due or kept", async () => {
    await seed(SEED_SENDER, REPLAY_NODE, "kept-a-", M);
    await seed(SEED_SENDER, REPLAY_NODE, "later-a-", M, Date.now() + DAY);
    await seedTombstones("fresh-a-", M, Date.now());
    const idle = await measure("alarm", (r) => r.alarm());
    expect(idle.rowsRead).toBeLessThanOrEqual(BOUND);

    // A backlog of due rows and old tombstones: one batch of each per alarm.
    const sweep = async (prefix: string) => {
      await seed(SEED_SENDER, REPLAY_NODE, `${prefix}-due-`, M, 1);
      await seedTombstones(`${prefix}-old-`, M, 1);
      return measure("alarm", (r) => r.alarm());
    };
    const full = await sweep("first");
    const doubled = await sweep("second");
    expect(full.rowsRead).toBeLessThanOrEqual(ALARM_BOUND);    expect(doubled).toEqual(full);
    expect(await measure("alarm", (r) => r.alarm())).toEqual(full);
  });

  it("plans the hot message queries without scanning the messages or tombstone table", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const plans = Object.entries(HOT_MESSAGE_QUERIES).map(([name, { sql, args }]) => [name,
        state.storage.sql.exec(`EXPLAIN QUERY PLAN ${sql}`, ...args).toArray().map((row) => String(row.detail)).join("; ")]);
      expect(Object.fromEntries(plans)).toEqual({
        expireDue: expect.stringContaining("USING INDEX messages_queued_expiry"),
        nextExpiry: expect.stringContaining("messages_queued_expiry"),
        statusPage: expect.stringContaining("USING INDEX messages_replay"),
        parentDepth: expect.stringMatching(/sqlite_autoindex_messages_1.*sqlite_autoindex_message_tombstones_1/),
        row: expect.stringContaining("USING INDEX sqlite_autoindex_messages_1"),
        tombstone: expect.stringContaining("USING INDEX sqlite_autoindex_message_tombstones_1"),
        sweepDue: expect.stringContaining("USING INDEX messages_delete_after"),
        nextDelete: expect.stringContaining("USING COVERING INDEX messages_delete_after"),
        pruneDue: expect.stringContaining("USING INDEX tombstones_deleted_at"),
        oldestTombstone: expect.stringContaining("USING COVERING INDEX tombstones_deleted_at"),
        senderDue: expect.stringContaining("USING INDEX messages_from_node"),
        proxyParent: expect.stringContaining("USING INDEX sqlite_autoindex_messages_1"),
        proxyQueued: expect.stringContaining("USING INDEX sqlite_autoindex_messages_1"),
        queuedProxies: expect.stringContaining("USING INDEX messages_to_state"),
        // Issue #441: the queue head of one listed node in the directory.
        queueHead: expect.stringContaining("messages_to_state"),
        loopDue: expect.stringMatching(/loop_idle.*messages_loop_pair.*tombstones_loop_pair/),
        loopNext: expect.stringMatching(/loop_idle.*messages_loop_pair.*tombstones_loop_pair/),
        loopPair: expect.stringContaining("sqlite_autoindex_message_loop_pairs_1"),
      });
      for (const [name, plan] of plans) expect(plan, name).not.toMatch(/SCAN (messages|message_tombstones)|TEMP B-TREE/);
    });
  });

  // Issue #408, PR 4: the push boundary of a proxy delivery reads its row once.
  it("reads one row for the queued check of a proxy delivery, however many messages the table holds", async () => {
    await seed(SEED_SENDER, REPLAY_NODE, "proxy-budget-", M);
    const unknown = await measure("messageQueued", (r) => r.messageQueued(crypto.randomUUID()));
    const known = await measure("messageQueued", (r) => r.messageQueued("proxy-budget-1"));
    expect(unknown.rowsRead).toBeLessThanOrEqual(1);
    expect(known.rowsRead).toBeLessThanOrEqual(1);
    expect(known.rowsWritten).toBe(0);
  });

  // Issue #441: the per-node queue seeks run over the listed nodes only, however many are enrolled.
  it("bounds the directory rebuild by the listed population and orders equal names by id", async () => {
    const extra = 10;
    const total = MAX_DIRECTORY_NODES + extra;
    const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    // Equal names, inserted in descending id order: only the id tie-break gives the listed prefix.
    await runInDurableObject(registry(), (_instance, state) => {
      for (let i = total; i >= 1; i--) {
        state.storage.sql.exec("INSERT INTO nodes (id, name, status, capabilities, enrolled_at) VALUES (?, 'aaa-bulk', 'online', '[]', 0)", idOf(i));
      }
    });
    // Any message transaction drops the cached directory; this one changes nothing.
    const invalidate = () => registry().ackMessageStatus(SEED_SENDER, { name: MESSAGE_STATUS_ACK, messageId: crypto.randomUUID(), state: "delivered" });
    const rebuild = async () => {
      await invalidate();
      // An alarm may run between any two requests; here it does, before the measured turn.
      await runInDurableObject(registry(), (r) => r.alarm());
      let body: Awaited<ReturnType<Registry["directory"]>> | null = null;
      const turn = await measureTurn("directory", (r) => { body = r.directory(); r.directory(); });
      expect(turn).toHaveLength(2);
      // The second read of the same turn is served from the cache.
      expect(turn[1]!.rowsRead).toBe(0);
      return { rows: turn[0]!, body: body! };
    };
    const empty = await rebuild();

    // Every listed node gets 3 queued rows; every unlisted one 100, so a seek over any of them would show.
    await runInDurableObject(registry(), (_instance, state) => {
      for (let i = 1; i <= total; i++) {
        state.storage.sql.exec(`WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ?)
          INSERT INTO messages (id, from_node, from_session, to_node, to_session, text, state, created_at, updated_at, expires_at)
          SELECT ? || '-' || k, ?, 's', ?, 't', 'x', 'queued', ? + k, ? + k, ? FROM n`,
        i <= MAX_DIRECTORY_NODES ? 3 : 100, idOf(i), SEED_SENDER, idOf(i), 1_000 * i, 1_000 * i, Date.now() + DAY);
      }
    });
    const loaded = await rebuild();
    // The seeks read the queued entries of the listed nodes, plus at most the one index entry past each
    // range; a seek over the unlisted nodes would add their 1000 entries.
    expect(loaded.rows.rowsRead - empty.rows.rowsRead).toBeGreaterThanOrEqual(MAX_DIRECTORY_NODES * 3);
    expect(loaded.rows.rowsRead - empty.rows.rowsRead).toBeLessThanOrEqual(MAX_DIRECTORY_NODES * (3 + 1));
    const listed = loaded.body.nodes;
    expect([listed.length, loaded.body.truncated]).toEqual([MAX_DIRECTORY_NODES, true]);
    expect(listed.map((n) => n.nodeId)).toEqual(Array.from({ length: MAX_DIRECTORY_NODES }, (_, i) => idOf(i + 1)));
    expect(listed.every((n, i) => n.intake?.queued === 3 && n.intake.oldestQueuedAt === new Date(1_000 * (i + 1) + 1).toISOString())).toBe(true);
    expect(empty.body.nodes.every((n) => n.intake?.queued === 0 && n.intake.oldestQueuedAt === null)).toBe(true);
  });
});
