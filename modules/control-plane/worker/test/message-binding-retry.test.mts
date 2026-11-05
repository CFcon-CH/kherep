import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { attestedPair, attestedRows, ID_A, ID_B } from "./message-loop-fixture.mts";
import { registry } from "./helpers.mts";
import type { NewMessage } from "../src/message-store.mts";
import { bindingContext } from "../src/message-binding.mts";
import { egressBinding } from "../src/message-egress-binding.mts";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
for (const identity of [null, '[1,"codex",0,"codex",0]']) it(`required historical unbound egress cannot acquire binding, proof=${identity !== null}`, async () => {
  const f = await attestedPair();
  await query(sql => {
    const message = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B } };
    const row = { id: message.messageId, from_node: f.nodeId, from_session: ID_A, to_node: f.nodeId, to_session: ID_B,
      delivery_binding: null, delivery_pair: null, loop_identity: identity };
    const owner = (sessionId: string) => ({ sessionId, runtime: "codex", lifecycleGeneration: null });
    const prepared = { stamp: bindingContext(sql, message).stamp, binding: { version: 1 as const, mode: "exact" as const,
      from: owner(ID_A), to: owner(ID_B) }, denyKey: null, leaseId: crypto.randomUUID(), localGeneration: null };
    expect(egressBinding(sql, row, prepared, true)).toBeNull();
  });
});
const capture = (id: string, nodeId: string) => query(sql => ({
  row: sql.exec("SELECT * FROM messages WHERE id=?", id).one(),
  pairs: sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=? OR to_node=?", nodeId, nodeId).toArray(),
  audit: sql.exec("SELECT COUNT(*) AS n FROM audit").one().n,
}));
async function legacyParent(f: Awaited<ReturnType<typeof attestedPair>>, rows = attestedRows(), from = ID_B, to = ID_A) {
  await registry().replaceSessions(f.nodeId, rows.map(({ canonicalIdentity, ...row }) => ({ ...row, state: "unknown" })), { version: 1, generation: 2 });
  const parent = await f.send(from, to, undefined, "Synthetic legacy parent");
  if (!parent.ok) throw new Error(parent.error);
  expect(parent.effects.deliveries[0].body.loop).toBeUndefined();
  await registry().reportMessageStatus(f.nodeId, { messageId: parent.status.messageId, state: "delivered" });
  await registry().replaceSessions(f.nodeId, rows, { version: 1, generation: 3 });
  return parent.status.messageId;
}
for (const selected of ["unavailable", "disagreeing"] as const) it(`A2: attested legacy parent stays unbound outside held scope with ${selected} optional selection`, async () => {
  const f = await attestedPair(), parent = await legacyParent(f);
  f.setRows(selected === "unavailable" ? [] : attestedRows().map(r => ({ sessionId: r.sessionId, runtime: r.runtime, lifecycleGeneration: 1 })));
  const result = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic legacy reply", inReplyTo: parent }, "synthetic");
  expect(result.ok && result.status.state).toBe("queued"); if (!result.ok) throw new Error(result.error);
  expect(result.effects.deliveries[0].body.loop).toBeUndefined();
  const row = await query(sql => sql.exec("SELECT delivery_binding,delivery_pair,loop_pair,loop_identity,depth FROM messages WHERE id=?", result.status.messageId).one());
  expect(row).toEqual({ delivery_binding: null, delivery_pair: null, loop_pair: null, loop_identity: null, depth: 1 });
  expect(await query(sql => sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs WHERE from_node=?", f.nodeId).one().n)).toBe(0);
});

for (const state of ["queued", "accepted"] as const) {
  for (const variant of ["source", "source-node", "target", "target-node", "source-runtime", "target-runtime", "source-incarnation", "target-incarnation", "alias-reassigned", "target-alias-reassigned", "unavailable", "stale-epoch", "inReplyTo", "proxyOf", "taskId", "text", "invalid-binding"] as const) {
    it(`A3: ${state} bound retry refuses changed ${variant} without effects, score or row mutation`, async () => {
      const f = await attestedPair();
      const message: NewMessage = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic immutable retry" };
      const first = await registry().sendMessage(message, "synthetic"); expect(first.ok && first.status.state).toBe("queued");
      if (state === "accepted") await registry().reportMessageStatus(f.nodeId, { messageId: message.messageId, state });
      let rows = [...attestedRows().map(r => ({ sessionId: r.sessionId, runtime: r.runtime, name: r.name })), { sessionId: ID_C, runtime: "codex", name: "other" }];
      const retry = structuredClone(message);
      if (variant === "source") retry.from.session = ID_C;
      if (variant === "source-node") { const source = await attestedPair(); retry.from.nodeId = source.nodeId; }
      if (variant === "target") retry.to.session = ID_C;
      if (variant === "target-node") { const target = await attestedPair(); retry.to.nodeId = target.nodeId; }
      if (variant === "source-runtime" || variant === "target-runtime") {
        const index = variant === "source-runtime" ? 0 : 1; rows[index].runtime = "claude";
        await registry().replaceSessions(f.nodeId, attestedRows().map((r,i) => i === index ? { sessionId: r.sessionId, runtime: "claude", state: "running" } : r), { version: 1, generation: 2 });
      }
      if (variant === "alias-reassigned") { retry.from.session = "alias-0"; rows[0].name = "moved"; rows[2].name = "alias-0";
        await registry().replaceSessions(f.nodeId, attestedRows().map(r => ({ ...r, name: r.sessionId === ID_A ? "moved" : r.name })), { version: 1, generation: 2 }); }
      if (variant === "target-alias-reassigned") { retry.to.session = "alias-1"; rows[1].name = "moved"; rows[2].name = "alias-1";
        await registry().replaceSessions(f.nodeId, attestedRows().map(r => ({ ...r, name: r.sessionId === ID_B ? "moved" : r.name })), { version: 1, generation: 2 }); }
      if (variant === "unavailable") rows = [];
      if (variant === "source-incarnation" || variant === "target-incarnation") rows = rows.map((r,i) => ({ ...r, lifecycleGeneration: i === (variant === "source-incarnation" ? 0 : 1) ? 1 : null }));
      if (variant === "stale-epoch") retry.connectionToken = "stale-synthetic-connection";
      if (variant === "inReplyTo") retry.inReplyTo = crypto.randomUUID();
      if (variant === "proxyOf") retry.proxyOf = crypto.randomUUID();
      if (variant === "taskId") await query(sql => sql.exec("UPDATE messages SET task_id=? WHERE id=?", crypto.randomUUID(), message.messageId));
      if (variant === "text") retry.text = "Synthetic different body";
      if (variant === "invalid-binding") await query(sql => sql.exec("UPDATE messages SET delivery_binding=? WHERE id=?", '{"version":2}', message.messageId));
      f.setRows(rows);
      const before = await capture(message.messageId, f.nodeId);
      const result = await registry().sendMessage(retry, "synthetic");
      // Accepted bodies have already been erased; this tranche adds no body retention.
      if (variant === "text" && state === "accepted") expect(result.ok && result.status.state).toBe("accepted");
      else expect(result.ok).toBe(false);
      if (result.ok) expect(result.effects.deliveries).toEqual([]);
      expect(await capture(message.messageId, f.nodeId)).toEqual(before);
    });
  }
  it(`A3: ${state} same exact owner through another alias recovers canonical status without fresh effects`, async () => {
    const f = await attestedPair();
    const message: NewMessage = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic same owner" };
    await registry().sendMessage(message, "synthetic");
    if (state === "accepted") await registry().reportMessageStatus(f.nodeId, { messageId: message.messageId, state });
    const before = await capture(message.messageId, f.nodeId);
    const r = await registry().sendMessage({ ...message, from: { nodeId: f.nodeId, session: "alias-0" }, to: { nodeId: f.nodeId, session: "alias-1" } }, "synthetic");
    expect(r.ok && r.status.state).toBe(state); expect(r.ok && r.effects.deliveries).toEqual([]);
    expect(await capture(message.messageId, f.nodeId)).toEqual(before);
  });
}

for (const selected of ["unavailable", "resolved"] as const) it(`A2: legacy parent in held node scope requires ${selected} exact unrelated owners without changing the hold`, async () => {
  const f = await attestedPair(), D = crypto.randomUUID();
  const unrelated = attestedRows().map((r,i) => ({ ...r, sessionId: i === 0 ? ID_C : D, name: `other-${i}`,
    canonicalIdentity: { ...r.canonicalIdentity!, sessionId: i === 0 ? ID_C : D } }));
  const parent = await legacyParent(f, unrelated, D, ID_C);
  await registry().replaceSessions(f.nodeId, [...attestedRows(), ...unrelated], { version: 1, generation: 4 });
  for (let i = 0; i < 3; i++) { const r = await f.send(ID_A, ID_B, undefined, "ack"); if (r.ok && i < 2) await f.take(r.status.messageId); }
  const before = await query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray());
  expect(before).toHaveLength(1); expect(before[0].hold_id).not.toBeNull();
  f.setRows(selected === "unavailable" ? [] : unrelated.map(r => ({ sessionId: r.sessionId, runtime: r.runtime, name: r.name })));
  const r = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_C }, to: { nodeId: f.nodeId, session: D }, text: "Synthetic scoped legacy child", inReplyTo: parent }, "synthetic");
  expect(r.ok && r.status).toMatchObject(selected === "unavailable" ? { state: "refused", reason: "loop-resolution-required" } : { state: "queued" });
  if (!r.ok) throw new Error(r.error);
  expect(r.effects.deliveries.length).toBe(selected === "unavailable" ? 0 : 1);
  expect(await query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray())).toEqual(before);
  const row = await query(sql => sql.exec("SELECT loop_pair,delivery_binding FROM messages WHERE id=?", r.status.messageId).one());
  expect(row.loop_pair).toBeNull(); expect(row.delivery_binding === null).toBe(selected === "unavailable");
});

