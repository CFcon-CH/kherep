import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { handleApi } from "../src/api.mts";
import type { Env } from "../src/env.mts";
import { MessageLoopStore } from "../src/message-loop-store.mts";
import { LOOP_SEGMENT, LOOP_SEGMENT_IDLE_MS } from "../../protocol-loop-brake.mts";
import { BASE, registry } from "./helpers.mts";
import { pair } from "./message-loop-fixture.mts";
// Issue #946: the segment fuse counts one idle-separated activity window, not the pair's lifetime.
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const pairRow = () => query((sql) => sql.exec("SELECT * FROM message_loop_pairs").toArray());
const age = (ms: number, count?: number) => query((sql) => count === undefined
  ? sql.exec("UPDATE message_loop_pairs SET last_activity = ?", Date.now() - ms)
  : sql.exec("UPDATE message_loop_pairs SET last_activity = ?, admitted_count = ?", Date.now() - ms, count));
beforeEach(async () => { await query((sql) => { sql.exec("DELETE FROM messages"); sql.exec("DELETE FROM message_tombstones"); sql.exec("DELETE FROM message_loop_pairs"); }); });
const take = async (from: string, to: string, id: string) => {
  await registry().reportMessageStatus(to, { messageId: id, state: "delivered" });
  await registry().ackMessageStatus(from, { name: "message.status.ack", messageId: id, state: "delivered" });
};
const sent = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error(String((r as { error?: unknown }).error)); return r as Extract<T, { ok: true }>; };

it("256 admissions then 6 h idle with tombstones present start a new segment on the same pair row", async () => {
  const { a, b, send } = await pair();
  for (let n = 0; n < LOOP_SEGMENT; n++) await take(a, b, sent(await send(a, b, `Synthetic step ${n}`)).status.messageId);
  const before = (await pairRow())[0];
  expect(await query((sql) => sql.exec("SELECT COUNT(*) AS n FROM message_tombstones").one().n)).toBeGreaterThan(0);
  await age(LOOP_SEGMENT_IDLE_MS);
  const next = sent(await send(a, b, "Synthetic step after the night"));
  expect(next.status.state).toBe("queued");
  expect(next.effects.deliveries[0].body.loop).toMatchObject({ generation: 1, ordinal: 1 });
  const rows = await pairRow();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ generation: 1, admitted_count: 1, version: before.version, no_progress_count: 0, hold_id: null });
});

it("a reply to a generation-0 parent is admitted after the idle reset", async () => {
  const { a, b, send } = await pair();
  const root = sent(await send(a, b, "Synthetic question 1")).status.messageId;
  await take(a, b, root);
  await age(LOOP_SEGMENT_IDLE_MS, LOOP_SEGMENT);
  const reply = sent(await send(b, a, "Synthetic answer 42", root));
  expect(reply.status.state).toBe("queued");
  expect(reply.effects.deliveries[0].body.loop).toMatchObject({ generation: 1, ordinal: 1, depth: 1, threadId: root });
});

it("ack strikes survive the idle reset, so waiting cannot bypass ack-or-repeat", async () => {
  const { a, b, send } = await pair();
  for (const text of ["ack", "ok"]) await take(a, b, sent(await send(a, b, text)).status.messageId);
  await age(LOOP_SEGMENT_IDLE_MS);
  const third = sent(await send(a, b, "received"));
  expect(third.status.reason).toMatch(/^loop-held: ack-or-repeat; /);
  expect(await registry().listMessageHolds(10)).toMatchObject([{ reason: "ack-or-repeat", generation: 1, admittedCount: 0, noProgressCount: 3 }]);
});

it("an earlier queued message stays deliverable across the idle reset and can be answered", async () => {
  const { a, b, send } = await pair();
  const queued = sent(await send(a, b, "Synthetic queued result 7")).status.messageId;
  await age(LOOP_SEGMENT_IDLE_MS, LOOP_SEGMENT);
  const later = sent(await send(a, b, "Synthetic later result 8"));
  expect(later.status.state).toBe("queued");
  expect(later.effects.deliveries[0].body.loop).toMatchObject({ generation: 1, ordinal: 1 });
  expect(await registry().messageDeliveryReady(queued)).toBe(true);
  const pending = (await registry().pendingMessagesFor(b)).deliveries.map((d) => d.body.messageId);
  expect([...pending].sort((x, y) => x.localeCompare(y))).toEqual([queued, later.status.messageId].sort((x, y) => x.localeCompare(y)));
  await take(a, b, queued);
  const reply = sent(await send(b, a, "Synthetic answer to 7", queued));
  expect(reply.effects.deliveries[0].body.loop).toMatchObject({ generation: 1, ordinal: 2, depth: 1, threadId: queued });
});

