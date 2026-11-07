import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { authenticate, FACTS, registry, session, until } from "./helpers.mts";
import { makeEnvelope } from "../../protocol.mts";
import { bindingNode } from "./binding-node-fixture.mts";
import { MessageStore } from "../src/message-store.mts";
import { prepareMessageBinding } from "../src/message-binding.mts";
import { attestedPair, attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";

it("S03: one missing Registry owner and a surviving alias retain the same hold in both orientations", async () => {
  const f = await attestedPair();
  for (let i = 0; i < 3; i++) {
    const r = await f.send(ID_A, ID_B, undefined, "ack");
    if (!r.ok) throw new Error(r.error);
    if (i < 2) await f.take(r.status.messageId);
  }
  const before = await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).one());
  f.setLocalRows([{ sessionId: ID_A, runtime: "codex", name: "alias-0" }, { sessionId: ID_B, runtime: "codex", name: "alias-1" }]);
  for (const surviving of [ID_B, ID_A]) {
    await registry().replaceSessions(f.nodeId, attestedRows().filter(row => row.sessionId === surviving));
    const missing = surviving === ID_A ? ID_B : ID_A, alias = surviving === ID_A ? "alias-0" : "alias-1";
    for (const [from, to] of [[missing, alias], [alias, missing]]) {
      const r = await f.send(from, to);
      expect(r.ok && r.status).toMatchObject({ state: "refused",
        reason: `loop-held: ${before.hold_code}; hold=${before.hold_id}; operator release required` });
      expect(r.ok && r.effects.deliveries).toEqual([]);
      if (!r.ok) throw new Error(r.error);
      await runInDurableObject(registry(), (_i, state) => {
        expect(state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray()).toEqual([before]);
        expect(state.storage.sql.exec("SELECT text,loop_thread,loop_pair,loop_generation,loop_ordinal,loop_direction,loop_identity FROM messages WHERE id=?", r.status.messageId).one())
          .toEqual({ text: null, loop_thread: null, loop_pair: null, loop_generation: null, loop_ordinal: null, loop_direction: null, loop_identity: null });
      });
    }
  }
});

it("S01: retained exact hold survives complete Registry session-row loss", async () => {
  const { nodeId, send, take } = await attestedPair();
  for (let i = 0; i < 3; i++) {
    const result = await send(ID_A, ID_B, undefined, "ack");
    if (!result.ok) throw new Error(result.error);
    if (i < 2) await take(result.status.messageId);
  }
  const before = await runInDurableObject(registry(), (_i, state) => {
    const row = state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", nodeId).one();
    state.storage.sql.exec("DELETE FROM sessions WHERE node_id=?", nodeId);
    return row;
  });
  for (const [from, to] of [[ID_A, ID_B], [ID_B, ID_A]]) {
    const result = await send(from, to);
    expect(result.ok && result.status.reason).toContain(String(before.hold_id));
    expect(result.ok && result.status.state).toBe("refused");
    expect(result.ok && result.effects.deliveries).toEqual([]);
  }
  const after = await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", nodeId).one());
  expect(after).toEqual(before);
});

it("S02: held owners selected through never-published aliases cannot create a fresh legacy root", async () => {
  const f = await attestedPair();
  for (let i = 0; i < 3; i++) {
    const r = await f.send(ID_A, ID_B, undefined, "ack"); if (!r.ok) throw new Error(r.error);
    if (i < 2) await f.take(r.status.messageId);
  }
  const before = await runInDurableObject(registry(), (_i, state) => {
    state.storage.sql.exec("DELETE FROM sessions WHERE node_id=?", f.nodeId);
    return state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).one();
  });
  f.setLocalRows([{ sessionId: ID_A, runtime: "codex", name: "never-published-a" }, { sessionId: ID_B, runtime: "codex", name: "never-published-b" }]);
  const result = await f.send("never-published-a", "never-published-b");
  expect(result.ok && result.status.state).toBe("refused");
  expect(result.ok && result.status.reason).toContain(String(before.hold_id));
  expect(result.ok && result.effects.deliveries).toEqual([]);
  await runInDurableObject(registry(), (_i, state) => {
    expect(state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray()).toEqual([before]);
    expect(state.storage.sql.exec("SELECT text FROM messages WHERE id=?", result.ok ? result.status.messageId : "").one().text).toBeNull();
  });
  f.socket.ws.close();
});

