import { expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { authenticate, enroll, FACTS, newKey, registry, session } from "./helpers.mts";
import { makeEnvelope } from "../../protocol.mts";
import type { ResolveRequest } from "../../protocol-message-binding.mts";
import { MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { attestedPair, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";
const request = (): ResolveRequest => ({ version: 1, requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), purpose: "egress",
  selections: [{ role: "to", ref: "synthetic" }], expiresAt: Date.now() + 5000 });
async function connected(capabilities: string[] | null) {
  const key = await newKey(), nodeId = await enroll(key), socket = await authenticate(nodeId, key);
  if (capabilities) {
    socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [], capabilities }, 1, 0));
    await vi.waitFor(async () => { expect((await session(nodeId).loopCapabilityEvidence()).registered).toBe(true); });
  }
  return { nodeId, socket };
}
it("real NodeSession distinguishes offline, unregistered and incapable connections", async () => {
  const offline = await enroll(await newKey());
  expect((await session(offline).resolveMessageReferencesDetailed(request())).code).toBe("node-offline");
  const unregistered = await connected(null);
  expect((await session(unregistered.nodeId).resolveMessageReferencesDetailed(request())).code).toBe("registration-pending");
  unregistered.socket.ws.close();
  const incapable = await connected(["messaging.v1"]);
  expect((await session(incapable.nodeId).resolveMessageReferencesDetailed(request())).code).toBe("binding-capability-missing");
  incapable.socket.ws.close();
});
it("real NodeSession RPC distinguishes invalid/expired resolution, timeout and bounded capacity", async () => {
  const f = await connected(["messaging.v1", "messaging.selected-binding.v1"]);
  const expired = request(); expired.expiresAt = Date.now() - 1;
  expect((await session(f.nodeId).resolveMessageReferencesDetailed(expired)).code).toBe("resolution-clock");
  const short = request(); short.expiresAt = Date.now() + 250; // margin for slow CI runners before the expiry check
  expect((await session(f.nodeId).resolveMessageReferencesDetailed(short)).code).toBe("resolution-timeout");
  const pending = Array.from({ length: 32 }, () => session(f.nodeId).resolveMessageReferencesDetailed(request()));
  await vi.waitFor(async () => {
    const count = await runInDurableObject(session(f.nodeId), i => (i as unknown as { references: { pending: Map<string, unknown> } }).references.pending.size);
    expect(count).toBe(32);
  });
  expect((await session(f.nodeId).resolveMessageReferencesDetailed(request())).code).toBe("resolution-capacity");
  await session(f.nodeId).revoke(); await Promise.all(pending);
  f.socket.ws.close();
});
it("real bound egress attributes missing stored binding and an unacknowledged pushed frame", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  const sent = await f.send(); if (!sent.ok) throw new Error(sent.error);
  const id = sent.status.messageId;
  expect(await session(f.nodeId).pushFrame("message.deliver", { messageId: id })).toBe(true);
  expect((await registry().mcpMessageStatus(f.nodeId, id))?.diagnostic).toMatchObject({ code: "acceptance-unconfirmed", stage: "upstream-egress" });
  await runInDurableObject(registry(), (_i, s) => { s.storage.sql.exec("UPDATE messages SET delivery_binding=NULL,delivery_pair=NULL WHERE id=?", id); });
  expect(await registry().prepareMessageDelivery(id)).toBeNull();
  expect((await registry().mcpMessageStatus(f.nodeId, id))?.diagnostic).toMatchObject({ code: "stored-binding-missing" });
});
it("real selected owner drift records identity-changed during queued egress without rebinding", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  f.setLocalRows([{ sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "alias-1", runtime: "codex" }]);
  // The retained canonical target cannot be selected anymore: the node answers MISSING.
  expect(await registry().prepareMessageDelivery(sent.status.messageId)).toBeNull();
  const detail = (await registry().mcpMessageStatus(f.nodeId, sent.status.messageId))?.diagnostic;
  expect(detail).toMatchObject({ code: "resolution-missing" });
  // A real selection keeps the owner but conflicts with its stored lifecycle.
  f.setLocalRows([ID_A, ID_B].map((sessionId, i) => ({ sessionId, name: `alias-${i}`, runtime: "codex", lifecycleGeneration: 1 })));
  expect(await registry().prepareMessageDelivery(sent.status.messageId)).toBeNull();
  expect((await registry().mcpMessageStatus(f.nodeId, sent.status.messageId))?.diagnostic).toMatchObject({ code: "identity-changed" });
});

it("disconnected delivery and pre-registration egress persist their actual waiting causes", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  expect(await registry().prepareMessageDelivery(sent.status.messageId, "auth")).toBeNull();
  expect((await registry().mcpMessageStatus(f.nodeId, sent.status.messageId))?.diagnostic).toMatchObject({ code: "registration-pending" });
  f.socket.ws.close();
  await vi.waitFor(async () => { expect((await session(f.nodeId).status()).connected).toBe(false); });
  expect(await session(f.nodeId).pushFrame("message.deliver", { messageId: sent.status.messageId })).toBe(false);
  expect((await registry().mcpMessageStatus(f.nodeId, sent.status.messageId))?.diagnostic).toMatchObject({ code: "node-offline" });
});

it("actual egress capability loss records binding-capability-missing while leaving the message queued", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(registry(), (_i, s) => {
    const sql = s.storage.sql, caps = JSON.parse(String(sql.exec("SELECT capabilities FROM nodes WHERE id=?", f.nodeId).one().capabilities));
    sql.exec("UPDATE nodes SET capabilities=? WHERE id=?", JSON.stringify(caps.filter((c: string) => c !== "messaging.selected-binding.v1")), f.nodeId);
  });
  expect(await registry().prepareMessageDelivery(sent.status.messageId)).toBeNull();
  expect((await registry().mcpMessageStatus(f.nodeId, sent.status.messageId))?.diagnostic).toMatchObject({ code: "binding-capability-missing" });
});
