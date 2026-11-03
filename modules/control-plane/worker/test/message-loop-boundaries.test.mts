import { runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { MessageStore } from "../src/message-store.mts";
import { MessageLoopStore } from "../src/message-loop-store.mts";
import { LOOP_FIELDS } from "../src/message-loop-identity.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { LOOP_IDLE_MS } from "../../protocol-loop-brake.mts";
import { FACTS, registry } from "./helpers.mts";
import { pair } from "./message-loop-fixture.mts";
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
beforeEach(async () => { await query((sql) => { sql.exec("DELETE FROM messages"); sql.exec("DELETE FROM message_tombstones"); sql.exec("DELETE FROM message_loop_pairs"); }); });
const take = async (from: string, to: string, id: string) => {
  await registry().reportMessageStatus(to, { messageId: id, state: "delivered" });
  await registry().ackMessageStatus(from, { name: "message.status.ack", messageId: id, state: "delivered" });
};

it("same-node direction survives ACK tombstones without sessions; new roots cannot supply parity", async () => {
  const { a } = await pair();
  await registry().replaceSessions(a, ["A", "B", "C"].map((sessionId) => ({ sessionId, name: `${sessionId}-alias`, runtime: "codex", state: "running" })));
  const send = (from: string, to: string, parent?: string) => registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: a, session: from }, to: { nodeId: a, session: to }, text: `Synthetic ${crypto.randomUUID()}`, inReplyTo: parent }, "test");
  const root = await send("A", "B"); if (!root.ok) throw new Error(root.error);
  await take(a, a, root.status.messageId);
  const tomb = await query((sql) => sql.exec("SELECT * FROM message_tombstones WHERE id = ?", root.status.messageId).one());
  expect(tomb.loop_direction).toBe(0);
  expect(Object.keys(tomb).some((k) => k.includes("session"))).toBe(false);
  const wrong = await send("A", "B", root.status.messageId); expect(wrong.ok && wrong.status.reason).toBe("loop-lineage-unavailable");
  const unrelated = await send("C", "A", root.status.messageId); expect(unrelated.ok && unrelated.status.state).toBe("refused");
  const reverse = await send("B-alias", "A-alias", root.status.messageId);
  if (!reverse.ok) throw new Error(reverse.error);
  expect(reverse.status.state).toBe("queued");
  expect(reverse.effects.deliveries[0].body.loop).toMatchObject({ depth: 1, threadId: root.status.messageId });
  await take(a, a, reverse.status.messageId);
  const next = await send("A", "B", reverse.status.messageId); expect(next.ok && next.status.state).toBe("queued");
  const fresh = await send("B", "A"); expect(fresh.ok && fresh.effects.deliveries[0].body.loop?.ordinal).toBe(4);
});

it("requires complete retained provenance and eligible state; capability loss never makes guarded legacy", async () => {
  const { a, b, send } = await pair();
  const root = await send(a, b, "Synthetic root"); if (!root.ok) throw new Error(root.error);
  const parent = root.status.messageId;
  const queued = await send(b, a, "Synthetic reply before read", parent);
  expect(queued.ok && queued.status.reason).toBe("loop-lineage-unavailable");
  await take(a, b, parent);
  for (const bad of [null, 2, -1, "x"]) {
    await query((sql) => sql.exec("UPDATE message_tombstones SET loop_direction = ? WHERE id = ?", bad, parent));
    const result = await send(b, a, "Synthetic invalid lineage", parent);
    expect(result.ok && result.status.reason).toBe("loop-lineage-unavailable");
  }
  await query((sql) => sql.exec("UPDATE message_tombstones SET loop_direction = 0 WHERE id = ?", parent));
  // Restore actual canonical bit (random node UUID ordering).
  await query((sql) => sql.exec("UPDATE message_tombstones SET loop_direction = ? WHERE id = ?", a < b ? 0 : 1, parent));
  await registry().updateRegistration(b, FACTS, [], [MESSAGING_CAPABILITY]);
  const downgraded = await send(b, a, "Synthetic downgrade", parent);
  expect(downgraded.ok && downgraded.status.reason).toBe("loop-compatibility: legacy reply limit");
  const unknownMixed = await send(b, a, "Synthetic unknown legacy", crypto.randomUUID());
  expect(unknownMixed.ok && unknownMixed.status.state).toBe("queued");
  expect(unknownMixed.ok && unknownMixed.effects.deliveries[0].body.loop).toBeUndefined();
  await registry().updateRegistration(b, FACTS, [], [MESSAGING_CAPABILITY, "messaging.loop-brake.v1"]);
  await query((sql) => sql.exec("DELETE FROM message_tombstones WHERE id = ?", parent));
  const pruned = await send(b, a, "Synthetic expired lineage", parent);
  expect(pruned.ok && pruned.status.reason).toBe("loop-lineage-unavailable");
});

