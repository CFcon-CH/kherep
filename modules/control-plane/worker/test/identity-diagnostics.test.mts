import { expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { attestedPair, attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";
import { registry } from "./helpers.mts";
import { MessageStore } from "../src/message-store.mts";
import { MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";

for (const registered of [true, false]) it(`D1 N3: validated retirement plus ${registered ? "connection epoch" : "registration"} change reports only connection`, async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  const parent = await f.send(ID_B, ID_A); if (!parent.ok) throw new Error(parent.error);
  await registry().reportMessageStatus(f.nodeId, { messageId: parent.status.messageId, state: "delivered" });
  const before = await runInDurableObject(registry(), (_i, s) => s.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray());
  const connection = await runInDurableObject(registry(), (_i, s) => s.storage.sql.exec("SELECT message_connection_token,registration_token FROM nodes WHERE id=?", f.nodeId).one());
  f.beforeResponse(async () => {
    await registry().ackMessageStatus(f.nodeId, { messageId: parent.status.messageId, name: "message.status.ack", state: "delivered" });
    await runInDurableObject(registry(), (_i, s) => {
      if (registered) s.storage.sql.exec("UPDATE nodes SET message_connection_token='synthetic-new-epoch' WHERE id=?", f.nodeId);
      else s.storage.sql.exec("UPDATE nodes SET registration_token=NULL WHERE id=?", f.nodeId);
    });
  });
  const result = await f.send(ID_A, ID_B, parent.status.messageId);
  expect(result.ok && result.status.reason).toBe("loop-context-changed");
  expect(result.ok && result.status.diagnostic).toMatchObject({ kind: "identity-change", stage: "send-admission", dimensions: ["connection"] });
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await runInDurableObject(registry(), (_i, s) => s.storage.sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray())).toEqual(before);
  // A deliberate fresh request after a stable registration follows normal admission.
  await runInDurableObject(registry(), (_i, s) => s.storage.sql.exec("UPDATE nodes SET message_connection_token=?,registration_token=? WHERE id=?", connection.message_connection_token, connection.registration_token, f.nodeId));
  const fresh = await f.send(ID_A, ID_B, parent.status.messageId);
  expect(fresh.ok && fresh.status.state).toBe("queued");
  expect(fresh.ok && fresh.effects.deliveries).toHaveLength(1);
});

it("D1: harmless availability plus lifecycle change reports lifecycle without eligibility", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  expect(await registry().replaceSessions(f.nodeId, attestedRows().map(row => ({ ...row, state: "running" as const })), { version: 1, generation: 2 })).toEqual({ ok: true });
  f.beforeResponse(async () => { expect(await registry().replaceSessions(f.nodeId, attestedRows(Date.now(), 1), { version: 1, generation: 3 })).toEqual({ ok: true }); });
  const result = await f.send();
  expect(result.ok && result.status.reason).toBe("loop-context-changed");
  expect(result.ok && result.status.diagnostic).toMatchObject({ kind: "identity-change", dimensions: ["lifecycle"] });
  expect(result.ok && result.effects.deliveries).toEqual([]);
  expect(await runInDurableObject(registry(), (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs WHERE from_node=?", f.nodeId).one().n)).toBe(0);
});
it("a capability-only signer interleaving is refused with capability and never connection", async () => {
  const f = await attestedPair();
  await runInDurableObject(registry(), async (_i, s) => {
    const sql = s.storage.sql;
    const caps = () => [...JSON.parse(String(sql.exec("SELECT capabilities FROM nodes WHERE id=?", f.nodeId).one().capabilities)), MESSAGING_DIAGNOSTICS_CAPABILITY];
    const store = new MessageStore(sql, () => {}, caps);
    const message = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ID_A }, to: { nodeId: f.nodeId, session: ID_B }, text: "synthetic interleaving" };
    let changed = false;
    const prepared = await store.prepare(message, async () => {
      if (!changed) { changed = true; sql.exec("UPDATE nodes SET capabilities=? WHERE id=?", JSON.stringify(caps().filter((c: string) => c !== "messaging.selected-binding.v1")), f.nodeId); }
      return "0".repeat(64);
    });
    const result = store.send(message, "test", Date.now(), prepared);
    expect(result.ok && result.status.reason).toBe("loop-context-changed");
    expect(result.ok && result.status.diagnostic).toMatchObject({ kind: "identity-change", dimensions: ["capability"] });
    expect(result.ok && result.effects.deliveries).toEqual([]);
    expect(sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs WHERE from_node=?", f.nodeId).one().n).toBe(0);
  });
});

for (const dimension of ["owner", "reference-match", "runtime", "lifecycle", "proof-kind", "eligibility", "connection", "lineage"] as const) {
  it(`real signer refusal identifies changed semantic ${dimension} without scoring`, async () => {
    const f = await attestedPair();
    let actualParent: string | undefined;
    if (dimension === "lineage") {
      const parent = await f.send(ID_B, ID_A); if (!parent.ok) throw new Error(parent.error);
      actualParent = parent.status.messageId;
      await registry().reportMessageStatus(f.nodeId, { messageId: actualParent, state: "accepted" });
    }
    await runInDurableObject(registry(), async (_i, s) => {
      const sql = s.storage.sql, caps = () => ["messaging.v1", "messaging.loop-brake.v1", MESSAGING_DIAGNOSTICS_CAPABILITY];
      const store = new MessageStore(sql, () => {}, caps);
      const alias = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      if (["owner", "reference-match"].includes(dimension)) sql.exec("UPDATE sessions SET name=? WHERE node_id=? AND session_id=?", alias, f.nodeId, ID_A);
      const parent = actualParent;
      const message = { messageId: crypto.randomUUID(), from: { nodeId: f.nodeId, session: ["owner", "reference-match"].includes(dimension) ? alias : ID_A },
        to: { nodeId: f.nodeId, session: ID_B }, text: "synthetic semantic mutation", inReplyTo: parent };
      let changed = false;
      const beforePairs = sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray();
      const prepared = await store.prepare(message, async () => {
        if (!changed) {
          changed = true;
          const proof = JSON.parse(String(sql.exec("SELECT canonical_identity FROM sessions WHERE node_id=? AND session_id=?", f.nodeId, ID_A).one().canonical_identity));
          if (dimension === "owner") sql.exec("UPDATE sessions SET session_id=?,canonical_identity=? WHERE node_id=? AND session_id=?", alias, JSON.stringify({ ...proof, sessionId: alias }), f.nodeId, ID_A);
          if (dimension === "reference-match") sql.exec("UPDATE sessions SET session_id=?,canonical_identity=? WHERE node_id=? AND session_id=?", alias, JSON.stringify({ ...proof, sessionId: alias }), f.nodeId, ID_A);
          if (dimension === "runtime") sql.exec("UPDATE sessions SET runtime='claude-code',canonical_identity=? WHERE node_id=? AND session_id=?", JSON.stringify({ ...proof, runtime: "claude-code", source: "claude-list" }), f.nodeId, ID_A);
          if (dimension === "lifecycle") sql.exec("UPDATE sessions SET canonical_identity=? WHERE node_id=? AND session_id=?", JSON.stringify({ ...proof, lifecycleGeneration: 1 }), f.nodeId, ID_A);
          if (dimension === "proof-kind") sql.exec("UPDATE sessions SET canonical_identity=NULL WHERE node_id=? AND session_id=?", f.nodeId, ID_A);
          if (dimension === "eligibility") sql.exec("UPDATE sessions SET state='closed' WHERE node_id=? AND session_id=?", f.nodeId, ID_A);
          if (dimension === "connection") sql.exec("UPDATE nodes SET registration_token=NULL WHERE id=?", f.nodeId);
          if (dimension === "lineage") sql.exec("UPDATE messages SET state='refused' WHERE id=?", parent!);
        }
        return "0".repeat(64);
      });
      const result = store.send(message, "test", Date.now(), prepared);
      expect(result.ok && result.status.reason).toBe("loop-context-changed");
      const detail = result.ok && result.status.diagnostic;
      const expected = { owner: ["owner", "reference-match"], "reference-match": ["owner", "reference-match"], runtime: ["eligibility", "runtime"],
        lifecycle: ["lifecycle"], "proof-kind": ["eligibility", "proof-kind"], eligibility: ["eligibility"], connection: ["connection"], lineage: ["lineage"] };
      expect(detail && detail.kind === "identity-change" && detail.dimensions).toEqual(expected[dimension]);
      expect(result.ok && result.effects.deliveries).toEqual([]);
      expect(sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray()).toEqual(beforePairs);
    });
  });
}

it("real selected local lifecycle disagreement reports selected-proof and lifecycle", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  f.setLocalRows([ID_A, ID_B].map((sessionId, i) => ({ sessionId, name: `alias-${i}`, runtime: "codex", lifecycleGeneration: 1 })));
  const result = await f.send();
  expect(result.ok && result.status.reason).toBe("loop-context-changed");
  expect(result.ok && result.status.diagnostic).toMatchObject({ kind: "identity-change", dimensions: ["lifecycle", "selected-proof"] });
  expect(result.ok && result.effects.deliveries).toEqual([]);
});