for (const state of ["queued", "accepted"] as const) it(`A3: ${state} retry permits a fresh observation epoch while selected RPC awaits`, async () => {
  const f = await attestedPair();
  const message = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic epoch race" };
  await registry().sendMessage(message, "synthetic");
  if (state === "accepted") await registry().reportMessageStatus(f.nodeId, { messageId: message.messageId, state });
  let afterEpoch: Awaited<ReturnType<typeof capture>> | undefined;
  f.beforeResponse(async () => {
    await registry().replaceSessions(f.nodeId, attestedRows(), { version: 1, generation: 2 });
    afterEpoch = await capture(message.messageId, f.nodeId);
  });
  const replay = await registry().sendMessage(message, "synthetic");
  expect(replay.ok && replay.status.state).toBe(state);
  expect(replay.ok && replay.effects.deliveries).toEqual([]);
  expect(afterEpoch).toBeDefined(); expect(await capture(message.messageId, f.nodeId)).toEqual(afterEpoch);
});

it("D2: payload-bearing tombstone retries refuse while Node-authorized historical status remains available", async () => {
  const f = await attestedPair();
  const message: NewMessage = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A },
    to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic body that must not return" };
  const first = await registry().sendMessage(message, "synthetic"); expect(first.ok).toBe(true);
  await f.take(message.messageId);
  const snapshot = () => query(sql => ({
    stone: sql.exec("SELECT * FROM message_tombstones WHERE id=?", message.messageId).one(),
    rows: sql.exec("SELECT * FROM messages WHERE id=?", message.messageId).toArray(),
    pairs: sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray(),
    audit: sql.exec("SELECT COUNT(*) AS n FROM audit").one().n,
  }));
  const before = await snapshot(); expect(before.rows).toEqual([]);
  for (const patch of [{}, { from: { nodeId: f.nodeId, session: ID_C } }, { text: "Changed synthetic payload" },
    { to: { nodeId: crypto.randomUUID(), session: ID_B } }]) {
    expect(await registry().sendMessage({ ...message, ...patch }, "synthetic")).toEqual({ ok: false, error: "duplicate messageId" });
    expect(await snapshot()).toEqual(before);
  }
  expect(await registry().mcpMessageStatus(f.nodeId, message.messageId)).toMatchObject({ state: "delivered" });
  expect(JSON.stringify(before.stone)).not.toContain(message.text);
});