it("S11: same-node authenticated send can resolve and re-resolve without a self-RPC deadlock", async () => {
  const f = await attestedPair(), messageId = crypto.randomUUID();
  f.socket.send(makeEnvelope("message.send", { messageId, fromSession: ID_A, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic same-node send" }, f.nextSequence(), 0));
  const status = await until(f.socket, "message.status", { messageId, state: "queued" }, 12);
  expect(status.at(-1)?.body).toMatchObject({ messageId, state: "queued" });
  const delivered = await until(f.socket, "message.deliver", { messageId }, 12);
  expect(delivered.at(-1)?.body).toMatchObject({ toSession: ID_B, from: { session: ID_A }, binding: { version: 1, mode: "exact", to: { sessionId: ID_B } } });
  f.socket.ws.close();
});

it("S10: an actually old-capability endpoint preserves legacy outside holds and refuses unresolved held scope", async () => {
  const f = await attestedPair();
  const token = (await session(f.nodeId).loopCapabilityEvidence()).token!;
  const advertise = async (capabilities: string[]) => {
    expect(await registry().updateRegistration(f.nodeId, FACTS, [{ name: "codex", kind: "cli" }], capabilities, token)).toBe(true);
    const actual = await runInDurableObject(registry(), (_i, state) =>
      state.storage.sql.exec("SELECT capabilities FROM nodes WHERE id=?", f.nodeId).one().capabilities);
    expect(JSON.parse(String(actual))).toEqual(capabilities);
  };
  await advertise(BRAKE_CAPS);
  let selected = false;
  f.beforeResponse(async () => { selected = true; });
  const X = crypto.randomUUID(), Y = crypto.randomUUID(), old = await f.send(X, Y);
  expect(old.ok && old.status.state).toBe("queued");
  if (!old.ok) throw new Error(old.error);
  expect(old.effects.deliveries[0].body.loop).toBeUndefined();
  const row = await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT delivery_binding,delivery_pair,loop_pair FROM messages WHERE id=?", old.status.messageId).one());
  expect(row).toEqual({ delivery_binding: null, delivery_pair: null, loop_pair: null });
  expect(selected).toBe(false);
  await advertise([...BRAKE_CAPS, "messaging.selected-binding.v1"]);
  for (let i = 0; i < 3; i++) {
    const r = await f.send(ID_A, ID_B, undefined, "ack");
    if (!r.ok) throw new Error(r.error);
    if (i < 2) await f.take(r.status.messageId);
  }
  const hold = await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).one());
  expect(hold.hold_id).not.toBeNull();
  await advertise(BRAKE_CAPS);
  selected = false;
  f.beforeResponse(async () => { selected = true; });
  const refused = await f.send(crypto.randomUUID(), crypto.randomUUID());
  expect(refused.ok && refused.status).toMatchObject({ state: "refused", reason: "loop-resolution-required" });
  expect(refused.ok && refused.effects.deliveries).toEqual([]);
  expect(selected).toBe(false);
  expect(await registry().prepareMessageDelivery(old.status.messageId)).toBeNull();
  expect(await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray())).toEqual([hold]);
  expect(await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT state,delivery_binding,delivery_pair,loop_pair FROM messages WHERE id=?", old.status.messageId).one()))
    .toEqual({ state: "queued", ...row });
});

it("S08 S12 S23: unrelated bound legacy inside a held remote scope keeps source while it is offline", async () => {
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const a = await bindingNode([{ sessionId: ID_A, runtime: "codex", name: "a" }, { sessionId: C, runtime: "codex", name: "c" }]);
  const b = await bindingNode([{ sessionId: ID_B, runtime: "codex", name: "b" }, { sessionId: D, runtime: "codex", name: "d" }]);
  for (const [n, id] of [[a.nodeId, ID_A], [b.nodeId, ID_B]]) await registry().replaceSessions(n, [{ sessionId: id, runtime: "codex", state: "running" }]);
  for (let i = 0; i < 3; i++) {
    const r = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: a.nodeId, session: ID_A }, to: { nodeId: b.nodeId, session: ID_B }, text: "ack" }, "synthetic");
    if (r.ok && i < 2) await registry().reportMessageStatus(b.nodeId, { messageId: r.status.messageId, state: "delivered" });
  }
  const hold = await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", a.nodeId).one());
  await registry().replaceSessions(a.nodeId, []); await registry().replaceSessions(b.nodeId, []);
  const r = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: a.nodeId, session: "c" }, to: { nodeId: b.nodeId, session: "d" }, text: "Synthetic unrelated legacy" }, "synthetic");
  expect(r.ok && r.status.state).toBe("queued"); if (!r.ok) throw new Error(r.error);
  expect(r.effects.deliveries[0].body.loop).toBeUndefined();
  const stored = await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT * FROM messages WHERE id=?", r.status.messageId).one());
  expect(stored).toMatchObject({ from_session: C, to_session: D, loop_pair: null });
  expect(JSON.parse(String(stored.delivery_binding))).toMatchObject({ from: { sessionId: C }, to: { sessionId: D } });
  a.socket.ws.close();
  await vi.waitFor(async () => expect(await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT message_connection_token FROM nodes WHERE id=?", a.nodeId).one().message_connection_token)).toBeNull());
  const delivery = await registry().prepareMessageDelivery(r.status.messageId);
  expect(delivery).toMatchObject({ from: { session: C }, toSession: D, binding: { to: { sessionId: D } } });
  expect(delivery?.loop).toBeUndefined();
  const holds = await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", a.nodeId).toArray());
  expect(holds).toEqual([hold]); b.socket.ws.close();
});