it("dedup does not score; non-novel normalized repeats hold while novel content resets strikes", async () => {
  const { a, b, send } = await pair();
  for (const text of ["Result １７", " result 17 ", "RESULT 17", "A novel explanatory step 18", "ack", "ok"]) {
    const result = await send(a, b, text); if (!result.ok) throw new Error(result.error);
    expect(result.status.state).toBe("queued");
    const retry = await send(a, b, text, undefined, result.status.messageId);
    expect(retry.ok && retry.status).toEqual(result.status);
    await take(a, b, result.status.messageId);
  }
  const result = await send(b, a, "received");
  expect(result.ok && result.status.state).toBe("refused");
  expect(await query((sql) => sql.exec("SELECT admitted_count FROM message_loop_pairs").one().admitted_count)).toBe(6);
});

it("256 admissions span roots; concurrent candidates cannot bypass the fuse and queued siblings are refused", async () => {
  const { a, b, send } = await pair();
  for (let n = 0; n < 255; n++) {
    const result = await send(a, b, `Synthetic step ${n}`); if (!result.ok) throw new Error(result.error);
    expect(result.status.state).toBe("queued"); await take(a, b, result.status.messageId);
  }
  const results = await Promise.all([send(a, b, "Synthetic step255"), send(b, a, "Synthetic step256")]);
  expect(results.map((r) => r.ok && r.status.state).sort()).toEqual(["queued", "refused"]);
  expect((await registry().pendingMessagesFor(b)).deliveries).toEqual([]);
  const held = await registry().listMessageHolds(10); expect(held[0]).toMatchObject({ admittedCount: 256, reason: "segment-limit" });
});

