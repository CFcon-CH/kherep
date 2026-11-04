import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { digestMcpArguments, REMOTE_MCP_CAPABILITY } from "../../protocol-mcp.mts";
import { FACTS, registry } from "./helpers.mts";
import { attestedPair, attestedRows, ID_A, ID_B } from "./message-loop-fixture.mts";

const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, s) => run(s.storage.sql));
async function fixture(tool: "send" | "reply", state: "queued" | "accepted", change = "none") {
  const f = await attestedPair();
  const token = await query(sql => String(sql.exec("SELECT message_connection_token FROM nodes WHERE id=?", f.nodeId).one().message_connection_token));
  await registry().updateRegistration(f.nodeId, FACTS, [{ name: "codex", kind: "cli" }],
    [REMOTE_MCP_CAPABILITY, "messaging.v1", "messaging.loop-brake.v1", "messaging.selected-binding.v1"], token);
  await registry().replaceSessions(f.nodeId, attestedRows().map(r => ({ ...r, state: "running" })), { version: 1, generation: 2 });
  const credential = await registry().rotateMcpCredential(f.nodeId);
  if (!credential.ok) throw new Error(credential.error);
  const id = crypto.randomUUID(), parent = crypto.randomUUID(), text = "Synthetic exact stored recovery";
  if (tool === "reply") {
    expect((await registry().sendMessage({ messageId: parent, from: { nodeId: f.nodeId, session: ID_B },
      to: { nodeId: f.nodeId, session: ID_A }, text: "Synthetic delivered parent" }, "synthetic")).ok).toBe(true);
    await registry().reportMessageStatus(f.nodeId, { messageId: parent, state: "delivered" });
  }
  expect((await registry().sendMessage({ messageId: id, from: { nodeId: f.nodeId, session: ID_A },
    to: { nodeId: f.nodeId, session: ID_B }, text,
    ...(tool === "reply" && change !== "non-reply" ? { inReplyTo: parent } : {}) }, "synthetic")).ok).toBe(true);
  if (state === "accepted") await registry().reportMessageStatus(f.nodeId, { messageId: id, state });
  const actualText = change === "text" ? "Synthetic different actual arguments" : text;
  const to = { nodeId: f.nodeId, session: change === "target" ? ID_A : ID_B };
  const inReplyTo = change === "relation" ? crypto.randomUUID() : parent;
  const digest = await digestMcpArguments(tool === "send" ? { to, text: actualText } : { inReplyTo, text: actualText });
  expect((await registry().registerMcpIntent(f.nodeId, { requestId: id, runtime: "codex", sessionId: ID_A,
    threadId: ID_A, callId: "synthetic-call", tool, argumentsDigest: digest })).ok).toBe(true);
  const claim = { nodeId: f.nodeId, credentialVersion: credential.version, requestId: id, runtime: "codex" as const,
    sessionId: ID_A, threadId: ID_A, callId: "synthetic-call", tool, argumentsDigest: digest };
  const recover = (value = claim) => tool === "send" ? registry().sendMcpMessage(value, to, actualText)
    : registry().replyMcpMessage(value, inReplyTo, actualText);
  const snapshot = () => query(sql => ({
    row: sql.exec("SELECT * FROM messages WHERE id=?", id).one(),
    pairs: sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=? OR to_node=?", f.nodeId, f.nodeId).toArray(),
    intent: sql.exec("SELECT * FROM mcp_intents WHERE request_id=?", id).one(),
    audit: sql.exec("SELECT COUNT(*) AS n FROM audit").one().n,
  }));
  return { f, id, claim, recover, snapshot };
}