it("S15: delayed registration from a superseded socket cannot overwrite the new epoch", async () => {
  const f = await bindingNode([{ sessionId: ID_A, runtime: "codex" }]);
  const old = await session(f.nodeId).loopCapabilityEvidence();
  const fresh = await authenticate(f.nodeId, f.key);
  const current = await session(f.nodeId).loopCapabilityEvidence();
  expect(current.token).not.toBe(old.token);
  expect(await registry().updateRegistration(f.nodeId, FACTS, [], ["malicious-old-capability"], old.token!)).toBe(false);
  expect((await registry().selectedLoopIdentityCheck({ nodeId: f.nodeId, selectors: [
    { ref: ID_A, expectedSessionId: ID_A, expectedRuntime: "codex" },
    { ref: ID_B, expectedSessionId: ID_B, expectedRuntime: "codex" }] })).registrationToken).toBeNull();
  fresh.ws.close();
});

it("S24: an unbound remote queue cannot invent its offline source after an unrelated hold", async () => {
  const X = crypto.randomUUID(), Y = crypto.randomUUID();
  const a = await bindingNode([{ sessionId: ID_A, runtime: "codex" }], BRAKE_CAPS);
  const b = await bindingNode([{ sessionId: ID_B, runtime: "codex" }, { sessionId: Y, runtime: "codex" }], BRAKE_CAPS);
  const token = (await session(a.nodeId).loopCapabilityEvidence()).token!;
  expect(await registry().updateRegistration(a.nodeId, FACTS, [{ name: "codex", kind: "cli" }], BRAKE_CAPS, token)).toBe(true);
  const old = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: a.nodeId, session: X },
    to: { nodeId: b.nodeId, session: Y }, text: "Synthetic remote unbound queue" }, "synthetic");
  expect(old.ok && old.status.state).toBe("queued");
  if (!old.ok) throw new Error(old.error);
  expect(old.effects.deliveries[0].body.loop).toBeUndefined();
  const before = await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT * FROM messages WHERE id=?", old.status.messageId).one());
  expect(before).toMatchObject({ state: "queued", text: "Synthetic remote unbound queue", delivery_binding: null,
    delivery_pair: null, loop_pair: null, loop_identity: null });
  await registry().updateRegistration(a.nodeId, FACTS, [{ name: "codex", kind: "cli" }], [...BRAKE_CAPS, "messaging.selected-binding.v1"], token);
  for (const [nodeId, sessionId] of [[a.nodeId, ID_A], [b.nodeId, ID_B]])
    await registry().replaceSessions(nodeId, [{ sessionId, runtime: "codex", state: "running" }]);
  for (let i = 0; i < 3; i++) {
    const r = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: a.nodeId, session: ID_A },
      to: { nodeId: b.nodeId, session: ID_B }, text: "ack" }, "synthetic");
    expect(r.ok && r.status.state).toBe(i < 2 ? "queued" : "refused");
    if (!r.ok) throw new Error(r.error);
    if (i < 2) await registry().reportMessageStatus(b.nodeId, { messageId: r.status.messageId, state: "delivered" });
  }
  const holds = await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", a.nodeId).toArray());
  expect(holds).toHaveLength(1); expect(holds[0].hold_id).not.toBeNull();
  a.socket.ws.close();
  await vi.waitFor(async () => expect(await runInDurableObject(registry(), (_i, state) =>
    state.storage.sql.exec("SELECT message_connection_token FROM nodes WHERE id=?", a.nodeId).one().message_connection_token)).toBeNull());
  for (let i = 0; i < 2; i++) {
    expect(await registry().prepareMessageDelivery(old.status.messageId)).toBeNull();
    const after = await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT * FROM messages WHERE id=?", old.status.messageId).one());
    const { diagnostic_json: detail, ...unchanged } = after;
    const { diagnostic_json: _oldDetail, ...prior } = before;
    expect(unchanged).toEqual(prior);
    expect(JSON.parse(String(detail))).toMatchObject({ version: 1, kind: "blocker", stage: "upstream-egress", code: "stored-binding-missing" });
    expect(await runInDurableObject(registry(), (_i, state) =>
      state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", a.nodeId).toArray())).toEqual(holds);
  }
});