it("a held pair idle over 6 h stays held with the same hold and generation", async () => {
  const { a, b, send } = await pair();
  for (const text of ["ack", "ok"]) await take(a, b, sent(await send(a, b, text)).status.messageId);
  const reason = sent(await send(a, b, "received")).status.reason;
  await age(LOOP_SEGMENT_IDLE_MS + 60 * 60_000);
  const after = sent(await send(a, b, "Synthetic novel result 9"));
  expect(after.status.reason).toBe(reason);
  expect((await pairRow())[0]).toMatchObject({ generation: 0, admitted_count: 2 });
});

it("256 admissions without a 6 h gap roll the segment instead of holding (#1016)", async () => {
  for (const idle of [0, LOOP_SEGMENT_IDLE_MS - 60_000]) {
    const { a, b, send } = await pair();
    await take(a, b, sent(await send(a, b, "Synthetic first result")).status.messageId);
    await age(idle, LOOP_SEGMENT);
    const next = sent(await send(a, b, "Synthetic over the fuse"));
    expect(next.status.state).toBe("queued");
    expect(next.effects.deliveries[0].body.loop).toMatchObject({ generation: 1, ordinal: 1 });
  }
  expect(await registry().listMessageHolds(10)).toEqual([]);
});

it("a released pair idle over 6 h keeps the release generation; an empty segment is not reset again", async () => {
  const { a, b, send } = await pair();
  for (const text of ["ack", "ok"]) await take(a, b, sent(await send(a, b, text)).status.messageId);
  sent(await send(a, b, "received"));
  const [hold] = await registry().listMessageHolds(10);
  const path = `${BASE}/api/message-holds/${hold.holdId}/release`;
  const released = await handleApi(new Request(path, { method: "POST", body: JSON.stringify({ expectedVersion: hold.version }) }), env as Env, "synthetic-verified-operator");
  expect(released.status).toBe(200);
  await age(LOOP_SEGMENT_IDLE_MS);
  const next = sent(await send(a, b, "Synthetic novel result 10"));
  expect(next.effects.deliveries[0].body.loop).toMatchObject({ generation: 1, ordinal: 1 });
});

it("store boundary: exactly 6 h resets, 1 ms less does not, a full segment rolls, and generation overflow fails closed", async () => {
  await query((sql) => {
    const store = new MessageLoopStore(sql);
    const seed = (key: string, generation: number, count: number) => sql.exec(`INSERT INTO message_loop_pairs (pair_key, from_node, to_node, generation, version,
      last_activity, admitted_count, no_progress_count, fingerprints) VALUES (?, 'synthetic-a', 'synthetic-b', ?, 0, 0, ?, 0, '[]')`, key, generation, count);
    const admit = (key: string, now: number, n: number) => store.admit({ key, fromNode: "synthetic-a", toNode: "synthetic-b", messageId: crypto.randomUUID(),
      threadId: crypto.randomUUID(), depth: 0, signal: { fingerprint: n.toString(16).padStart(64, "0"), acknowledgement: false }, now });
    const row = (key: string) => sql.exec("SELECT generation, admitted_count FROM message_loop_pairs WHERE pair_key = ?", key).one();
    seed("a".repeat(64), 0, 1); seed("c".repeat(64), 0, 1); seed("d".repeat(64), 0, LOOP_SEGMENT);
    seed("b".repeat(64), Number.MAX_SAFE_INTEGER, 1); seed("e".repeat(64), Number.MAX_SAFE_INTEGER, LOOP_SEGMENT);
    expect(admit("a".repeat(64), LOOP_SEGMENT_IDLE_MS - 1, 1)).toMatchObject({ loop: { generation: 0, ordinal: 2 } });
    expect(admit("c".repeat(64), LOOP_SEGMENT_IDLE_MS, 2)).toMatchObject({ loop: { generation: 1, ordinal: 1 } });
    expect(admit("d".repeat(64), LOOP_SEGMENT_IDLE_MS - 1, 3)).toMatchObject({ loop: { generation: 1, ordinal: 1 } });
    expect(() => admit("b".repeat(64), LOOP_SEGMENT_IDLE_MS, 4)).toThrow("loop-state-unavailable");
    expect(row("b".repeat(64))).toEqual({ generation: Number.MAX_SAFE_INTEGER, admitted_count: 1 });
    expect(() => admit("e".repeat(64), LOOP_SEGMENT_IDLE_MS - 1, 5)).toThrow("loop-state-unavailable");
    expect(row("e".repeat(64))).toEqual({ generation: Number.MAX_SAFE_INTEGER, admitted_count: LOOP_SEGMENT });
  });
});
