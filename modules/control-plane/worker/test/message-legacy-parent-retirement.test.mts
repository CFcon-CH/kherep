import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { LOOP_STALE } from "../../protocol-loop-brake.mts";
import { digestMcpArguments, REMOTE_MCP_CAPABILITY } from "../../protocol-mcp.mts";
import { MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { REPLY_DEPTH_EXCEEDED } from "../src/message-depth.mts";
import { parentOf } from "../src/message-loop-identity.mts";
import { FACTS, registry, session } from "./helpers.mts";
import { attestedPair, attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";

// Issue #765: a reply whose parent retires or advances during send preparation.
// A legacy pair lacks messaging.loop-brake.v1 and never enters pair accounting.
const LEGACY_CAPS = [MESSAGING_CAPABILITY, MESSAGING_ACK_CAPABILITY, MESSAGING_DIAGNOSTICS_CAPABILITY];
const GUARDED_CAPS = [...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY];
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const pairs = (nodeId: string) => query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", nodeId).toArray());
const runningRows = () => attestedRows().map(({ canonicalIdentity: _proof, ...row }) => ({ ...row, state: "running" as const }));
type Fixture = Awaited<ReturnType<typeof attestedPair>>;
async function runningPair(capabilities: string[]) {
  const f = await attestedPair(capabilities);
  expect(await registry().replaceSessions(f.nodeId, runningRows())).toEqual({ ok: true });
  return f;
}
const report = (f: Fixture, id: string, state: "accepted" | "delivered") => registry().reportMessageStatus(f.nodeId, { messageId: id, state });
async function retire(f: Fixture, id: string) {
  await registry().ackMessageStatus(f.nodeId, { messageId: id, name: "message.status.ack", state: "delivered" });
  await query(sql => {
    expect(sql.exec("SELECT id FROM messages WHERE id=?", id).toArray()).toEqual([]);
    expect(sql.exec("SELECT id FROM message_tombstones WHERE id=?", id).toArray()).toHaveLength(1);
  });
}
async function root(f: Fixture, kind: "legacy" | "guarded", state?: "accepted" | "delivered") {
  const sent = await f.send(ID_B, ID_A);
  if (!sent.ok) throw new Error(sent.error);
  expect(sent.status.state).toBe("queued");
  if (state) await report(f, sent.status.messageId, state);
  expect(await query(sql => parentOf(sql, sent.status.messageId))).toMatchObject({ kind, row: { from_session: ID_B, to_session: ID_A, state: state ?? "queued", reason: null } });
  return sent.status.messageId;
}
// The base refusal of #765 has one signature. Anything else stops the build.
type Sent = Awaited<ReturnType<Fixture["send"]>>;
function outcome(label: string, child: Sent) {
  if (!child.ok) throw new Error(child.error);
  const { state, reason, diagnostic } = child.status;
  const identity = diagnostic?.kind === "identity-change" ? { dimensions: diagnostic.dimensions, stage: diagnostic.stage } : undefined;
  if (reason === LOOP_STALE) console.log("RED765", JSON.stringify({ label, state, reason, ...identity, deliveries: child.effects.deliveries.length }));
  return { state, reason, identity, deliveries: child.effects.deliveries.length };
}
const QUEUED = { state: "queued", reason: undefined, identity: undefined, deliveries: 1 };
const stored = (id: string) => query(sql => sql.exec("SELECT depth,loop_thread,loop_pair,loop_generation,loop_ordinal,loop_direction,loop_identity FROM messages WHERE id=?", id).one());
const LEGACY_ROW = { loop_thread: null, loop_pair: null, loop_generation: null, loop_ordinal: null, loop_direction: null, loop_identity: null };

const ROOT_STATE = { "delivered -> retired": "delivered", "accepted -> delivered -> retired": "accepted", "already retired": "delivered", "queued -> accepted": undefined } as const;
for (const timing of ["delivered -> retired", "accepted -> delivered -> retired", "already retired", "queued -> accepted"] as const) {
  it(`legacy reply is admitted when its parent goes ${timing}`, async () => {
    const f = await runningPair(LEGACY_CAPS);
    const id = await root(f, "legacy", ROOT_STATE[timing]);
    let hooks = 0;
    if (timing === "already retired") await retire(f, id);
    else f.beforeResponse(async () => {
      hooks++;
      if (timing === "queued -> accepted") return void await report(f, id, "accepted");
      if (timing === "accepted -> delivered -> retired") await report(f, id, "delivered");
      await retire(f, id);
    });
    const child = await f.send(ID_A, ID_B, id, "Synthetic novel legacy reply");
    expect(hooks).toBe(timing === "already retired" ? 0 : 1);
    expect(outcome(`legacy ${timing}`, child)).toEqual(QUEUED);
    expect(await stored(child.ok ? child.status.messageId : "")).toEqual({ depth: 1, ...LEGACY_ROW });
    expect(await pairs(f.nodeId)).toEqual([]);
  });
}

it("guarded reply is admitted when its queued parent is accepted during preparation", async () => {
  const f = await runningPair(GUARDED_CAPS), id = await root(f, "guarded");
  const before = await pairs(f.nodeId);
  let hooks = 0;
  f.beforeResponse(async () => { hooks++; await report(f, id, "accepted"); });
  const child = await f.send(ID_A, ID_B, id, "Synthetic novel guarded reply");
  expect(hooks).toBe(1);
  expect(outcome("guarded queued -> accepted", child)).toEqual(QUEUED);
  expect(await stored(child.ok ? child.status.messageId : "")).toMatchObject({ depth: 1, loop_thread: id, loop_ordinal: 2 });
  expect((await pairs(f.nodeId))[0]).toMatchObject({ pair_key: before[0].pair_key, admitted_count: Number(before[0].admitted_count) + 1, hold_id: null });
});

it("guarded parent still queued at admission stays refused as unavailable lineage", async () => {
  const f = await runningPair(GUARDED_CAPS), id = await root(f, "guarded"), before = await pairs(f.nodeId);
  const child = await f.send(ID_A, ID_B, id, "Synthetic novel guarded reply");
  expect(outcome("guarded queued", child)).toEqual({ state: "refused", reason: "loop-lineage-unavailable", identity: undefined, deliveries: 0 });
  expect(await pairs(f.nodeId)).toEqual(before);
});

const LOOP_TUPLE = "loop_thread=?,loop_pair=?,loop_generation=0,loop_ordinal=1,loop_direction=0";
for (const change of ["fixed loop reason", "depth", "source node", "destination node", "guarded kind", "missing tombstone", "refused parent", "expired tombstone"] as const) {
  it(`legacy retirement cannot launder ${change}`, async () => {
    const f = await runningPair(LEGACY_CAPS), id = await root(f, "legacy", "delivered");
    let hooks = 0;
    f.beforeResponse(async () => {
      hooks++;
      if (change === "refused parent") return void await query(sql => { sql.exec("UPDATE messages SET state='refused' WHERE id=?", id); });
      await retire(f, id);
      await query(sql => {
        if (change === "fixed loop reason") sql.exec("UPDATE message_tombstones SET reason=? WHERE id=?", "loop-lineage-unavailable", id);
        if (change === "depth") sql.exec("UPDATE message_tombstones SET depth=depth+1 WHERE id=?", id);
        if (change === "source node") sql.exec("UPDATE message_tombstones SET from_node=? WHERE id=?", crypto.randomUUID(), id);
        if (change === "destination node") sql.exec("UPDATE message_tombstones SET to_node=? WHERE id=?", crypto.randomUUID(), id);
        if (change === "guarded kind") sql.exec(`UPDATE message_tombstones SET ${LOOP_TUPLE} WHERE id=?`, id, "e".repeat(64), id);
        if (change === "missing tombstone") sql.exec("DELETE FROM message_tombstones WHERE id=?", id);
        if (change === "expired tombstone") sql.exec("UPDATE message_tombstones SET state='expired' WHERE id=?", id);
      });
    });
    const result = outcome(`negative ${change}`, await f.send(ID_A, ID_B, id, "Synthetic novel legacy reply"));
    expect(hooks).toBe(1);
    expect(result).toMatchObject({ state: "refused", reason: LOOP_STALE, deliveries: 0 });
    expect(result.identity?.dimensions).toContain("lineage");
    expect(await pairs(f.nodeId)).toEqual([]);
  });
}

it("legacy tombstone-to-live reversal is not forward retirement", async () => {
  const f = await runningPair(LEGACY_CAPS), id = await root(f, "legacy", "delivered");
  const live = await query(sql => sql.exec("SELECT * FROM messages WHERE id=?", id).one());
  await retire(f, id);
  f.beforeResponse(async () => { await query(sql => {
    const columns = Object.keys(live);
    sql.exec(`INSERT INTO messages (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, ...columns.map(c => live[c]));
    sql.exec("DELETE FROM message_tombstones WHERE id=?", id);
  }); });
  const result = outcome("negative reversal", await f.send(ID_A, ID_B, id, "Synthetic novel legacy reply"));
  expect(result).toMatchObject({ state: "refused", reason: LOOP_STALE, identity: { dimensions: ["lineage"] }, deliveries: 0 });
  expect(await pairs(f.nodeId)).toEqual([]);
});

for (const parentDepth of [5, 6]) it(`legacy reply below a parent at depth ${parentDepth} keeps the depth limit across retirement`, async () => {
  const f = await runningPair(LEGACY_CAPS), id = await root(f, "legacy", "delivered");
  await query(sql => { sql.exec("UPDATE messages SET depth=? WHERE id=?", parentDepth, id); });
  let hooks = 0;
  f.beforeResponse(async () => { hooks++; await retire(f, id); });
  const child = await f.send(ID_A, ID_B, id, "Synthetic novel legacy reply");
  expect(hooks).toBe(1);
  expect(outcome(`legacy depth ${parentDepth}`, child)).toEqual(parentDepth === 5 ? QUEUED
    : { state: "refused", reason: REPLY_DEPTH_EXCEEDED, identity: undefined, deliveries: 0 });
  if (parentDepth === 5) expect(await stored(child.ok ? child.status.messageId : "")).toEqual({ depth: 6, ...LEGACY_ROW });
  expect(await pairs(f.nodeId)).toEqual([]);
});

it("guarded acknowledgement replies still strike while each parent retires, and the third holds the pair", async () => {
  const f = await runningPair(GUARDED_CAPS);
  let parent = await root(f, "guarded", "delivered"), hooks = 0;
  for (let strike = 1; strike <= 3; strike++) {
    const [from, to] = strike % 2 ? [ID_A, ID_B] : [ID_B, ID_A], retiring = parent;
    f.beforeResponse(async () => { hooks++; await retire(f, retiring); });
    const child = await f.send(from, to, parent, "ack");
    expect(hooks).toBe(strike);
    if (!child.ok) throw new Error(child.error);
    const [row] = await pairs(f.nodeId);
    if (strike < 3) {
      expect(outcome(`strike ${strike}`, child)).toEqual(QUEUED);
      expect(row).toMatchObject({ no_progress_count: strike, hold_id: null });
      parent = child.status.messageId;
      await report(f, parent, "delivered");
    } else {
      expect(outcome("strike 3", child)).toMatchObject({ state: "refused", reason: expect.stringMatching(/^loop-held:/), deliveries: 0 });
      expect(row.hold_id).not.toBeNull();
    }
  }
});

it("MCP reply is admitted when its legacy parent retires during preparation", async () => {
  const caps = [...LEGACY_CAPS, REMOTE_MCP_CAPABILITY];
  const f = await attestedPair(caps);
  const token = (await session(f.nodeId).loopCapabilityEvidence()).token!;
  await registry().updateRegistration(f.nodeId, FACTS, [{ name: "codex", kind: "cli" }], [...caps, "messaging.selected-binding.v1"], token);
  await registry().replaceSessions(f.nodeId, attestedRows().map(r => ({ ...r, state: "running" })), { version: 1, generation: 2 });
  const credential = await registry().rotateMcpCredential(f.nodeId); if (!credential.ok) throw new Error(credential.error);
  const id = await root(f, "legacy", "delivered"), requestId = crypto.randomUUID(), text = "Synthetic novel MCP legacy reply", callId = "synthetic-call";
  const argumentsDigest = await digestMcpArguments({ inReplyTo: id, text });
  const intent = { requestId, runtime: "codex" as const, sessionId: ID_A, threadId: ID_A, callId, tool: "reply" as const, argumentsDigest };
  expect((await registry().registerMcpIntent(f.nodeId, intent)).ok).toBe(true);
  let hooks = 0;
  f.beforeResponse(async () => { hooks++; await retire(f, id); });
  const result = await registry().replyMcpMessage({ nodeId: f.nodeId, credentialVersion: credential.version, ...intent }, id, text);
  expect(hooks).toBe(1);
  if (!result.ok && "diagnostic" in result) console.log("RED765", JSON.stringify({ label: "mcp reply", error: result.error, diagnostic: result.diagnostic }));
  expect(result).toMatchObject({ ok: true, status: { messageId: requestId, state: "queued" } });
  expect(await stored(requestId)).toEqual({ depth: 1, ...LEGACY_ROW });
  expect(await pairs(f.nodeId)).toEqual([]);
});
