import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { registry, session } from "./helpers.mts";
import { MessageStore } from "../src/message-store.mts";
import { prepareMessageBinding } from "../src/message-binding.mts";
import type { LoopSigner } from "../src/message-loop-signals.mts";
import type { NewMessage } from "../src/message-store.mts";
import { attestedPair, attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";

const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const digest: LoopSigner = async (_domain, value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
const pairs = (nodeId: string) => query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", nodeId).toArray());

for (const variant of ["same", "source", "target", "text", "reply", "proxy", "task"] as const) {
  it(`N5: availability refresh keeps live duplicate ${variant} checks and accounting`, async () => {
    const f = await attestedPair();
    const message: NewMessage = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic immutable duplicate body" };
    const first = await registry().sendMessage(message, "synthetic"); expect(first.ok && first.status.state).toBe("queued");
    const capture = () => query(sql => ({ row: sql.exec("SELECT * FROM messages WHERE id=?", message.messageId).one(), pairs: sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray() }));
    const before = await capture(), retry = structuredClone(message);
    if (variant === "source") retry.from.session = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    if (variant === "target") retry.to.session = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    if (variant === "text") retry.text = "Synthetic changed body";
    if (variant === "reply") retry.inReplyTo = crypto.randomUUID();
    if (variant === "proxy") retry.proxyOf = crypto.randomUUID();
    if (variant === "task") retry.taskId = crypto.randomUUID();
    f.beforeResponse(async () => { expect(await registry().replaceSessions(f.nodeId, attestedRows().map(row => ({ ...row, state: "running" as const })), { version: 1, generation: 2 })).toEqual({ ok: true }); });
    const result = await registry().sendMessage(retry, "synthetic");
    expect(result.ok).toBe(variant === "same");
    if (result.ok) { expect(result.status.state).toBe("queued"); expect(result.effects.deliveries).toEqual([]); }
    expect(await capture()).toEqual(before);
  });
}

it("N5: availability refresh never restores tombstone payload retry authority", async () => {
  const f = await attestedPair();
  const message: NewMessage = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic retired duplicate body" };
  await registry().sendMessage(message, "synthetic"); await f.take(message.messageId);
  const before = await pairs(f.nodeId);
  expect(await registry().replaceSessions(f.nodeId, attestedRows().map(row => ({ ...row, state: "running" as const })), { version: 1, generation: 2 })).toEqual({ ok: true });
  expect(await registry().sendMessage(message, "synthetic")).toEqual({ ok: false, error: "duplicate messageId" });
  expect(await registry().mcpMessageStatus(f.nodeId, message.messageId)).toMatchObject({ state: "delivered" });
  expect(await pairs(f.nodeId)).toEqual(before);
});

it("R1: guarded parent ACK retirement during selected response preserves reply authority", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  const parent = await f.send(ID_B, ID_A);
  if (!parent.ok) throw new Error(parent.error);
  expect(parent.status.state).toBe("queued");
  await registry().reportMessageStatus(f.nodeId, { messageId: parent.status.messageId, state: "delivered" });
  const before = await query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray());
  const live = await query(sql => sql.exec("SELECT * FROM messages WHERE id=?", parent.status.messageId).one());
  expect(live.from_session).toBe(ID_B);
  expect(live.to_session).toBe(ID_A);
  let retired = false;
  f.beforeResponse(async () => {
    await registry().ackMessageStatus(f.nodeId, { messageId: parent.status.messageId, name: "message.status.ack", state: "delivered" });
    expect(await query(sql => sql.exec("SELECT id FROM messages WHERE id=?", parent.status.messageId).toArray())).toEqual([]);
    const tombstone = await query(sql => sql.exec("SELECT loop_identity,loop_thread,loop_ordinal,state FROM message_tombstones WHERE id=?", parent.status.messageId).one());
    expect(tombstone).toMatchObject({ loop_identity: live.loop_identity, loop_thread: live.loop_thread, loop_ordinal: live.loop_ordinal, state: "delivered" });
    retired = true;
  });
  const child = await f.send(ID_A, ID_B, parent.status.messageId, "Synthetic novel retirement analysis result");
  expect(retired).toBe(true);
  expect(child.ok && { state: child.status.state, reason: child.status.reason, diagnostic: child.status.diagnostic }).toEqual({ state: "queued", reason: undefined, diagnostic: undefined });
  if (!child.ok) throw new Error(child.error);
  const row = await query(sql => sql.exec("SELECT from_session,to_session,depth,loop_thread,loop_ordinal FROM messages WHERE id=?", child.status.messageId).one());
  expect(row).toMatchObject({ from_session: ID_A, to_session: ID_B, depth: Number(live.depth) + 1, loop_thread: live.loop_thread, loop_ordinal: Number(live.loop_ordinal) + 1 });
  expect(await query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray())).toHaveLength(before.length);
});

