import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { prepareMessageBinding } from "../src/message-binding.mts";
import { MessageStore } from "../src/message-store.mts";
import type { LoopSigner } from "../src/message-loop-signals.mts";
import { registry, session } from "./helpers.mts";
import { attestedPair, attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const pairs = (nodeId: string) => query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=? OR to_node=?", nodeId, nodeId).toArray());
const digest: LoopSigner = async (_domain, value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
async function retainedPair() {
  const f = await attestedPair(), root = await f.send();
  if (!root.ok) throw new Error(root.error);
  await f.take(root.status.messageId);
  expect(await pairs(f.nodeId)).toHaveLength(1);
  return f;
}
async function refusedCandidate(nodeId: string, messageId: string) {
  const row = await query(sql => sql.exec("SELECT state,reason,text,delivery_binding,delivery_pair,loop_pair,loop_identity FROM messages WHERE id=?", messageId).one());
  expect(row).toEqual({ state: "refused", reason: "loop-context-changed", text: null, delivery_binding: null, delivery_pair: null, loop_pair: null, loop_identity: null });
  expect((await registry().pendingMessagesFor(nodeId)).deliveries).toEqual([]);
}
for (const change of ["source alias", "source connection token"] as const) it(`S16: selected-response pause refuses changed ${change} without redirect or score`, async () => {
  const f = await retainedPair(), before = await pairs(f.nodeId), token = crypto.randomUUID();
  let paused = false;
  f.beforeResponse(async () => {
    paused = true;
    if (change === "source alias") {
      const rows = attestedRows(); rows[0].name = "moved";
      rows.push({ ...rows[0], sessionId: ID_C, name: "alias-0", canonicalIdentity: { ...rows[0].canonicalIdentity!, sessionId: ID_C } });
      await registry().replaceSessions(f.nodeId, rows, { version: 1, generation: 2 });
      f.setRows(rows);
    } else expect(await registry().beginMessageConnection(f.nodeId, token)).toBe(true);
  });
  const messageId = crypto.randomUUID();
  try {
    const result = await registry().sendMessage({ messageId, from: { nodeId: f.nodeId, session: "alias-0" }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic selected-response boundary" }, "synthetic");
    expect(paused).toBe(true);
    expect(result.ok && result.status.reason).toBe("loop-context-changed");
    expect(result.ok && result.effects.deliveries).toEqual([]);
    await refusedCandidate(f.nodeId, messageId);
    expect(await pairs(f.nodeId)).toEqual(before);
  } finally { if (change === "source connection token") await registry().invalidateMessageConnection(f.nodeId, token); }
});
for (const change of ["source alias", "source connection token"] as const) it(`S16: selected deny-key signer pause refuses changed ${change} with original owner pinned`, async () => {
  const f = await retainedPair(), token = crypto.randomUUID();
  const rows = attestedRows();
  rows.push({ ...rows[0], sessionId: ID_C, name: "other", canonicalIdentity: { ...rows[0].canonicalIdentity!, sessionId: ID_C } });
  await registry().replaceSessions(f.nodeId, rows, { version: 1, generation: 2 }); f.setRows(rows);
  const before = await pairs(f.nodeId), messageId = crypto.randomUUID();
  try {
    await runInDurableObject(registry(), async (_i, state) => {
      const sql = state.storage.sql, store = new MessageStore(sql, () => {}, () => BRAKE_CAPS);
      const message = { messageId, from: { nodeId: f.nodeId, session: "alias-0" }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic selected signer boundary" };
      const prepared = await store.prepare(message, digest);
      let paused = false;
      const binding = await prepareMessageBinding(sql, message, async (domain, value) => {
        expect(domain).toBe("kherep-loop-pair-v1");
        await Promise.resolve(); paused = true;
        if (change === "source alias") {
          sql.exec("UPDATE sessions SET name='moved' WHERE node_id=? AND session_id=?", f.nodeId, ID_A);
          sql.exec("UPDATE sessions SET name='alias-0' WHERE node_id=? AND session_id=?", f.nodeId, ID_C);
        } else sql.exec("UPDATE nodes SET message_connection_token=?,registration_token=NULL WHERE id=?", token, f.nodeId);
        return digest(domain, value);
      }, (nodeId, request) => session(nodeId).resolveMessageReferences(request));
      expect(paused).toBe(true);
      expect(binding.binding?.from.sessionId).toBe(ID_A);
      expect(binding.binding?.to.sessionId).toBe(ID_B);
      const result = state.storage.transactionSync(() => store.send(message, "synthetic", Date.now(), { ...prepared, binding }));
      expect(result.ok && result.status.reason).toBe("loop-context-changed");
      expect(result.ok && result.effects.deliveries).toEqual([]);
    });
    await refusedCandidate(f.nodeId, messageId);
    expect(await pairs(f.nodeId)).toEqual(before);
  } finally { if (change === "source connection token") await registry().invalidateMessageConnection(f.nodeId, token); }
});
it("S20: release during local-only selected response preserves terminal work and permits current-generation continuation", async () => {
  const f = await attestedPair(); let parent = "";
  for (let i = 0; i < 3; i++) {
    const result = await f.send(ID_A, ID_B, undefined, "ack");
    if (!result.ok) throw new Error(result.error);
    if (i < 2) { parent = result.status.messageId; await f.take(parent); }
    else expect(result.status.state).toBe("refused");
  }
  const hold = (await registry().listMessageHolds(50)).find(h => h.fromNode === f.nodeId)!;
  expect(hold).toBeDefined();
  const oldWork = () => query(sql => ({
    trigger: sql.exec("SELECT * FROM messages WHERE id=?", hold.triggerMessageId).one(),
    tombstone: sql.exec("SELECT * FROM message_tombstones WHERE id=?", parent).one(),
  }));
  const old = await oldWork(); expect(old.trigger.text).toBeNull();
  await registry().replaceSessions(f.nodeId, []);
  f.setLocalRows([{ sessionId: ID_A, runtime: "codex", name: "never-published-source" }, { sessionId: ID_B, runtime: "codex", name: "never-published-target" }]);
  let paused = false, released: Awaited<ReturnType<ReturnType<typeof registry>["releaseMessageHold"]>> | undefined;
  let afterRelease: Awaited<ReturnType<typeof pairs>> | undefined;
  f.beforeResponse(async () => {
    paused = true;
    expect((await registry().releaseMessageHold(String(hold.holdId), Number(hold.version) + 1, "synthetic")).status).toBe(409);
    released = await registry().releaseMessageHold(String(hold.holdId), Number(hold.version), "synthetic");
    expect(released).toMatchObject({ status: 200, generation: 1, version: Number(hold.version) + 1, changed: true });
    expect(await registry().releaseMessageHold(String(hold.holdId), Number(hold.version), "synthetic")).toEqual({ status: 200, holdId: hold.holdId, generation: 1, version: Number(hold.version) + 1 });
    afterRelease = await pairs(f.nodeId);
  });
  const messageId = crypto.randomUUID();
  const result = await registry().sendMessage({ messageId, from: { nodeId: f.nodeId, session: "never-published-source" }, to: { nodeId: f.nodeId, session: "never-published-target" }, text: "Synthetic new legacy work after release" }, "synthetic");
  expect(paused).toBe(true); expect(released?.status).toBe(200);
  expect(result.ok && result.status.state).toBe("queued");
  if (!result.ok) throw new Error(result.error);
  expect(result.effects.deliveries.map(d => d.body.messageId)).toEqual([messageId]);
  expect(result.effects.deliveries[0].body.loop).toBeUndefined();
  expect(await pairs(f.nodeId)).toEqual(afterRelease);
  expect(await oldWork()).toEqual(old);
  expect((await registry().pendingMessagesFor(f.nodeId)).deliveries.map(d => d.body.messageId)).toEqual([messageId]);
  await f.take(messageId);
  await registry().replaceSessions(f.nodeId, attestedRows(), { version: 1, generation: 2 });
  f.setLocalRows(attestedRows().map(({ sessionId, runtime, name }) => ({ sessionId, runtime, name: name! })));
  const refused = await f.send(ID_B, ID_A, String(hold.triggerMessageId), "Synthetic forbidden trigger continuation");
  expect(refused.ok && refused.status.reason).toBe("loop-lineage-unavailable");
  expect(refused.ok && refused.effects.deliveries).toEqual([]);
  expect(await oldWork()).toEqual(old);
  expect(await pairs(f.nodeId)).toEqual(afterRelease);
  const continued = await f.send(ID_B, ID_A, parent, "Synthetic legitimate delivered-parent result");
  if (!continued.ok) throw new Error(continued.error);
  expect(continued.status.state).toBe("queued");
  expect(continued.effects.deliveries[0].body.loop).toMatchObject({ generation: 1, ordinal: 1, depth: 1, threadId: parent });
  const current = await pairs(f.nodeId);
  expect(await registry().releaseMessageHold(String(hold.holdId), Number(hold.version), "synthetic")).toEqual({ status: 200, holdId: hold.holdId, generation: 1, version: Number(hold.version) + 1 });
  expect(await pairs(f.nodeId)).toEqual(current);
  expect(await oldWork()).toEqual(old);
});
it("S26: selected negative-only signer rejection refuses without body, score or signer replacement", async () => {
  const f = await attestedPair();
  for (let i = 0; i < 3; i++) {
    const result = await f.send(ID_A, ID_B, undefined, "ack");
    if (!result.ok) throw new Error(result.error);
    if (i < 2) await f.take(result.status.messageId);
    else expect(result.status.state).toBe("refused");
  }
  const before = await pairs(f.nodeId);
  expect(before).toHaveLength(1); expect(before[0].hold_id).not.toBeNull();
  await registry().replaceSessions(f.nodeId, []);
  f.setLocalRows([{ sessionId: ID_A, runtime: "codex", name: "local-negative-source" }, { sessionId: ID_B, runtime: "codex", name: "local-negative-target" }]);
  const messageId = crypto.randomUUID();
  await runInDurableObject(registry(), async (_i, state) => {
    const sql = state.storage.sql, store = new MessageStore(sql, () => {}, () => BRAKE_CAPS);
    const secretBefore = await state.storage.get<Uint8Array>("loop-hmac-v1");
    expect(secretBefore instanceof Uint8Array && secretBefore.length === 32).toBe(true);
    const message = { messageId, from: { nodeId: f.nodeId, session: "local-negative-source" }, to: { nodeId: f.nodeId, session: "local-negative-target" }, text: "Synthetic body must never persist" };
    const domains: string[] = [];
    const rejecting: LoopSigner = async domain => { domains.push(domain); throw new Error("synthetic deny signer unavailable"); };
    const prepared = await store.prepare(message, async (domain, value) => { domains.push(domain); return digest(domain, value); });
    expect(prepared.snapshot).toMatchObject({ from: null, to: null, identityBinding: null, compatibility: false });
    expect(prepared.error).toBeUndefined(); expect(prepared.signal).toBeNull();
    expect(domains).toEqual(["kherep-loop-pair-v1"]);
    domains.length = 0;
    const binding = await prepareMessageBinding(sql, message, rejecting, (nodeId, request) => session(nodeId).resolveMessageReferences(request));
    expect(domains).toEqual(["kherep-loop-pair-v1"]);
    expect(binding).toMatchObject({ error: "loop-crypto-unavailable", binding: null, denyKey: null });
    const result = state.storage.transactionSync(() => store.send(message, "synthetic", Date.now(), { ...prepared, binding }));
    expect(result.ok && result.status.reason).toBe("loop-crypto-unavailable");
    expect(result.ok && result.effects.deliveries).toEqual([]);
    expect(sql.exec("SELECT state,reason,text,delivery_binding,delivery_pair,loop_pair,loop_identity FROM messages WHERE id=?", messageId).one())
      .toEqual({ state: "refused", reason: "loop-crypto-unavailable", text: null, delivery_binding: null, delivery_pair: null, loop_pair: null, loop_identity: null });
    const secretAfter = await state.storage.get<Uint8Array>("loop-hmac-v1");
    // Compare locally as a boolean so a failed assertion cannot print signer bytes.
    expect(secretAfter instanceof Uint8Array && secretBefore instanceof Uint8Array
      && secretAfter.length === secretBefore.length && secretAfter.every((byte, i) => byte === secretBefore[i])).toBe(true);
  });
  expect(await pairs(f.nodeId)).toEqual(before);
  expect((await registry().pendingMessagesFor(f.nodeId)).deliveries).toEqual([]);
});

it("replay phases authorize disjoint legacy and binding-required rows at final preparation", async () => {
  const f = await attestedPair();
  const bound = await f.send(); expect(bound.ok).toBe(true); if (!bound.ok) return;
  expect(await registry().prepareMessageDelivery(bound.status.messageId, "auth")).toBeNull();
  expect(await registry().prepareMessageDelivery(bound.status.messageId, "registration")).not.toBeNull();
  const id = crypto.randomUUID();
  await query(sql => sql.exec(`INSERT INTO messages (id,from_node,from_session,to_node,to_session,text,state,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?,'queued',?,?,?)`, id, f.nodeId, ID_A, f.nodeId, ID_B, "Synthetic legacy replay", Date.now(), Date.now(), Date.now()+60000));
  expect(await registry().prepareMessageDelivery(id, "auth")).not.toBeNull();
  expect(await registry().prepareMessageDelivery(id, "registration")).toBeNull();
  // Neither phase changes the ordinary explicit retry path or pure sender status.
  expect(await registry().prepareMessageDelivery(id)).not.toBeNull();
  expect((await registry().messageStatusPageFor(f.nodeId, 0, 32)).effects.statuses.some(s => s.body.messageId === id)).toBe(true);
});
