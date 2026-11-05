import { expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { blockerDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { RESOLUTION_REQUIRED, SELECTED_BINDING_CAPABILITY } from "../../protocol-message-binding.mts";
import { bindingContext, prepareMessageBinding } from "../src/message-binding.mts";
import { egressBinding } from "../src/message-egress-binding.mts";
import { routeEffects, type LocalNode } from "../src/message-routing.mts";
import { MessageStore } from "../src/message-store.mts";
import type { Env } from "../src/env.mts";
import { attestedPair, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";
import { enroll, newKey, registry, session } from "./helpers.mts";

for (const superseded of [false, true]) it(`local routing observes acceptance only after a real socket send, superseded=${superseded}`, async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(session(f.nodeId), async (instance, state) => {
    const internal = instance as unknown as { env: Env; local(ws: WebSocket, nodeId: string): LocalNode; authedSocket(): WebSocket | null };
    const ws = state.getWebSockets().find(w => (w.deserializeAttachment() as { authed?: boolean }).authed)!;
    const local = internal.local(ws, f.nodeId), observed = vi.fn(async () => ({ deliveries: [], statuses: [] }));
    const env = { ...internal.env, REGISTRY: { idFromName: () => "synthetic", get: () => ({
      prepareMessageDelivery: async () => sent.effects.deliveries[0].body, observeMessageDiagnostic: observed,
    }) } } as unknown as Env;
    const current = vi.spyOn(internal, "authedSocket");
    if (superseded) current.mockReturnValue(null);
    try {
      await routeEffects(env, sent.effects, local);
      expect(observed).toHaveBeenCalledTimes(superseded ? 0 : 1);
      expect(local.send("message.status", { messageId: sent.status.messageId, state: "queued" })).toBe(!superseded);
      expect(local.send("message.status", { messageId: sent.status.messageId, state: "queued" }, true)).toBe(!superseded);
      const attachment = ws.deserializeAttachment();
      ws.serializeAttachment({ ...attachment, diagnosticCapabilities: [] });
      expect(local.send("message.status", { messageId: sent.status.messageId, state: "queued" }, true)).toBe(false);
      ws.serializeAttachment(attachment);
    } finally { current.mockRestore(); }
  });
});

for (const role of ["from", "to"] as const) for (const state of ["absent", "revoked", "offline", "pending", "incapable", "resolution", "throw", "request-mismatch", "message-mismatch", "conflict"] as const)
  it(`selected binding attributes ${state} ${role} without a misleading target cause`, async () => {
    const source = await enroll(await newKey()), target = await enroll(await newKey());
    await runInDurableObject(registry(), async (_instance, stateStorage) => {
      const sql = stateStorage.storage.sql;
      for (const id of [source, target]) sql.exec("UPDATE nodes SET message_connection_token='current',registration_token='current',capabilities=? WHERE id=?", JSON.stringify([...BRAKE_CAPS, SELECTED_BINDING_CAPABILITY]), id);
      const selectedNode = role === "from" ? source : target;
      if (state === "absent") sql.exec("DELETE FROM nodes WHERE id=?", selectedNode);
      if (state === "revoked") sql.exec("UPDATE nodes SET revoked_at=? WHERE id=?", Date.now(), selectedNode);
      if (state === "offline") sql.exec("UPDATE nodes SET message_connection_token=NULL,registration_token=NULL WHERE id=?", selectedNode);
      if (state === "pending") sql.exec("UPDATE nodes SET registration_token=NULL WHERE id=?", selectedNode);
      if (state === "incapable") sql.exec("UPDATE nodes SET capabilities=? WHERE id=?", JSON.stringify(BRAKE_CAPS), selectedNode);
      const prepared = await prepareMessageBinding(sql, { messageId: crypto.randomUUID(), from: { nodeId: source, session: ID_A }, to: { nodeId: target, session: ID_B } }, async () => "0".repeat(64), async (nodeId, request) => {
        if (state === "resolution" && nodeId === selectedNode) return { answer: null, code: "resolution-timeout" };
        if (state === "throw" && nodeId === selectedNode) throw new Error("synthetic resolution failure");
        return { version: 1, requestId: state === "request-mismatch" && nodeId === selectedNode ? crypto.randomUUID() : request.requestId,
          messageId: state === "message-mismatch" && nodeId === selectedNode ? crypto.randomUUID() : request.messageId,
          results: request.selections.map(s => state === "conflict" && nodeId === selectedNode ? { role: s.role, code: "CONFLICT" } : ({
          role: s.role, code: "BOUND", match: "exact", owner: { sessionId: s.ref, runtime: "codex" }, localGeneration: null,
          lifecycleGeneration: null, selectionStamp: crypto.randomUUID(), leaseId: crypto.randomUUID(),
        })) };
      });
      const codes = { absent: undefined, revoked: undefined, offline: "node-offline", pending: "registration-pending", incapable: "binding-capability-missing", resolution: "resolution-timeout",
        throw: "resolution-unavailable", "request-mismatch": "resolution-unavailable", "message-mismatch": "resolution-unavailable", conflict: "identity-changed" };
      expect(prepared.binding).toBeNull();
      expect(prepared.diagnosticCode).toBe(role === "to" ? codes[state] : undefined);
    });
  });

for (const failure of ["foreign", "corrupt", "signer", "resolution"] as const) it(`duplicate ${failure} error carries a blocker only for an unresolved valid binding`, async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(registry(), async (_instance, state) => {
    const sql = state.storage.sql, store = new MessageStore(sql, () => {}, () => [...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    const row = sql.exec("SELECT text FROM messages WHERE id=?", sent.status.messageId).one();
    const message = { messageId: sent.status.messageId, from: { nodeId: failure === "foreign" ? crypto.randomUUID() : f.nodeId, session: ID_A },
      to: { nodeId: f.nodeId, session: ID_B }, text: String(row.text) };
    const prepared = await store.prepare(message, async () => "0".repeat(64));
    prepared.binding = { stamp: bindingContext(sql, message).stamp, binding: null, denyKey: null, leaseId: null, localGeneration: null, diagnosticCode: "resolution-unavailable" };
    if (failure === "corrupt") sql.exec("UPDATE messages SET delivery_binding=? WHERE id=?", "{}", message.messageId);
    if (failure === "signer") prepared.error = "loop-crypto-unavailable";
    const result = store.send(message, "synthetic", Date.now(), prepared);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(failure === "foreign" ? "duplicate messageId" : failure === "signer" ? "loop-crypto-unavailable" : RESOLUTION_REQUIRED);
    if (failure === "resolution") expect(result.diagnostic).toMatchObject({ code: "resolution-unavailable", stage: "duplicate" });
    else expect(result.diagnostic).toBeUndefined();
  });
});

it("non-resolution preparation errors carry no egress resolution diagnosis", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(registry(), (_instance, state) => {
    const sql = state.storage.sql, row = sql.exec("SELECT * FROM messages WHERE id=?", sent.status.messageId).one();
    const message = { messageId: String(row.id), from: { nodeId: String(row.from_node), session: String(row.from_session) }, to: { nodeId: String(row.to_node), session: String(row.to_session) } };
    const prepared = { stamp: bindingContext(sql, message).stamp, binding: null, denyKey: null, leaseId: null, localGeneration: null, error: "loop-crypto-unavailable" };
    for (const diagnosticCode of [undefined, "resolution-timeout"] as const) {
      const detail = {};
      expect(egressBinding(sql, row, { ...prepared, diagnosticCode }, true, undefined, detail)).toBeNull();
      expect(detail).toEqual({ code: undefined });
    }
    const detail = {};
    expect(egressBinding(sql, row, { ...prepared, error: RESOLUTION_REQUIRED, diagnosticCode: "resolution-timeout" }, true, undefined, detail)).toBeNull();
    expect(detail).toEqual({ code: "resolution-timeout" });
  });
});

it("delayed egress observations do not overwrite a newer cause or emit an older report", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(registry(), (_instance, state) => {
    const store = new MessageStore(state.storage.sql, () => {}, () => [...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    const latest = blockerDiagnostic("node-offline", 2000, "upstream-egress"), earlier = blockerDiagnostic("acceptance-unconfirmed", 1000, "upstream-egress");
    expect(store.observeDiagnostic(sent.status.messageId, f.nodeId, latest).statuses).toHaveLength(1);
    expect(store.observeDiagnostic(sent.status.messageId, f.nodeId, earlier).statuses).toEqual([]);
    expect(store.statusPageFor(f.nodeId, 0, 100).effects.statuses.find(s => s.body.messageId === sent.status.messageId)?.body.diagnostic).toEqual(latest);
    const sameTime = blockerDiagnostic("registration-pending", 2000, "upstream-egress");
    expect(store.observeDiagnostic(sent.status.messageId, f.nodeId, sameTime).statuses).toHaveLength(1);
    expect(store.observeDiagnostic(sent.status.messageId, "wrong-node", latest).statuses).toEqual([]);
    expect(store.observeDiagnostic(crypto.randomUUID(), f.nodeId, latest).statuses).toEqual([]);
  });
});

it("corrupt diagnostic metadata is omitted while queued canonical delivery and status remain usable", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(registry(), (_instance, state) => {
    const sql = state.storage.sql, store = new MessageStore(sql, () => {}, () => [...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    for (const raw of ["{", "{}", JSON.stringify(blockerDiagnostic("runtime-pending", 0, "target-progress"))]) {
      sql.exec("UPDATE messages SET diagnostic_json=? WHERE id=?", raw, sent.status.messageId);
      const status = store.statusPageFor(f.nodeId, 0, 100).effects.statuses.find(s => s.body.messageId === sent.status.messageId)?.body;
      expect(status).toMatchObject({ state: "queued" });
      expect(status?.diagnostic).toBeUndefined();
      expect(store.deliveryCandidate(sent.status.messageId)?.binding).not.toBeNull();
    }
  });
});