it("S04 S08: a resolved unrelated local alias is not overridden by a literal old held ID", async () => {
  const f = await attestedPair();
  for (let i = 0; i < 3; i++) { const r = await f.send(ID_A, ID_B, undefined, "ack"); if (r.ok && i < 2) await f.take(r.status.messageId); }
  await registry().replaceSessions(f.nodeId, []);
  const C = crypto.randomUUID(), D = crypto.randomUUID();
  f.setLocalRows([{ sessionId: C, runtime: "codex", name: ID_A }, { sessionId: D, runtime: "codex", name: ID_B }]);
  const r = await f.send(ID_A, ID_B);
  expect(r.ok && r.status.state).toBe("queued"); if (!r.ok) throw new Error(r.error);
  expect(r.effects.deliveries[0].body).toMatchObject({ from: { session: C }, toSession: D });
  expect(r.effects.deliveries[0].body.loop).toBeUndefined();
});

it("S19: a hold committed while selected resolution awaits wins without a second score", async () => {
  const f = await attestedPair();
  for (let i = 0; i < 2; i++) { const r = await f.send(ID_A, ID_B, undefined, "ack"); if (r.ok) await f.take(r.status.messageId); }
  let held: Record<string, SqlStorageValue> | undefined;
  f.beforeResponse(async () => {
    await f.send(ID_A, ID_B, undefined, "ack");
    held = await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).one());
  });
  const r = await f.send();
  expect(r.ok && r.status.reason).toContain(String(held!.hold_id));
  expect(r.ok && r.effects.deliveries).toEqual([]);
  expect(await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).one())).toEqual(held);
});

