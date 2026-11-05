import { expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { blockerDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { isMessageStatusBody as archivedStatus } from "../../fixtures/diagnostics-pre-v1.mts";
import { authenticate, enroll, FACTS, newKey, registry, session, until } from "./helpers.mts";
import { makeEnvelope } from "../../protocol.mts";
import { MessageStore } from "../src/message-store.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
const progress = { phase: "waiting" as const, code: "retry-pending" as const, observedAt: "2026-11-05T00:00:00.000Z" };
async function pair() {
  const key = await newKey(), source = await enroll(key), target = await enroll(await newKey());
  for (const n of [source, target]) await registry().updateRegistration(n, FACTS, [], [MESSAGING_CAPABILITY, MESSAGING_DIAGNOSTICS_CAPABILITY]);
  const messageId = crypto.randomUUID();
  await registry().sendMessage({ messageId, from: { nodeId: source, session: "sender" }, to: { nodeId: target, session: "target" }, text: "synthetic" }, "test");
  return { key, source, target, messageId };
}
it("persists reported diagnostics, replays them, and clears waiting detail on advancement without extending receipts", async () => {
  const p = await pair(), diagnostic = blockerDiagnostic("runtime-pending", Date.parse(progress.observedAt));
  const result = await registry().reportMessageStatus(p.target, { messageId: p.messageId, state: "accepted", progress, diagnostic });
  expect(result.effects.statuses[0].body.diagnostic).toEqual(diagnostic);
  expect(Object.keys(result.receipt!).sort()).toEqual(["messageId", "name", "requestedState", "storedProgressAt", "storedState"].sort());
  expect((await registry().messageStatusPageFor(p.source, 0, 100)).effects.statuses[0].body.diagnostic).toEqual(diagnostic);
  await registry().reportMessageStatus(p.target, { messageId: p.messageId, state: "delivered" });
  expect((await registry().messageStatusPageFor(p.source, 0, 100)).effects.statuses[0].body.diagnostic).toBeUndefined();
});
it("uses the archived real validator on routed and replayed old-sender status", async () => {
  const p = await pair();
  await registry().updateRegistration(p.source, FACTS, [], [MESSAGING_CAPABILITY]);
  const r = await registry().reportMessageStatus(p.target, { messageId: p.messageId, state: "accepted", progress,
    diagnostic: blockerDiagnostic("runtime-pending", Date.parse(progress.observedAt)) });
  expect(archivedStatus(r.effects.statuses[0].body)).toBe(true);
  const page = await registry().messageStatusPageFor(p.source, 0, 100);
  expect(archivedStatus(page.effects.statuses[0].body)).toBe(true);
});
it("socket stripping covers immediate/error pushes and capability loss on reconnect", async () => {
  const p = await pair(), diagnostic = blockerDiagnostic("runtime-pending", 0);
  let socket = await authenticate(p.source, p.key);
  socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [], capabilities: [MESSAGING_CAPABILITY, MESSAGING_DIAGNOSTICS_CAPABILITY] }, 1, 0));
  await vi.waitFor(async () => { expect((await session(p.source).loopCapabilityEvidence()).registered).toBe(true); });
  await session(p.source).pushFrame("message.status", { messageId: p.messageId, state: "accepted", diagnostic });
  expect((await until(socket, "message.status", { messageId: p.messageId, state: "accepted" })).at(-1)?.body).toHaveProperty("diagnostic");
  socket.ws.close(); socket = await authenticate(p.source, p.key);
  socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [], capabilities: [MESSAGING_CAPABILITY] }, 1, 0));
  await vi.waitFor(async () => { expect((await session(p.source).loopCapabilityEvidence()).registered).toBe(true); });
  await session(p.source).pushFrame("message.status", { messageId: p.messageId, state: "accepted", diagnostic });
  expect(archivedStatus((await until(socket, "message.status", { messageId: p.messageId, state: "accepted" })).at(-1)?.body)).toBe(true);
  await runInDurableObject(session(p.source), (instance, state) => {
    const ws = state.getWebSockets().find(w => (w.deserializeAttachment() as { authed?: boolean })?.authed)!;
    (instance as unknown as { sendControl(w: WebSocket, t: string, b: object): void }).sendControl(ws, "error", { messageId: p.messageId, error: "fixed refusal", diagnostic });
  });
  expect((await until(socket, "error", { messageId: p.messageId })).at(-1)?.body).not.toHaveProperty("diagnostic");
  socket.ws.close();
});

it("failed diagnostic SQL replacement and clearing never replay an obsolete target cause or change state advancement", async () => {
  const p = await pair(), diagnostic = blockerDiagnostic("runtime-pending", Date.parse(progress.observedAt));
  await registry().reportMessageStatus(p.target, { messageId: p.messageId, state: "accepted", progress, diagnostic });
  await runInDurableObject(registry(), (_i, s) => {
    const sql = s.storage.sql, store = new MessageStore(sql, () => {}, () => [MESSAGING_CAPABILITY, MESSAGING_DIAGNOSTICS_CAPABILITY]);
    const original = sql.exec.bind(sql);
    const spy = vi.spyOn(sql, "exec").mockImplementation((query, ...args) => {
      if (query.startsWith("UPDATE messages SET diagnostic_json")) throw new Error("synthetic diagnostic storage failure");
      return original(query, ...args);
    });
    try {
      const next = { ...progress, observedAt: "2026-11-05T00:00:01.000Z" };
      const changed = store.report(p.target, { messageId: p.messageId, state: "accepted", progress: next,
        diagnostic: blockerDiagnostic("turn-spacing", Date.parse(next.observedAt)) }, Date.now());
      expect(changed.receipt?.storedState).toBe("accepted");
      expect(store.statusPageFor(p.source, 0, 100).effects.statuses[0].body.diagnostic).toBeUndefined();
      expect(store.report(p.target, { messageId: p.messageId, state: "delivered" }, Date.now()).receipt?.storedState).toBe("delivered");
      expect(store.statusPageFor(p.source, 0, 100).effects.statuses[0].body.diagnostic).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
});