for (const tool of ["send", "reply"] as const) for (const state of ["queued", "accepted"] as const) {
  for (const change of ["expiry", "source-unknown", "source-removed", "payload", "row-removed", "mode"] as const) {
    it(`recovery payload ${tool} ${state} rechecks ${change} after metadata hash await`, async () => {
      const f = await fixture(tool, state);
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let calls = 0, expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
      const removedSnapshot = () => query(sql => ({
        rows: sql.exec("SELECT * FROM messages WHERE id=?", f.id).toArray(),
        pairs: sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=? OR to_node=?", f.f.nodeId, f.f.nodeId).toArray(),
        intent: sql.exec("SELECT * FROM mcp_intents WHERE request_id=?", f.id).one(),
        audit: sql.exec("SELECT COUNT(*) AS n FROM audit").one().n,
      }));
      let removed: Awaited<ReturnType<typeof removedSnapshot>> | undefined;
      const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
        const result = await original(...args);
        if (++calls === 2) {
          await query(sql => {
            if (change === "expiry") sql.exec("UPDATE mcp_intents SET expires_at=0 WHERE request_id=?", f.id);
            if (change === "source-unknown") sql.exec("UPDATE sessions SET state='unknown' WHERE node_id=? AND session_id=?", f.f.nodeId, ID_A);
            if (change === "source-removed") sql.exec("DELETE FROM sessions WHERE node_id=? AND session_id=?", f.f.nodeId, ID_A);
            if (change === "payload") sql.exec("UPDATE messages SET message_binding=? WHERE id=?", "x".repeat(43), f.id);
            if (change === "row-removed") sql.exec("DELETE FROM messages WHERE id=?", f.id);
            if (change === "mode") sql.exec("UPDATE mcp_intents SET outcome='claimed' WHERE request_id=?", f.id);
          });
          if (change !== "row-removed") expected = await f.snapshot();
          else removed = await removedSnapshot();
        }
        return result;
      });
      try {
        expect((await f.recover()).ok).toBe(false);
        expect(calls).toBe(2);
        if (expected) expect(await f.snapshot()).toEqual(expected);
        else {
          expect(removed?.rows).toEqual([]);
          expect(removed?.intent).toMatchObject({ claimed_at: null, outcome: null });
          expect(await removedSnapshot()).toEqual(removed);
        }
      } finally { spy.mockRestore(); }
    });
  }
  for (const change of ["expiry", "source-unknown"] as const) {
    it(`recovery payload ${tool} ${state} rechecks ${change} after strict selected await`, async () => {
      const f = await fixture(tool, state);
      expect((await registry().claimMcpIntent(f.claim)).ok).toBe(true);
      await registry().recordMcpOutcome(f.f.nodeId, f.id, "succeeded");
      let expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
      f.f.beforeResponse(async () => {
        await query(sql => change === "expiry" ? sql.exec("UPDATE mcp_intents SET expires_at=0 WHERE request_id=?", f.id)
          : sql.exec("UPDATE sessions SET state='unknown' WHERE node_id=? AND session_id=?", f.f.nodeId, ID_A));
        expected = await f.snapshot();
      });
      expect((await f.recover()).ok).toBe(false);
      expect(expected).toBeDefined();
      expect(await f.snapshot()).toEqual(expected);
    });
  }
  it(`recovery payload ${tool} ${state} metadata status cannot release a real loop hold`, async () => {
    const f = await fixture(tool, state);
    for (let index = 0; index < 3; index++) {
      const result = await f.f.send(ID_A, ID_B, undefined, "ack");
      if (result.ok && index < 2) await f.f.take(result.status.messageId);
    }
    const before = await f.snapshot();
    expect(before.pairs.some(pair => pair.hold_id !== null)).toBe(true);
    f.f.setRows([]);
    const result = await f.recover();
    expect(result.ok).toBe(true);
    expect(result.ok && result.effects).toEqual({ deliveries: [], statuses: [] });
    const after = await f.snapshot();
    expect(after.row).toEqual(before.row); expect(after.pairs).toEqual(before.pairs); expect(after.audit).toEqual(before.audit);
  });
}