it("reference-bound pair cleanup, missing-state generation and capacity fail closed", async () => {
  const { a, b, send } = await pair();
  const root = await send(a, b, "Synthetic retained"); if (!root.ok) throw new Error(root.error);
  await take(a, b, root.status.messageId);
  await query((sql) => {
    const store = new MessageLoopStore(sql);
    sql.exec("UPDATE message_loop_pairs SET last_activity = 0");
    store.cleanup(LOOP_IDLE_MS + 1);
    expect(sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs").one().n).toBe(1);
    sql.exec("DELETE FROM message_tombstones");
    store.cleanup(LOOP_IDLE_MS + 1);
    expect(sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs").one().n).toBe(0);
    sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4096)
      INSERT INTO message_loop_pairs(pair_key,from_node,to_node,generation,version,last_activity,admitted_count,no_progress_count,fingerprints)
      SELECT printf('%064x',x),'synthetic-a','synthetic-b',0,0,1,0,0,'[]' FROM n`);
  });
  const capacity = await send(a, b, "Synthetic new pair"); expect(capacity.ok && capacity.status.reason).toBe("loop-capacity");
});

it("preparation rechecks alias/capability/parent state, and SQL rollback keeps message and pair atomic", async () => {
  const { a, b } = await pair();
  await runInDurableObject(registry(), async (_i, state) => {
    const sql = state.storage.sql;
    const caps = (nodeId: string) => JSON.parse(String(sql.exec("SELECT capabilities FROM nodes WHERE id = ?", nodeId).one().capabilities)) as string[];
    const store = new MessageStore(sql, () => {}, caps);
    const sign = async (_d: string, v: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const message = { messageId: crypto.randomUUID(), from: { nodeId: a, session: "alias" }, to: { nodeId: b, session: "session" }, text: "Synthetic race" };
    const prepared = await store.prepare(message, sign);
    sql.exec("UPDATE sessions SET name = 'renamed' WHERE node_id = ?", a);
    const changed = state.storage.transactionSync(() => store.send(message, "test", Date.now(), prepared));
    expect(changed.ok && changed.status.reason).toBe("loop-context-changed");
    expect(sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs").one().n).toBe(0);
    const next = { ...message, messageId: crypto.randomUUID(), from: { nodeId: a, session: "session" } };
    const fresh = await store.prepare(next, sign);
    expect(() => state.storage.transactionSync(() => { store.send(next, "test", Date.now(), fresh); throw new Error("synthetic rollback"); })).toThrow("synthetic rollback");
    expect(sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs").one().n).toBe(0);
    expect(sql.exec("SELECT id FROM messages WHERE id = ?", next.messageId).toArray()).toEqual([]);
    expect(LOOP_FIELDS).toContain("loop_direction");
  });
});

it("guarded proxy requires the live original, retains its own bit, and cannot mark the original read", async () => {
  const { a, b, send } = await pair();
  const root = await send(a, b, "Synthetic original question"); if (!root.ok) throw new Error(root.error);
  await registry().reportMessageStatus(b, { messageId: root.status.messageId, state: "accepted" });
  const proxy = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: b, session: "session" },
    to: { nodeId: a, session: "session" }, text: "Synthetic proxy result", proxyOf: root.status.messageId }, "test");
  if (!proxy.ok) throw new Error(proxy.error);
  expect(proxy.status.state).toBe("queued");
  expect((await registry().mcpMessageStatus(a, root.status.messageId))?.state).toBe("accepted");
  await take(b, a, proxy.status.messageId);
  const reply = await send(a, b, "Synthetic reply to deleted proxy", proxy.status.messageId);
  expect(reply.ok && reply.status.state).toBe("queued");
  await take(a, b, root.status.messageId);
  const missing = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: b, session: "session" },
    to: { nodeId: a, session: "session" }, text: "Synthetic invalid proxy", proxyOf: root.status.messageId }, "test");
  expect(missing.ok && missing.status.reason).toBe("proxy parent unknown");
});

it("invalid ordinals/generations/partial storage, future generation and absent current pair cannot reconstruct admission", async () => {
  const { a, b, send } = await pair();
  const root = await send(a, b, "Synthetic provenance"); if (!root.ok) throw new Error(root.error);
  await take(a, b, root.status.messageId);
  const original = await query((sql) => sql.exec("SELECT * FROM message_tombstones WHERE id = ?", root.status.messageId).one());
  for (const [field, bad] of [["loop_generation", -1], ["loop_ordinal", 0], ["loop_ordinal", 257], ["loop_thread", null], ["depth", -1], ["loop_generation", 10]] as const) {
    await query((sql) => sql.exec(`UPDATE message_tombstones SET ${field} = ? WHERE id = ?`, bad, root.status.messageId));
    const result = await send(b, a, "Synthetic invalid metadata", root.status.messageId);
    expect(result.ok && result.status.reason).toBe("loop-lineage-unavailable");
    await query((sql) => sql.exec(`UPDATE message_tombstones SET ${field} = ? WHERE id = ?`, original[field], root.status.messageId));
  }
  await query((sql) => sql.exec("DELETE FROM message_loop_pairs"));
  const result = await send(b, a, "Synthetic missing pair", root.status.messageId);
  expect(result.ok && result.status.reason).toBe("loop-lineage-unavailable");
  expect(await query((sql) => sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs").one().n)).toBe(0);
});

it("queued downgrade refuses before replay, and alias ambiguity never obtains advanced lineage", async () => {
  const { a, b, send } = await pair();
  const root = await send(a, b, "Synthetic queued result"); if (!root.ok) throw new Error(root.error);
  await registry().updateRegistration(a, FACTS, [], [MESSAGING_CAPABILITY]);
  expect(await registry().messageDeliveryReady(root.status.messageId)).toBe(false);
  expect((await registry().mcpMessageStatus(a, root.status.messageId))?.reason).toBe("loop-compatibility: legacy reply limit");
  await registry().updateRegistration(a, FACTS, [], [MESSAGING_CAPABILITY, "messaging.loop-brake.v1"]);
  await registry().replaceSessions(b, ["one", "two"].map((sessionId) => ({ sessionId, name: "ambiguous", runtime: "codex", state: "running" })));
  const unknown = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: a, session: "session" },
    to: { nodeId: b, session: "ambiguous" }, text: "Synthetic unknown parent", inReplyTo: crypto.randomUUID() }, "test");
  expect(unknown.ok && unknown.status.reason).toBe("loop-lineage-unavailable");
});
