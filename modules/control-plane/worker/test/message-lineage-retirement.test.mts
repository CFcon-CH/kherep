import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { LoopIdentity, parentOf } from "../src/message-loop-identity.mts";
import { registry } from "./helpers.mts";
import { MessageStore } from "../src/message-store.mts";
import { bindingNode } from "./binding-node-fixture.mts";
import type { LoopSigner } from "../src/message-loop-signals.mts";
import { attestedPair, attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";

const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const pairs = (nodeId: string) => query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", nodeId).toArray());
const runningRows = () => attestedRows().map(({ canonicalIdentity: _proof, ...row }) => ({ ...row, state: "running" as const }));
async function compatibilityPair() {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  expect(await registry().replaceSessions(f.nodeId, runningRows())).toEqual({ ok: true });
  return f;
}
async function deliveredParent(f: Awaited<ReturnType<typeof compatibilityPair>>) {
  const sent = await f.send(ID_B, ID_A);
  if (!sent.ok) throw new Error(sent.error);
  expect(sent.status.state).toBe("queued");
  await registry().reportMessageStatus(f.nodeId, { messageId: sent.status.messageId, state: "delivered" });
  const parent = await query(sql => parentOf(sql, sent.status.messageId));
  expect(parent).toMatchObject({ kind: "guarded", identityBinding: null, row: { from_session: ID_B, to_session: ID_A, reason: null } });
  return { id: sent.status.messageId, parent };
}
async function retire(f: Awaited<ReturnType<typeof compatibilityPair>>, id: string) {
  await registry().ackMessageStatus(f.nodeId, { messageId: id, name: "message.status.ack", state: "delivered" });
  return query(sql => {
    expect(sql.exec("SELECT id FROM messages WHERE id=?", id).toArray()).toEqual([]);
    const tombstone = sql.exec("SELECT * FROM message_tombstones WHERE id=?", id).one();
    expect(tombstone).not.toHaveProperty("from_session");
    expect(tombstone).not.toHaveProperty("to_session");
    return parentOf(sql, id);
  });
}

for (const timing of ["stable live", "already retired", "crossing ACK"] as const) {
  it(`compatibility reply preserves lineage with ${timing}`, async () => {
    const f = await compatibilityPair(), { id, parent } = await deliveredParent(f);
    if (parent.kind !== "guarded") throw new Error("expected guarded parent");
    const before = await pairs(f.nodeId);
    let hooks = 0;
    const ack = async () => {
      const retired = await retire(f, id);
      expect(retired).toEqual({ ...parent, row: { ...parent.row, from_session: null, to_session: null } });
    };
    if (timing === "already retired") await ack();
    if (timing === "crossing ACK") f.beforeResponse(async () => { hooks++; await ack(); });
    const child = await f.send(ID_A, ID_B, id, "Synthetic novel compatibility retirement result");
    expect(hooks).toBe(timing === "crossing ACK" ? 1 : 0);
    if (!child.ok) throw new Error(child.error);
    // Capture the actual base refusal and zero admission before the GREEN assertion.
    if (child.status.state === "refused") {
      expect(child.status.reason).toBe("loop-context-changed");
      expect(child.status.diagnostic).toMatchObject({ dimensions: ["lineage"] });
      expect(child.effects.deliveries).toEqual([]);
      expect(await pairs(f.nodeId)).toEqual(before);
      console.log("REGISTRY_RED", JSON.stringify({ timing, hooks, state: child.status.state, reason: child.status.reason, dimensions: child.status.diagnostic?.kind === "identity-change" ? child.status.diagnostic.dimensions : undefined, admissions: 0, deliveries: 0, parentRemoved: true, tombstoneSessionFields: false }));
    }
    expect({ state: child.status.state, reason: child.status.reason, diagnostic: child.status.diagnostic }).toEqual({ state: "queued", reason: undefined, diagnostic: undefined });
    expect(child.effects.deliveries).toHaveLength(1);
    const row = await query(sql => sql.exec("SELECT depth,loop_thread,loop_pair,loop_ordinal,loop_identity FROM messages WHERE id=?", child.status.messageId).one());
    expect(row).toMatchObject({ depth: parent.depth + 1, loop_thread: parent.threadId, loop_pair: parent.pair, loop_ordinal: parent.ordinal + 1, loop_identity: null });
    const after = await pairs(f.nodeId);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toMatchObject({ pair_key: before[0].pair_key, generation: before[0].generation, admitted_count: Number(before[0].admitted_count) + 1, hold_id: null });
    expect(JSON.parse(String(after[0].fingerprints))).toHaveLength(JSON.parse(String(before[0].fingerprints)).length + 1);
  });
}

for (const change of ["old live owner", "wrong pair", "wrong direction", "legacy", "corrupt tuple", "thread", "pair", "generation", "ordinal", "direction", "depth", "reason", "binding gained", "missing tombstone"] as const) {
  it(`compatibility retirement cannot erase ${change}`, async () => {
    const f = await compatibilityPair(), { id } = await deliveredParent(f);
    await query(sql => {
      if (change === "old live owner") sql.exec("UPDATE messages SET from_session=? WHERE id=?", ID_A, id);
      if (change === "wrong pair") sql.exec("UPDATE messages SET loop_pair=? WHERE id=?", "e".repeat(64), id);
      if (change === "wrong direction") sql.exec("UPDATE messages SET loop_direction=1-loop_direction WHERE id=?", id);
      if (change === "legacy") sql.exec("UPDATE messages SET loop_thread=NULL,loop_pair=NULL,loop_generation=NULL,loop_ordinal=NULL,loop_direction=NULL WHERE id=?", id);
      if (change === "corrupt tuple") sql.exec("UPDATE messages SET loop_ordinal=NULL WHERE id=?", id);
    });
    const before = await pairs(f.nodeId);
    let hooks = 0;
    f.beforeResponse(async () => {
      hooks++;
      await retire(f, id);
      await query(sql => {
        if (change === "thread") sql.exec("UPDATE message_tombstones SET loop_thread=? WHERE id=?", crypto.randomUUID(), id);
        if (change === "pair") sql.exec("UPDATE message_tombstones SET loop_pair=? WHERE id=?", "e".repeat(64), id);
        if (change === "generation") sql.exec("UPDATE message_tombstones SET loop_generation=loop_generation+1 WHERE id=?", id);
        if (change === "ordinal") sql.exec("UPDATE message_tombstones SET loop_ordinal=loop_ordinal+1 WHERE id=?", id);
        if (change === "direction") sql.exec("UPDATE message_tombstones SET loop_direction=1-loop_direction WHERE id=?", id);
        if (change === "depth") sql.exec("UPDATE message_tombstones SET depth=depth+1 WHERE id=?", id);
        if (change === "reason") sql.exec("UPDATE message_tombstones SET reason='synthetic changed reason' WHERE id=?", id);
        if (change === "binding gained") sql.exec("UPDATE message_tombstones SET loop_identity=? WHERE id=?", JSON.stringify([1, "codex", 0, "codex", 0]), id);
        if (change === "missing tombstone") sql.exec("DELETE FROM message_tombstones WHERE id=?", id);
      });
    });
    const result = await f.send(ID_A, ID_B, id);
    expect(hooks).toBe(1);
    expect(result.ok && result.status.reason).toBe("loop-context-changed");
    expect(result.ok && result.effects.deliveries).toEqual([]);
    expect(await pairs(f.nodeId)).toEqual(before);
  });
}

for (const attested of [false, true]) it(`compatibility retirement keeps ${attested ? "attested" : "unproven"} UNKNOWN veto`, async () => {
  const f = await compatibilityPair(), { id } = await deliveredParent(f), before = await pairs(f.nodeId);
  f.beforeResponse(async () => {
    await retire(f, id);
    const rows = attested ? attestedRows() : runningRows().map(row => ({ ...row, state: "unknown" as const }));
    expect(await registry().replaceSessions(f.nodeId, rows, ...(attested ? [{ version: 1 as const, generation: 3 }] : []))).toEqual({ ok: true });
  });
  const result = await f.send(ID_A, ID_B, id);
  expect(result.ok && result.status.reason).toBe("loop-context-changed");
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
  const fresh = await f.send(ID_A, ID_B, id);
  expect(fresh.ok && fresh.status.reason).toBe("loop-compatibility: legacy reply limit");
  expect(fresh.ok && fresh.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
});

for (const change of ["connection", "registration", "brake capability", "selected capability"] as const) it(`compatibility retirement retains ${change} veto and diagnostic`, async () => {
  const f = await compatibilityPair(), { id } = await deliveredParent(f), before = await pairs(f.nodeId);
  const connection = await query(sql => sql.exec("SELECT message_connection_token,registration_token,capabilities FROM nodes WHERE id=?", f.nodeId).one());
  f.beforeResponse(async () => {
    await retire(f, id);
    await query(sql => {
      if (change === "connection") sql.exec("UPDATE nodes SET message_connection_token='synthetic-next-connection' WHERE id=?", f.nodeId);
      else if (change === "registration") sql.exec("UPDATE nodes SET registration_token=NULL WHERE id=?", f.nodeId);
      else {
        const cap = change === "brake capability" ? "messaging.loop-brake.v1" : "messaging.selected-binding.v1";
        sql.exec("UPDATE nodes SET capabilities=? WHERE id=?", JSON.stringify((JSON.parse(String(connection.capabilities)) as string[]).filter(c => c !== cap)), f.nodeId);
      }
    });
  });
  const result = await f.send(ID_A, ID_B, id);
  expect(result.ok && result.status.reason).toBe("loop-context-changed");
  const diagnostic = result.ok && result.status.diagnostic;
  if (change === "connection" || change === "registration" || change === "selected capability") {
    expect(diagnostic).toMatchObject({ dimensions: [change === "selected capability" ? "capability" : "connection"] });
  } else expect(diagnostic).toMatchObject({ dimensions: ["capability", "lineage"] });
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
  // Restore the synthetic connection for fixture cleanup only.
  await query(sql => sql.exec("UPDATE nodes SET message_connection_token=?,registration_token=?,capabilities=? WHERE id=?", connection.message_connection_token, connection.registration_token, connection.capabilities, f.nodeId));
});

it("compatibility tombstone-to-live reversal is not forward retirement", async () => {
  const f = await compatibilityPair(), { id } = await deliveredParent(f);
  const live = await query(sql => sql.exec("SELECT * FROM messages WHERE id=?", id).one());
  await retire(f, id);
  const before = await pairs(f.nodeId);
  f.beforeResponse(async () => { await query(sql => {
    const columns = Object.keys(live);
    sql.exec(`INSERT INTO messages (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, ...columns.map(c => live[c]));
    sql.exec("DELETE FROM message_tombstones WHERE id=?", id);
  }); });
  const result = await f.send(ID_A, ID_B, id);
  expect(result.ok && result.status.reason).toBe("loop-context-changed");
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
});

it("compatibility retirement does not reset an already-held pair", async () => {
  const f = await compatibilityPair(), { id } = await deliveredParent(f);
  for (let i = 0; i < 3; i++) {
    const ack = await f.send(ID_A, ID_B, undefined, "ack");
    expect(ack.ok && ack.status.state).toBe(i < 2 ? "queued" : "refused");
  }
  const before = await pairs(f.nodeId);
  expect(before[0].hold_id).not.toBeNull();
  f.beforeResponse(async () => { await retire(f, id); });
  const result = await f.send(ID_A, ID_B, id);
  expect(result.ok && result.status.reason).toMatch(/^loop-held:/);
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
});

for (const bad of ["future generation", "overflow depth"] as const) it(`compatibility retirement keeps ${bad} refused`, async () => {
  const f = await compatibilityPair(), { id } = await deliveredParent(f);
  await query(sql => {
    if (bad === "future generation") sql.exec("UPDATE messages SET loop_generation=loop_generation+1 WHERE id=?", id);
    else sql.exec("UPDATE messages SET depth=? WHERE id=?", Number.MAX_SAFE_INTEGER, id);
  });
  const before = await pairs(f.nodeId);
  f.beforeResponse(async () => { await retire(f, id); });
  const result = await f.send(ID_A, ID_B, id);
  expect(result.ok && result.status.reason).toBe("loop-lineage-unavailable");
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
});

const digest: LoopSigner = async (_domain, value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");

for (const boundary of ["pair signer", "text signer", "fallback"] as const) it(`compatibility retirement during ${boundary} preserves one admission without selected capability`, async () => {
  const f = await compatibilityPair(), { id } = await deliveredParent(f);
  await runInDurableObject(registry(), async (_i, state) => {
    const sql = state.storage.sql;
    const caps = () => [...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY];
    // Stable genuinely older selected-binding capability, rather than a missing response.
    sql.exec("UPDATE nodes SET capabilities=? WHERE id=?", JSON.stringify(caps()), f.nodeId);
    const store = new MessageStore(sql, () => {}, caps);
    const key = await digest("kherep-loop-pair-v1", JSON.stringify(["kherep-loop-pair-v1", f.nodeId, ID_A, f.nodeId, ID_B]));
    sql.exec("UPDATE message_loop_pairs SET pair_key=? WHERE from_node=?", key, f.nodeId);
    sql.exec("UPDATE messages SET loop_pair=? WHERE id=?", key, id);
    const before = sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).one();
    const message = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic novel signer retirement result", inReplyTo: id };
    let hooks = 0;
    const prepared = await store.prepare(message, async (domain, value) => {
      const target = boundary === "text signer" ? "kherep-loop-text-v1" : "kherep-loop-pair-v1";
      if (domain === target && hooks === 0) {
        hooks++;
        state.storage.transactionSync(() => {
          if (boundary === "fallback") {
            sql.exec("UPDATE messages SET delete_after=? WHERE id=?", Date.now() - 1, id);
            store.retention.sweepDue(Date.now());
          } else store.retention.ack(f.nodeId, { messageId: id, name: "message.status.ack", state: "delivered" }, Date.now());
        });
        expect(sql.exec("SELECT id FROM messages WHERE id=?", id).toArray()).toEqual([]);
        expect(parentOf(sql, id)).toMatchObject({ kind: "guarded", identityBinding: null, row: { from_session: null, to_session: null } });
      }
      return digest(domain, value);
    });
    expect(hooks).toBe(1);
    expect(prepared.snapshot.compatibility).toBe(true);
    const result = state.storage.transactionSync(() => store.send(message, "synthetic", Date.now(), prepared));
    expect(result.ok && result.status.state).toBe("queued");
    expect(result.ok && result.effects.deliveries).toHaveLength(1);
    expect(sql.exec("SELECT admitted_count,generation FROM message_loop_pairs WHERE pair_key=?", key).one()).toEqual({ admitted_count: Number(before.admitted_count) + 1, generation: before.generation });
  });
});

for (const mutation of ["none", "wrong source node", "wrong destination node"] as const) it(`two-node compatibility retirement: ${mutation}`, async () => {
  const a = await bindingNode([{ sessionId: ID_A, runtime: "codex" }], [...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  const b = await bindingNode([{ sessionId: ID_B, runtime: "codex" }], [...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  for (const [f, sessionId] of [[a, ID_A], [b, ID_B]] as const) expect(await registry().replaceSessions(f.nodeId, [{ sessionId, runtime: "codex", state: "running" }])).toEqual({ ok: true });
  const parent = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: b.nodeId, session: ID_B }, to: { nodeId: a.nodeId, session: ID_A }, text: "Synthetic two-node parent result" }, "synthetic");
  if (!parent.ok) throw new Error(parent.error);
  expect(parent.status.state).toBe("queued");
  await registry().reportMessageStatus(a.nodeId, { messageId: parent.status.messageId, state: "delivered" });
  const before = await pairs(b.nodeId);
  expect(await query(sql => parentOf(sql, parent.status.messageId))).toMatchObject({ kind: "guarded", identityBinding: null });
  let hooks = 0;
  a.beforeResponse(async () => {
    hooks++;
    await registry().ackMessageStatus(b.nodeId, { messageId: parent.status.messageId, name: "message.status.ack", state: "delivered" });
    await query(sql => {
      expect(sql.exec("SELECT id FROM messages WHERE id=?", parent.status.messageId).toArray()).toEqual([]);
      if (mutation === "wrong source node") sql.exec("UPDATE message_tombstones SET from_node=? WHERE id=?", a.nodeId, parent.status.messageId);
      if (mutation === "wrong destination node") sql.exec("UPDATE message_tombstones SET to_node=? WHERE id=?", b.nodeId, parent.status.messageId);
    });
  });
  const child = await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: a.nodeId, session: ID_A }, to: { nodeId: b.nodeId, session: ID_B }, inReplyTo: parent.status.messageId, text: "Synthetic two-node novel child result" }, "synthetic");
  expect(hooks).toBe(1);
  expect(child.ok && child.status.state).toBe(mutation === "none" ? "queued" : "refused");
  expect(child.ok && child.effects.deliveries).toHaveLength(mutation === "none" ? 1 : 0);
  if (mutation === "none") {
    expect(await query(sql => sql.exec("SELECT depth,loop_thread,loop_identity FROM messages WHERE id=?", child.ok ? child.status.messageId : "").one())).toMatchObject({ depth: 1, loop_thread: parent.status.messageId, loop_identity: null });
    expect((await pairs(b.nodeId))[0].admitted_count).toBe(Number(before[0].admitted_count) + 1);
  } else {
    expect(child.ok && child.status.reason).toBe("loop-context-changed");
    expect(await pairs(b.nodeId)).toEqual(before);
  }
});

it("accepted compatibility parent can become delivered and ACKed during preparation", async () => {
  const f = await compatibilityPair(), sent = await f.send(ID_B, ID_A);
  if (!sent.ok) throw new Error(sent.error);
  await registry().reportMessageStatus(f.nodeId, { messageId: sent.status.messageId, state: "accepted" });
  let hooks = 0;
  f.beforeResponse(async () => { hooks++; await registry().reportMessageStatus(f.nodeId, { messageId: sent.status.messageId, state: "delivered" }); await retire(f, sent.status.messageId); });
  const child = await f.send(ID_A, ID_B, sent.status.messageId);
  expect(hooks).toBe(1);
  expect(child.ok && child.status.state).toBe("queued");
  expect(child.ok && child.effects.deliveries).toHaveLength(1);
  expect((await pairs(f.nodeId))[0].admitted_count).toBe(2);
});

it("helper rejects partial sessions and either binding transition without changing storage", async () => {
  const f = await compatibilityPair(), { id } = await deliveredParent(f);
  await runInDurableObject(registry(), (_i, state) => {
    const sql = state.storage.sql, identity = new LoopIdentity(sql, () => BRAKE_CAPS), now = Date.now();
    const before = identity.snapshot({ nodeId: f.nodeId, session: ID_A }, { nodeId: f.nodeId, session: ID_B }, id, now);
    if (before.parent.kind !== "guarded") throw new Error("expected guarded parent");
    const p = before.parent;
    const after = { ...before, parent: { ...p, row: { ...p.row, from_session: null, to_session: null } } };
    expect(identity.parentRetirementEquivalent(before, after, p.pair, now)).toBe(true);
    expect(identity.parentRetirementEquivalent({ ...before, compatibility: false }, after, p.pair, now)).toBe(false);
    expect(identity.parentRetirementEquivalent(before, { ...after, compatibility: false }, p.pair, now)).toBe(false);
    for (const column of ["from_session", "to_session"] as const) {
      expect(identity.parentRetirementEquivalent(before, { ...after, parent: { ...after.parent, row: { ...after.parent.row, [column]: p.row[column] } } }, p.pair, now)).toBe(false);
      expect(identity.parentRetirementEquivalent({ ...before, parent: { ...p, row: { ...p.row, [column]: null } } }, after, p.pair, now)).toBe(false);
    }
    const binding = JSON.stringify([1, "codex", 0, "codex", 0]);
    expect(identity.parentRetirementEquivalent(before, { ...after, parent: { ...after.parent, identityBinding: binding, row: { ...after.parent.row, loop_identity: binding } } }, p.pair, now)).toBe(false);
    expect(identity.parentRetirementEquivalent({ ...before, parent: { ...p, identityBinding: binding, row: { ...p.row, loop_identity: binding } } }, after, p.pair, now)).toBe(false);
    expect(parentOf(sql, id)).toEqual(p);
  });
});

it("compatibility duplicate scores once and a tombstone never restores payload retry authority", async () => {
  const f = await compatibilityPair();
  const message = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic compatibility immutable retry" };
  const first = await registry().sendMessage(message, "synthetic");
  expect(first.ok && first.status.state).toBe("queued");
  const before = await pairs(f.nodeId);
  const result = await registry().sendMessage(message, "synthetic");
  expect(result.ok && result.status.state).toBe("queued");
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
  await registry().reportMessageStatus(f.nodeId, { messageId: message.messageId, state: "delivered" });
  await retire(f, message.messageId);
  expect(await registry().sendMessage(message, "synthetic")).toEqual({ ok: false, error: "duplicate messageId" });
  expect(await registry().mcpMessageStatus(f.nodeId, message.messageId)).toMatchObject({ state: "delivered" });
  expect(await pairs(f.nodeId)).toEqual(before);
});