for (const reply of [false, true]) for (const initial of ["running", "unknown"] as const) {
  it(`R2: unchanged attested ${reply ? "reply" : "root"} owner may move from ${initial} during selected response`, async () => {
    const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    const rows = attestedRows().map(row => ({ ...row, state: initial }));
    await registry().replaceSessions(f.nodeId, rows, { version: 1, generation: 2 });
    let parent: string | undefined;
    if (reply) {
      const root = await f.send(ID_B, ID_A);
      if (!root.ok) throw new Error(root.error);
      expect(root.status.state).toBe("queued");
      parent = root.status.messageId;
      await f.take(parent);
    }
    let published = false;
    f.beforeResponse(async () => {
      await registry().replaceSessions(f.nodeId, rows.map(row => row.sessionId === ID_A ? { ...row, state: initial === "running" ? "unknown" as const : "running" as const } : row), { version: 1, generation: 3 });
      published = true;
    });
    const result = await f.send(ID_A, ID_B, parent, "Synthetic novel availability analysis result");
    expect(published).toBe(true);
    expect(result.ok && { state: result.status.state, reason: result.status.reason, diagnostic: result.status.diagnostic }).toEqual({ state: "queued", reason: undefined, diagnostic: undefined });
    if (!result.ok) throw new Error(result.error);
    expect(result.effects.deliveries).toHaveLength(1);
    expect(result.effects.deliveries[0].body).toMatchObject({ from: { session: ID_A }, toSession: ID_B });
  });
}

for (const change of ["old live owner", "unbound", "legacy", "corrupt tuple", "refused", "expired", "thread", "pair", "generation", "ordinal", "direction", "depth", "reason", "missing tombstone"] as const) {
  it(`N1: parent retirement cannot launder ${change}`, async () => {
    const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    const parent = await f.send(ID_B, ID_A); if (!parent.ok) throw new Error(parent.error);
    const id = parent.status.messageId;
    await registry().reportMessageStatus(f.nodeId, { messageId: id, state: "delivered" });
    await query(sql => {
      if (change === "old live owner") sql.exec("UPDATE messages SET from_session=? WHERE id=?", ID_A, id);
      if (change === "unbound") sql.exec("UPDATE messages SET loop_identity=NULL WHERE id=?", id);
      if (change === "legacy") sql.exec("UPDATE messages SET loop_thread=NULL,loop_pair=NULL,loop_generation=NULL,loop_ordinal=NULL,loop_direction=NULL,loop_identity=NULL WHERE id=?", id);
      if (change === "corrupt tuple") sql.exec("UPDATE messages SET loop_ordinal=NULL WHERE id=?", id);
    });
    const before = await pairs(f.nodeId);
    f.beforeResponse(async () => {
      await registry().ackMessageStatus(f.nodeId, { messageId: id, name: "message.status.ack", state: "delivered" });
      await query(sql => {
        expect(sql.exec("SELECT id FROM messages WHERE id=?", id).toArray()).toEqual([]);
        if (change === "refused" || change === "expired") sql.exec("UPDATE message_tombstones SET state=? WHERE id=?", change, id);
        if (change === "thread") sql.exec("UPDATE message_tombstones SET loop_thread=? WHERE id=?", crypto.randomUUID(), id);
        if (change === "pair") sql.exec("UPDATE message_tombstones SET loop_pair=? WHERE id=?", "e".repeat(64), id);
        if (change === "generation") sql.exec("UPDATE message_tombstones SET loop_generation=loop_generation+1 WHERE id=?", id);
        if (change === "ordinal") sql.exec("UPDATE message_tombstones SET loop_ordinal=loop_ordinal+1 WHERE id=?", id);
        if (change === "direction") sql.exec("UPDATE message_tombstones SET loop_direction=1-loop_direction WHERE id=?", id);
        if (change === "depth") sql.exec("UPDATE message_tombstones SET depth=depth+1 WHERE id=?", id);
        if (change === "reason") sql.exec("UPDATE message_tombstones SET reason='synthetic changed reason' WHERE id=?", id);
        if (change === "missing tombstone") sql.exec("DELETE FROM message_tombstones WHERE id=?", id);
      });
    });
    const result = await f.send(ID_A, ID_B, id);
    expect(result.ok && result.status.reason).toBe("loop-context-changed");
    expect(result.ok && result.effects.deliveries).toEqual([]);
    expect(await pairs(f.nodeId)).toEqual(before);
  });
}