for (const state of ["queued", "accepted"] as const) {
  for (const [tool, change] of [["send", "text"], ["send", "target"], ["reply", "text"],
    ["reply", "relation"], ["reply", "non-reply"]] as const) {
    for (const position of ["first", "claimed"] as const) it(`recovery payload ${tool} ${state} ${position} refuses actual matching intent with changed stored ${change}`, async () => {
      const f = await fixture(tool, state, change);
      if (position === "claimed") expect((await registry().claimMcpIntent(f.claim)).ok).toBe(true);
      const before = await f.snapshot();
      expect(before.intent).toMatchObject(position === "first" ? { claimed_at: null, outcome: null }
        : { claimed_at: expect.any(Number), outcome: "claimed" });
      if (state === "accepted") expect(before.row.text).toBeNull();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await f.recover()).ok).toBe(false);
        expect(await f.snapshot()).toEqual(before);
      }
    });
  }
  for (const tool of ["send", "reply"] as const) {
    it(`recovery payload ${tool} ${state} proves exact metadata before first and repeated claim without destination RPC`, async () => {
      const f = await fixture(tool, state);
      let resolutions = 0;
      f.f.beforeResponse(async () => { resolutions++; });
      f.f.setRows([]);
      const before = await f.snapshot();
      const first = await f.recover();
      expect(first.ok && first.status.state).toBe(state);
      expect(first.ok && first.effects).toEqual({ deliveries: [], statuses: [] });
      const after = await f.snapshot();
      expect(after.row).toEqual(before.row);
      expect(after.pairs).toEqual(before.pairs);
      expect(after.audit).toEqual(before.audit);
      expect(after.intent).toEqual({ ...before.intent, claimed_at: expect.any(Number), outcome: "claimed" });
      expect((await f.recover()).ok).toBe(true);
      expect(await f.snapshot()).toEqual(after);
      expect(resolutions).toBe(0);
    });
    for (const proof of ["retained", "missing", "malformed"] as const) {
      it(`recovery payload ${tool} ${state} historical ${proof} proof remains explicit`, async () => {
        const f = await fixture(tool, state);
        await query(sql => sql.exec("UPDATE messages SET message_binding=? WHERE id=?", proof === "malformed" ? "invalid" : null, f.id));
        if (proof === "missing") await query(sql => sql.exec("UPDATE messages SET text=NULL WHERE id=?", f.id));
        const before = await f.snapshot();
        expect(before.row.sender_sent_at).toBeNull();
        expect(before.row.message_binding).toBe(proof === "malformed" ? "invalid" : null);
        const allowed = proof === "retained" && state === "queued";
        const result = await f.recover();
        if (allowed) {
          expect(result.ok).toBe(true);
          const after = await f.snapshot();
          expect(after.row).toEqual(before.row);
          expect(after.pairs).toEqual(before.pairs);
          expect(after.audit).toEqual(before.audit);
          expect((await f.recover()).ok).toBe(true);
          expect(await f.snapshot()).toEqual(after);
        } else {
          expect(result).toEqual({ ok: false, error: "message binding unavailable" });
          expect((await f.recover()).ok).toBe(false);
          expect(await f.snapshot()).toEqual(before);
        }
      });
    }
    for (const pair of ["null-claimed", "claimed-null", "unknown-outcome"] as const) {
      it(`recovery payload ${tool} ${state} malformed ${pair} claim pair refuses without mutation`, async () => {
        const f = await fixture(tool, state);
        await query(sql => sql.exec("UPDATE mcp_intents SET claimed_at=?,outcome=? WHERE request_id=?",
          pair === "null-claimed" ? null : Date.now(), pair === "claimed-null" ? null : pair === "unknown-outcome" ? "unknown" : "claimed", f.id));
        const before = await f.snapshot();
        expect(await f.recover()).toEqual({ ok: false, error: "duplicate messageId" });
        expect(await f.snapshot()).toEqual(before);
      });
    }
    for (const outcome of ["succeeded", "failed", "uncertain"] as const) {
      it(`recovery payload ${tool} ${state} actual ${outcome} outcome retains strict destination proof`, async () => {
        const f = await fixture(tool, state);
        expect((await registry().claimMcpIntent(f.claim)).ok).toBe(true);
        await registry().recordMcpOutcome(f.f.nodeId, f.id, outcome);
        f.f.setRows([]);
        const before = await f.snapshot();
        expect((await f.recover()).ok).toBe(false);
        expect(await f.snapshot()).toEqual(before);
      });
    }
    for (const source of ["unknown", "closed", "removed", "wrong-runtime", "unbound-other-session"] as const) {
      it(`recovery payload ${tool} ${state} current source ${source} refuses without adoption`, async () => {
        const f = await fixture(tool, state);
        await query(sql => {
          if (source === "removed") sql.exec("DELETE FROM sessions WHERE node_id=? AND session_id=?", f.f.nodeId, ID_A);
          else if (source === "wrong-runtime") sql.exec("UPDATE sessions SET runtime='claude-code' WHERE node_id=? AND session_id=?", f.f.nodeId, ID_A);
          else if (source === "unbound-other-session") sql.exec("UPDATE messages SET delivery_binding=NULL,delivery_pair=NULL,from_session=? WHERE id=?", ID_B, f.id);
          else sql.exec("UPDATE sessions SET state=? WHERE node_id=? AND session_id=?", source, f.f.nodeId, ID_A);
        });
        const before = await f.snapshot();
        expect((await f.recover()).ok).toBe(false);
        expect(await f.snapshot()).toEqual(before);
      });
    }
  }
}