it("S09 S10 S22 S24: unbound legacy keeps compatibility outside holds and defers after its scope is held", async () => {
  const f = await attestedPair(), X = crypto.randomUUID(), Y = crypto.randomUUID();
  const old = await f.send(X, Y); expect(old.ok && old.status.state).toBe("queued"); if (!old.ok) throw new Error(old.error);
  expect((await registry().prepareMessageDelivery(old.status.messageId))?.toSession).toBe(Y);
  for (let i = 0; i < 3; i++) { const r = await f.send(ID_A, ID_B, undefined, "ack"); if (r.ok && i < 2) await f.take(r.status.messageId); }
  expect(await registry().prepareMessageDelivery(old.status.messageId)).toBeNull();
  const queued = await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT state,text,delivery_binding FROM messages WHERE id=?", old.status.messageId).one());
  expect(queued.state).toBe("queued"); expect(queued.text).not.toBeNull(); expect(queued.delivery_binding).toBeNull();
  const refused = await f.send(X, Y);
  expect(refused.ok && refused.status).toMatchObject({ state: "refused", reason: "loop-resolution-required" });
  expect(refused.ok && refused.effects.deliveries).toEqual([]);
});

it("S32: malformed stored binding refuses instead of becoming legacy", async () => {
  const f = await attestedPair(), r = await f.send(); if (!r.ok) throw new Error(r.error);
  await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("UPDATE messages SET delivery_binding=? WHERE id=?", '{"version":2}', r.status.messageId));
  expect(await registry().prepareMessageDelivery(r.status.messageId)).toBeNull();
  expect(await registry().mcpMessageStatus(f.nodeId, r.status.messageId)).toMatchObject({ state: "refused", reason: "loop-resolution-required" });
  expect(await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT delivery_binding,text FROM messages WHERE id=?", r.status.messageId).one()))
    .toEqual({ delivery_binding: '{"version":2}', text: null });
});

it("S36: a newly held pair refuses queued legacy siblings by their separate delivery key", async () => {
  const f = await attestedPair();
  for (let i = 0; i < 3; i++) { const r = await f.send(ID_A, ID_B, undefined, "ack"); if (r.ok && i < 2) await f.take(r.status.messageId); }
  const C = crypto.randomUUID(), D = crypto.randomUUID();
  await registry().replaceSessions(f.nodeId, []);
  f.setLocalRows([{ sessionId: C, runtime: "codex", name: "c" }, { sessionId: D, runtime: "codex", name: "d" }]);
  const legacy = await f.send("c", "d"); expect(legacy.ok && legacy.status.state).toBe("queued"); if (!legacy.ok) throw new Error(legacy.error);
  const rows = [C, D].map(sessionId => ({ sessionId, runtime: "codex", state: "unknown", canonicalIdentity: {
    version: 1 as const, source: "codex-hook" as const, runtime: "codex" as const, sessionId, observedAt: Date.now(), lifecycleGeneration: 0 } }));
  await registry().replaceSessions(f.nodeId, rows, { version: 1, generation: 2 });
  let heldReason: string | undefined;
  for (let i = 0; i < 3; i++) {
    const r = await f.send(C, D, undefined, "ack"); if (!r.ok) throw new Error(r.error);
    if (i < 2) await f.take(r.status.messageId); else heldReason = r.status.reason;
  }
  expect(heldReason).toMatch(/^loop-held:/);
  expect(await registry().mcpMessageStatus(f.nodeId, legacy.status.messageId)).toMatchObject({ state: "refused", reason: heldReason });
  expect(await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT loop_pair,text FROM messages WHERE id=?", legacy.status.messageId).one()))
    .toEqual({ loop_pair: null, text: null });
});

it("S33: additive old-message migration preserves the existing held pair verbatim", async () => {
  const f = await attestedPair();
  for (let i = 0; i < 3; i++) { const r = await f.send(ID_A, ID_B, undefined, "ack"); if (r.ok && i < 2) await f.take(r.status.messageId); }
  await runInDurableObject(registry(), (_i, state) => {
    const sql = state.storage.sql;
    const before = sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).one();
    // Only this isolated SQL fixture has its legacy message schema restored.
    sql.exec("DROP INDEX messages_delivery_pair");
    sql.exec("ALTER TABLE messages DROP COLUMN delivery_pair");
    sql.exec("ALTER TABLE messages DROP COLUMN delivery_binding");
    new MessageStore(sql, () => {}, () => ["messaging.v1"]);
    expect(sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).one()).toEqual(before);
    expect(sql.exec("SELECT delivery_binding,delivery_pair FROM messages WHERE from_node=?", f.nodeId).toArray()
      .every(r => r.delivery_binding === null && r.delivery_pair === null)).toBe(true);
  });
});