it("N1: tombstone-to-live reversal is not forward retirement", async () => {
  const f = await attestedPair(), parent = await f.send(ID_B, ID_A); if (!parent.ok) throw new Error(parent.error);
  const id = parent.status.messageId;
  await registry().reportMessageStatus(f.nodeId, { messageId: id, state: "delivered" });
  const live = await query(sql => sql.exec("SELECT * FROM messages WHERE id=?", id).one());
  await registry().ackMessageStatus(f.nodeId, { messageId: id, name: "message.status.ack", state: "delivered" });
  const before = await pairs(f.nodeId);
  f.beforeResponse(async () => { await query(sql => {
    const columns = Object.keys(live);
    sql.exec(`INSERT INTO messages (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, ...columns.map(column => live[column]));
    sql.exec("DELETE FROM message_tombstones WHERE id=?", id);
  }); });
  const result = await f.send(ID_A, ID_B, id);
  expect(result.ok && result.status.reason).toBe("loop-context-changed");
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
});

it("N2: an unbound guarded parent retains its positive-state veto with valid attestation", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  const rows = attestedRows().map(row => ({ ...row, state: "running" as const }));
  expect(await registry().replaceSessions(f.nodeId, rows, { version: 1, generation: 2 })).toEqual({ ok: true });
  const parent = await f.send(ID_B, ID_A); if (!parent.ok) throw new Error(parent.error); await f.take(parent.status.messageId);
  await query(sql => sql.exec("UPDATE message_tombstones SET loop_identity=NULL WHERE id=?", parent.status.messageId));
  const before = await pairs(f.nodeId);
  f.beforeResponse(async () => { expect(await registry().replaceSessions(f.nodeId, rows.map(row => ({ ...row, state: "unknown" as const })), { version: 1, generation: 3 })).toEqual({ ok: true }); });
  const result = await f.send(ID_A, ID_B, parent.status.messageId);
  expect(result.ok && result.status.reason).toBe("loop-context-changed");
  expect(result.ok && result.status.diagnostic).toMatchObject({ dimensions: ["eligibility"] });
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
  const fresh = await f.send(ID_A, ID_B, parent.status.messageId);
  expect(fresh.ok && fresh.status.reason).toBe("loop-compatibility: legacy reply limit");
  expect(await pairs(f.nodeId)).toEqual(before);
});

for (const change of ["unproven", "expired proof", "closed", "archived", "deleted", "runtime", "lifecycle"] as const) {
  it(`N2: availability refresh does not hide ${change}`, async () => {
    const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    const rows = attestedRows().map(row => ({ ...row, state: "running" as const }));
    if (change === "unproven") for (const row of rows) delete row.canonicalIdentity;
    expect(await registry().replaceSessions(f.nodeId, rows, { version: 1, generation: 2 })).toEqual({ ok: true });
    const before = await pairs(f.nodeId);
    f.beforeResponse(async () => {
      const next = rows.map(row => ({ ...row, state: "unknown" as const }));
      if (change === "expired proof") for (const row of next) row.canonicalIdentity = { ...row.canonicalIdentity!, observedAt: 0 };
      if (["closed", "archived", "deleted"].includes(change)) {
        const terminal = rows.map(row => ({ ...row, state: change as "closed" | "archived" | "deleted" }));
        expect(await registry().replaceSessions(f.nodeId, terminal, { version: 1, generation: 3 })).toEqual({ ok: true });
      } else if (change === "runtime") {
        await registry().replaceRuntimes(f.nodeId, [{ name: "claude", kind: "cli" }]);
        expect(await registry().replaceSessions(f.nodeId, next.map(row => ({ ...row, runtime: "claude-code", canonicalIdentity: { ...row.canonicalIdentity!, runtime: "claude-code" as const, source: "claude-list" as const } })), { version: 1, generation: 3 })).toEqual({ ok: true });
      } else {
        if (change === "lifecycle") for (const row of next) row.canonicalIdentity = { ...row.canonicalIdentity!, lifecycleGeneration: 1 };
        expect(await registry().replaceSessions(f.nodeId, next, { version: 1, generation: 3 })).toEqual({ ok: true });
      }
    });
    const result = await f.send();
    expect(result.ok && result.status.reason).toBe("loop-context-changed");
    expect(result.ok && result.effects.deliveries).toEqual([]);
    expect(await pairs(f.nodeId)).toEqual(before);
    if (change === "lifecycle") expect(result.ok && result.status.diagnostic).toMatchObject({ dimensions: ["lifecycle"] });
  });
}

it("N4: harmless availability refresh cannot reset a genuine held pair", async () => {
  const f = await attestedPair(); let parent = "";
  for (let i = 0; i < 3; i++) {
    const result = await f.send(ID_A, ID_B, undefined, "ack"); if (!result.ok) throw new Error(result.error);
    if (i < 2) { parent = result.status.messageId; await f.take(parent); }
    else expect(result.status.reason).toMatch(/^loop-held:/);
  }
  const before = await pairs(f.nodeId);
  f.beforeResponse(async () => { expect(await registry().replaceSessions(f.nodeId, attestedRows().map(row => ({ ...row, state: "running" as const })), { version: 1, generation: 2 })).toEqual({ ok: true }); });
  const reply = await f.send(ID_B, ID_A, parent, "Synthetic novel result after hold");
  expect(reply.ok && reply.status.reason).toMatch(/^loop-held:/);
  expect(reply.ok && reply.effects.deliveries).toEqual([]);
  const root = await f.send(ID_B, ID_A, undefined, "Synthetic novel new thread after hold");
  expect(root.ok && root.status.reason).toMatch(/^loop-held:/);
  expect(root.ok && root.effects.deliveries).toEqual([]);
  expect(await pairs(f.nodeId)).toEqual(before);
});

for (const capability of ["messaging.loop-brake.v1", "messaging.selected-binding.v1", MESSAGING_DIAGNOSTICS_CAPABILITY]) {
  it(`N6: availability refresh preserves capability boundary for ${capability}`, async () => {
    const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    const before = await pairs(f.nodeId);
    f.beforeResponse(async () => { await query(sql => {
      const caps = JSON.parse(String(sql.exec("SELECT capabilities FROM nodes WHERE id=?", f.nodeId).one().capabilities)) as string[];
      sql.exec("UPDATE nodes SET capabilities=? WHERE id=?", JSON.stringify(caps.filter(c => c !== capability)), f.nodeId);
    }); expect(await registry().replaceSessions(f.nodeId, attestedRows().map(row => ({ ...row, state: "running" as const })), { version: 1, generation: 2 })).toEqual({ ok: true }); });
    const result = await f.send();
    expect(result.ok && result.status.state).toBe(capability === MESSAGING_DIAGNOSTICS_CAPABILITY ? "queued" : "refused");
    if (capability === MESSAGING_DIAGNOSTICS_CAPABILITY) expect(result.ok && result.status.diagnostic).toBeUndefined();
    else { expect(result.ok && result.status.reason).toBe("loop-context-changed"); expect(result.ok && result.effects.deliveries).toEqual([]); expect(await pairs(f.nodeId)).toEqual(before); }
  });
}

for (const reply of [false, true]) for (const initial of ["running", "unknown"] as const) {
  it(`R2: unchanged attested ${reply ? "reply" : "root"} owner may move from ${initial} during signer await`, async () => {
    const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    const rows = attestedRows().map(row => ({ ...row, state: initial }));
    expect(await registry().replaceSessions(f.nodeId, rows, { version: 1, generation: 2 })).toEqual({ ok: true });
    let parent: string | undefined;
    if (reply) {
      const root = await f.send(ID_B, ID_A); if (!root.ok) throw new Error(root.error);
      expect(root.status.state).toBe("queued"); parent = root.status.messageId; await f.take(parent);
    }
    await runInDurableObject(registry(), async (instance, state) => {
      const sql = state.storage.sql;
      const caps = () => JSON.parse(String(sql.exec("SELECT capabilities FROM nodes WHERE id=?", f.nodeId).one().capabilities)) as string[];
      const store = new MessageStore(sql, () => {}, caps);
      const message = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "Synthetic novel signer availability result", inReplyTo: parent };
      if (parent) {
        // This isolated Store uses the deterministic test signer, not Registry's secret.
        const key = await digest("kherep-loop-pair-v1", JSON.stringify(["kherep-loop-pair-v1", f.nodeId, ID_A, f.nodeId, ID_B]));
        sql.exec("UPDATE message_loop_pairs SET pair_key=? WHERE from_node=?", key, f.nodeId);
        sql.exec("UPDATE message_tombstones SET loop_pair=? WHERE id=?", key, parent);
      }
      let published = false;
      const prepared = await store.prepare(message, async (domain, value) => {
        if (!published) {
          await Promise.resolve();
          expect(instance.replaceSessions(f.nodeId, rows.map(row => row.sessionId === ID_A ? { ...row, state: initial === "running" ? "unknown" as const : "running" as const } : row), { version: 1, generation: 3 })).toEqual({ ok: true });
          published = true;
        }
        return digest(domain, value);
      });
      const binding = await prepareMessageBinding(sql, message, digest, (nodeId, request) => session(nodeId).resolveMessageReferences(request));
      expect(published).toBe(true);
      const result = state.storage.transactionSync(() => store.send(message, "synthetic", Date.now(), { ...prepared, binding }));
      expect(result.ok && { state: result.status.state, reason: result.status.reason, diagnostic: result.status.diagnostic }).toEqual({ state: "queued", reason: undefined, diagnostic: undefined });
    });
  });
}
