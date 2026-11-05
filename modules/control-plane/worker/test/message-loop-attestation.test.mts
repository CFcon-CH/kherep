import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { MessageStore } from "../src/message-store.mts";
import { storedLoopLineage } from "../src/message-loop-identity.mts";
import { FACTS, registry } from "./helpers.mts";
import { attestedPair, attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
it("L01 L06 L13: fresh UNKNOWN chain exceeds depth six with one pair, bindings and ACK tombstones", async () => {
  const { nodeId, send, take } = await attestedPair(); let parent: string | undefined, thread: string | undefined;
  for (let depth = 0; depth < 10; depth++) {
    const r = await send(depth % 2 ? "alias-1" : ID_A, depth % 2 ? "alias-0" : ID_B, parent);
    if (!r.ok) throw new Error(r.error);
    expect(r.status.state).toBe("queued"); thread ??= r.status.messageId;
    expect(r.effects.deliveries[0].body.loop).toMatchObject({ depth, ordinal: depth + 1, threadId: thread });
    parent = r.status.messageId; await take(parent);
    const tomb = await query(sql => sql.exec("SELECT * FROM message_tombstones WHERE id=?", parent!).one());
    expect(tomb.loop_identity).toBe('[1,"codex",0,"codex",0]');
    expect(Object.keys(tomb).some(k => k.includes("session"))).toBe(false);
  }
  expect(await query(sql => sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs WHERE from_node=?", nodeId).one().n)).toBe(1);
});
it("L02 L03: mixed UNKNOWN proof stays legacy, and legacy parent remains legacy after proof arrives", async () => {
  const { nodeId, send, take } = await attestedPair();
  let rows = attestedRows(); delete rows[1].canonicalIdentity; rows[1].state = "running";
  await registry().replaceSessions(nodeId, rows, { version: 1, generation: 2 });
  const old = await send(); if (!old.ok) throw new Error(old.error);
  expect(old.effects.deliveries[0].body.loop).toBeUndefined(); await take(old.status.messageId);
  await registry().replaceSessions(nodeId, attestedRows(), { version: 1, generation: 3 });
  const next = await send(ID_B, ID_A, old.status.messageId); if (!next.ok) throw new Error(next.error);
  expect(next.effects.deliveries[0].body.loop).toBeUndefined();
  let parent = next.status.messageId; await take(parent);
  for (let depth = 2; depth <= 7; depth++) {
    const legacy = await send(depth % 2 ? ID_B : ID_A, depth % 2 ? ID_A : ID_B, parent); if (!legacy.ok) throw new Error(legacy.error);
    expect(legacy.status.state).toBe(depth === 7 ? "refused" : "queued");
    if (depth === 7) expect(legacy.status.reason).toBe("reply depth exceeded");
    else { expect(legacy.effects.deliveries[0].body.loop).toBeUndefined(); parent = legacy.status.messageId; await take(parent); }
  }
});
it("L04 L05: unbound guarded parents require the old positive-state compatibility path", async () => {
  const { nodeId, send, take } = await attestedPair();
  const root = await send(); if (!root.ok) throw new Error(root.error); await take(root.status.messageId);
  await query(sql => sql.exec("UPDATE message_tombstones SET loop_identity=NULL WHERE id=?", root.status.messageId));
  const denied = await send(ID_B, ID_A, root.status.messageId); expect(denied.ok && denied.status.reason).toBe("loop-compatibility: legacy reply limit");
  await registry().replaceSessions(nodeId, attestedRows().map(({ canonicalIdentity: _p, ...r }) => ({ ...r, state: "running" })));
  const allowed = await send(ID_B, ID_A, root.status.messageId); expect(allowed.ok && allowed.status.state).toBe("queued");
});
it("L07: rename of the same ID is safe, but restore generation and alias reassignment refuse parent", async () => {
  const { nodeId, send, take } = await attestedPair();
  const root = await send("alias-0", "alias-1"); if (!root.ok) throw new Error(root.error); await take(root.status.messageId);
  let rows = attestedRows(); rows[0].name = "renamed";
  await registry().replaceSessions(nodeId, rows, { version: 1, generation: 2 });
  const renamed = await send(ID_B, "renamed", root.status.messageId); expect(renamed.ok && renamed.status.state).toBe("queued");
  const claude = attestedRows().map(s => ({ ...s, runtime: "claude-code", canonicalIdentity: { ...s.canonicalIdentity!, source: "claude-list" as const, runtime: "claude-code" as const } }));
  await registry().replaceRuntimes(nodeId, [{ name: "claude", kind: "cli" }]);
  await registry().replaceSessions(nodeId, claude, { version: 1, generation: 3 });
  const replaced = await send(ID_B, ID_A, root.status.messageId); expect(replaced.ok && replaced.status.state).toBe("refused");
  await registry().replaceRuntimes(nodeId, [{ name: "codex", kind: "cli" }]);
  const reassigned = attestedRows(); reassigned[0].sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  reassigned[0].canonicalIdentity = { ...reassigned[0].canonicalIdentity!, sessionId: reassigned[0].sessionId };
  await registry().replaceSessions(nodeId, reassigned, { version: 1, generation: 4 });
  const alias = await send(ID_B, "alias-0", root.status.messageId); expect(alias.ok && alias.status.reason).toBe("loop-lineage-unavailable");
  await registry().replaceSessions(nodeId, attestedRows(Date.now(), 1), { version: 1, generation: 5 });
  const restored = await send(ID_B, ID_A, root.status.messageId); expect(restored.ok && restored.status.state).toBe("refused");
  expect(await query(sql => sql.exec("SELECT admitted_count FROM message_loop_pairs WHERE from_node=?", nodeId).one().admitted_count)).toBe(2);
});
it("L08: corrupt binding and binding on all-NULL legacy are guarded-invalid", async () => {
  const { send } = await attestedPair(); const root = await send(); if (!root.ok) throw new Error(root.error);
  await query(sql => {
    const row = sql.exec("SELECT * FROM messages WHERE id=?", root.status.messageId).one();
    expect(storedLoopLineage({ ...row, loop_identity: '[1, "codex",0,"codex",0]' }).kind).toBe("guarded-invalid");
    expect(storedLoopLineage({ ...row, loop_thread: null, loop_pair: null, loop_generation: null, loop_ordinal: null, loop_direction: null }).kind).toBe("guarded-invalid");
  });
});
for (const change of ["runtime", "proof", "capability", "lifecycle", "alias", "expire", "connection", "registration"] as const) it(`L09: ${change} changes during signer await refuse before scoring`, async () => {
  const { nodeId } = await attestedPair();
  await runInDurableObject(registry(), async (_i, state) => {
    const sql = state.storage.sql;
    const originalToken = sql.exec("SELECT message_connection_token FROM nodes WHERE id=?", nodeId).one().message_connection_token;
    const caps = () => JSON.parse(String(sql.exec("SELECT capabilities FROM nodes WHERE id=?", nodeId).one().capabilities)) as string[];
    const store = new MessageStore(sql, () => {}, caps);
    const msg = { messageId: crypto.randomUUID(), from: { nodeId, session: "alias-0" }, to: { nodeId, session: ID_B }, text: "Synthetic signer boundary" };
    let changed = false;
    const prepared = await store.prepare(msg, async (_d, v) => {
      await Promise.resolve();
      if (!changed) {
        changed = true;
        if (change === "capability") sql.exec("UPDATE nodes SET capabilities='[]' WHERE id=?", nodeId);
        else if (change === "connection") sql.exec("UPDATE nodes SET message_connection_token='synthetic-replacement' WHERE id=?", nodeId);
        else if (change === "registration") sql.exec("UPDATE nodes SET registration_token=NULL WHERE id=?", nodeId);
        else if (change === "expire") for (const row of attestedRows(0)) sql.exec("UPDATE sessions SET canonical_identity=? WHERE node_id=? AND session_id=?", JSON.stringify(row.canonicalIdentity), nodeId, row.sessionId);
        else if (change === "lifecycle") for (const row of attestedRows(Date.now(), 1)) sql.exec("UPDATE sessions SET canonical_identity=? WHERE node_id=? AND session_id=?", JSON.stringify(row.canonicalIdentity), nodeId, row.sessionId);
        else if (change === "alias") sql.exec("UPDATE sessions SET name='changed' WHERE node_id=? AND session_id=?", nodeId, ID_A);
        else sql.exec(`UPDATE sessions SET ${change === "runtime" ? "runtime='claude-code'" : "canonical_identity=NULL"} WHERE node_id=? AND session_id=?`, nodeId, ID_A);
      }
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))].map(x => x.toString(16).padStart(2, "0")).join("");
    });
    const result = state.storage.transactionSync(() => store.send(msg, "test", Date.now(), prepared));
    expect(result.ok && result.status.reason).toBe(change === "capability" ? "target node lacks messaging.v1" : "loop-context-changed");
    expect(sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs WHERE from_node=?", nodeId).one().n).toBe(0);
    if (change === "connection") sql.exec("UPDATE nodes SET message_connection_token=? WHERE id=?", originalToken, nodeId);
  });
});
for (const change of ["expire", "missing", "terminal", "capability", "runtime"] as const) it(`L10: queued ${change} cannot replay or push as legacy`, async () => {
  const { nodeId, send } = await attestedPair(); const root = await send("alias-0", "alias-1"); if (!root.ok) throw new Error(root.error);
  await query(sql => {
    if (change === "capability") sql.exec("UPDATE nodes SET capabilities='[]' WHERE id=?", nodeId);
    else if (change === "runtime") sql.exec("DELETE FROM runtimes WHERE node_id=?", nodeId);
    else if (change === "missing") sql.exec("UPDATE sessions SET canonical_identity=NULL WHERE node_id=?", nodeId);
    else if (change === "terminal") sql.exec("UPDATE sessions SET state='closed' WHERE node_id=?", nodeId);
    else for (const r of attestedRows(0)) sql.exec("UPDATE sessions SET canonical_identity=? WHERE node_id=? AND session_id=?", JSON.stringify(r.canonicalIdentity), nodeId, r.sessionId);
  });
  expect((await registry().pendingMessagesFor(nodeId)).deliveries).toEqual([]);
  expect(await registry().messageDeliveryReady(root.status.messageId)).toBe(false);
  expect(await query(sql => sql.exec("SELECT loop_identity FROM messages WHERE id=?", root.status.messageId).one().loop_identity)).not.toBeNull();
});
it("L15: held pair cannot evade the hold by expiry, terminal state or capability loss", async () => {
  for (const change of ["expire", "terminal", "capability"] as const) {
    const { nodeId, send, take } = await attestedPair();
    for (let i = 0; i < 3; i++) { const r = await send(ID_A, ID_B, undefined, "ack"); if (!r.ok) throw new Error(r.error); if (i < 2) await take(r.status.messageId); }
    await query(sql => {
      if (change === "capability") sql.exec("UPDATE nodes SET capabilities='[\"messaging.v1\"]' WHERE id=?", nodeId);
      else if (change === "terminal") sql.exec("UPDATE sessions SET state='closed' WHERE node_id=?", nodeId);
      else for (const r of attestedRows(0)) sql.exec("UPDATE sessions SET canonical_identity=? WHERE node_id=? AND session_id=?", JSON.stringify(r.canonicalIdentity), nodeId, r.sessionId);
    });
    const denied = await send(); expect(denied.ok && denied.status.reason).toMatch(/^loop-held:/);
  }
});

it("L13: unavailable signer refuses before scoring", async () => {
  const { nodeId } = await attestedPair();
  await runInDurableObject(registry(), async (_i, state) => {
    const sql = state.storage.sql;
    const store = new MessageStore(sql, () => {}, () => BRAKE_CAPS);
    const msg = { messageId: crypto.randomUUID(), from: { nodeId, session: ID_A }, to: { nodeId, session: ID_B }, text: "Synthetic unavailable signer" };
    const prepared = await store.prepare(msg, async () => { throw new Error("synthetic secret unavailable"); });
    const result = state.storage.transactionSync(() => store.send(msg, "test", Date.now(), prepared));
    expect(result.ok && result.status.reason).toBe("loop-crypto-unavailable");
    expect(sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs WHERE from_node=?", nodeId).one().n).toBe(0);
  });
});