it("S22: expiry reached during lease resolution cannot emit queued bytes", async () => {
  const f = await attestedPair(), r = await f.send(); if (!r.ok) throw new Error(r.error);
  f.beforeResponse(async () => { await runInDurableObject(registry(), (_i, state) => {
    state.storage.sql.exec("UPDATE messages SET expires_at=? WHERE id=?", Date.now() - 1, r.status.messageId);
  }); });
  expect(await registry().prepareMessageDelivery(r.status.messageId)).toBeNull();
  expect(await registry().mcpMessageStatus(f.nodeId, r.status.messageId)).toMatchObject({ state: "expired" });
  expect(await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT text FROM messages WHERE id=?", r.status.messageId).one().text)).toBeNull();
});

it("S17 S29: known selected lifecycle conflict never borrows an older positive proof", async () => {
  const n = await bindingNode([ID_A, ID_B].map(sessionId => ({ sessionId, runtime: "codex", lifecycleGeneration: 1 })));
  await registry().replaceSessions(n.nodeId, [ID_A, ID_B].map(sessionId => ({ sessionId, runtime: "codex", state: "unknown",
    canonicalIdentity: { version: 1 as const, source: "codex-hook" as const, runtime: "codex" as const, sessionId, observedAt: Date.now(), lifecycleGeneration: 0 } })), { version: 1, generation: 1 });
  const r = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: n.nodeId, session: ID_A }, to: { nodeId: n.nodeId, session: ID_B }, text: "Synthetic lifecycle conflict" }, "synthetic");
  expect(r.ok && r.status).toMatchObject({ state: "refused", reason: "loop-context-changed" });
  expect(r.ok && r.effects.deliveries).toEqual([]);
  expect(await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs WHERE from_node=?", n.nodeId).one().n)).toBe(0);
});

const bound = (role: "from" | "to", sessionId: string) => ({ role, code: "BOUND" as const, match: "exact" as const, owner: { sessionId, runtime: "codex" },
  localGeneration: null, lifecycleGeneration: null, selectionStamp: crypto.randomUUID(), leaseId: crypto.randomUUID() });
for (const [answer, code] of [["MISSING", "resolution-missing"], ["AMBIGUOUS", "resolution-ambiguous"], ["STALE", "resolution-stale"], ["INVALID", "resolution-invalid"],
  ["UNREADABLE", "resolution-unreadable"], ["CONFLICT", "identity-changed"]] as const) it(`a node answering ${answer} for the target is reported as ${code}`, async () => {
  const f = await attestedPair();
  await runInDurableObject(registry(), async (_i, state) => {
    const prepared = await prepareMessageBinding(state.storage.sql, { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B } }, async () => "0".repeat(64),
      async (_nodeId, request) => ({ version: 1, requestId: request.requestId, messageId: request.messageId,
        results: request.selections.map(s => s.role === "to" ? { role: s.role, code: answer } : bound(s.role, s.ref)) }));
    expect(prepared.binding).toBeNull();
    expect(prepared.diagnosticCode).toBe(code);
  });
});
it("a BOUND target whose owner differs from the expected one is an identity change, not an unavailable resolution", async () => {
  const f = await attestedPair();
  await runInDurableObject(registry(), async (_i, state) => {
    const prepared = await prepareMessageBinding(state.storage.sql, { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B } }, async () => "0".repeat(64),
      async (_nodeId, request) => {
        expect(request.selections.find(s => s.role === "to")?.expected?.sessionId).toBe(ID_B);
        return { version: 1, requestId: request.requestId, messageId: request.messageId, results: request.selections.map(s => bound(s.role, s.role === "to" ? ID_A : s.ref)) };
      });
    expect(prepared.binding).toBeNull();
    expect(prepared.diagnosticCode).toBe("identity-changed");
  });
});
