import { expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { blockerDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY as V1, MESSAGING_DIAGNOSTICS_V2_CAPABILITY as V2 } from "../../protocol-diagnostics.mts";
import { makeEnvelope } from "../../protocol.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { isMessageDiagnostic as previousNodeAccepts } from "../../test/fixtures/diagnostics-pre-v2.mts";
import { authenticate, enroll, FACTS, newKey, registry, session, until, type TestSocket } from "./helpers.mts";
import { attestedPair, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";

type Diagnosed = { diagnostic?: { code?: string } };
const X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Y = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
// A held scope makes a binding mandatory, and the fixture node answers MISSING for an unlisted reference.
async function refusedByMissingTarget(modern: boolean) {
  const f = await attestedPair([...BRAKE_CAPS, V1, ...(modern ? [V2] : [])]);
  for (let i = 0; i < 3; i++) { const r = await f.send(ID_A, ID_B, undefined, "ack"); if (r.ok && i < 2) await f.take(r.status.messageId); }
  const messageId = crypto.randomUUID();
  f.socket.send(makeEnvelope("message.send", { messageId, fromSession: X, to: { nodeId: f.nodeId, session: Y }, text: "Synthetic refusal" }, f.nextSequence(), 0));
  const frame = (await until(f.socket, "message.status", { messageId, state: "refused" }, 32)).at(-1)!;
  return { f, messageId, body: frame.body as Diagnosed & { reason?: string } };
}
const storedCode = (messageId: string) => runInDurableObject(registry(), (_i, state) =>
  JSON.parse(String(state.storage.sql.exec("SELECT diagnostic_json FROM messages WHERE id=?", messageId).one().diagnostic_json)).code);
async function nextDiagnosed(socket: TestSocket, messageId: string): Promise<Diagnosed> {
  for (let frames = 0; frames < 32; frames++) {
    const { type, body } = await socket.next();
    if (type === "message.status" && (body as { messageId?: string }).messageId === messageId && (body as Diagnosed).diagnostic) return body as Diagnosed;
  }
  throw new Error("no diagnosed status within 32 frames");
}
async function register(socket: TestSocket, nodeId: string, capabilities: string[]) {
  socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }], capabilities }, 1, 0));
  await vi.waitFor(async () => { expect((await session(nodeId).loopCapabilityEvidence()).registered).toBe(true); });
}

for (const modern of [false, true]) it(`admission refusal on the real socket, v2 peer=${modern}: the wire follows the peer, the row keeps the answer`, async () => {
  const { messageId, body } = await refusedByMissingTarget(modern);
  expect(body.reason).toBe("loop-resolution-required");
  expect(body.diagnostic?.code).toBe(modern ? "resolution-missing" : "resolution-unavailable");
  if (!modern) expect(previousNodeAccepts(body.diagnostic)).toBe(true);
  expect(await storedCode(messageId)).toBe("resolution-missing");
});

for (const modern of [false, true]) it(`stored refusal replayed after reconnect, v2 peer=${modern}`, async () => {
  const { f, messageId } = await refusedByMissingTarget(modern);
  const caps = [...BRAKE_CAPS, V1, ...(modern ? [V2] : []), "messaging.selected-binding.v1"];
  // Registry path: the page a reconnecting sender is replayed from.
  const page = await registry().messageStatusPageFor(f.nodeId, 0, 100);
  const replayed = page.effects.statuses.find(s => s.body.messageId === messageId)?.body as Diagnosed;
  expect(replayed.diagnostic?.code).toBe(modern ? "resolution-missing" : "resolution-unavailable");
  // Real socket: every replayed frame of this message must validate at a previous node unless the peer is v2.
  f.socket.ws.close();
  const socket = await authenticate(f.nodeId, f.key);
  const frame = (await until(socket, "message.status", { messageId, state: "refused" }, 32)).at(-1)!.body as Diagnosed;
  if (!modern) expect(frame.diagnostic === undefined || previousNodeAccepts(frame.diagnostic)).toBe(true);
  await register(socket, f.nodeId, caps);
  // Socket path after registration: the same row pushed with its raw stored code; the Attachment decides.
  const diagnostic = blockerDiagnostic("resolution-missing", Date.now(), "send-admission");
  await session(f.nodeId).pushFrame("message.status", { messageId, state: "refused", reason: "loop-resolution-required", diagnostic });
  const pushed = (await until(socket, "message.status", { messageId, state: "refused" }, 32)).at(-1)!.body as Diagnosed;
  expect(pushed.diagnostic?.code).toBe(modern ? "resolution-missing" : "resolution-unavailable");
  expect(await storedCode(messageId)).toBe("resolution-missing");
  socket.ws.close();
});

for (const modern of [false, true]) it(`observational egress status, v2 peer=${modern}: both the Registry effect and the socket follow the peer`, async () => {
  const key = await newKey(), source = await enroll(key), target = await enroll(await newKey());
  const caps = [MESSAGING_CAPABILITY, V1, ...(modern ? [V2] : [])];
  for (const n of [source, target]) await registry().updateRegistration(n, FACTS, [], caps);
  const messageId = crypto.randomUUID();
  await registry().sendMessage({ messageId, from: { nodeId: source, session: "sender" }, to: { nodeId: target, session: "target" }, text: "Synthetic" }, "test");
  const diagnostic = blockerDiagnostic("resolution-stale", Date.now(), "upstream-egress");
  const effects = await registry().observeMessageDiagnostic(messageId, target, diagnostic);
  expect(effects.statuses[0]).toMatchObject({ nodeId: source, observational: true });
  expect((effects.statuses[0].body as Diagnosed).diagnostic?.code).toBe(modern ? "resolution-stale" : "resolution-unavailable");
  expect((await registry().mcpMessageStatus(source, messageId) as Diagnosed).diagnostic?.code).toBe("resolution-stale");
  const socket = await authenticate(source, key);
  await register(socket, source, caps);
  expect(await session(source).pushFrame("message.status", { messageId, state: "queued", diagnostic }, true)).toBe(true);
  const frame = await nextDiagnosed(socket, messageId);
  expect(frame.diagnostic?.code).toBe(modern ? "resolution-stale" : "resolution-unavailable");
  if (!modern) expect(previousNodeAccepts(frame.diagnostic)).toBe(true);
  socket.ws.close();
});

it("the Attachment carries the unfiltered capability list, so a v2 socket keeps the code on an error frame and a v1 socket does not", async () => {
  for (const [capabilities, code] of [[[MESSAGING_CAPABILITY, V1, V2], "resolution-ambiguous"], [[MESSAGING_CAPABILITY, V1], "resolution-unavailable"]] as const) {
    const key = await newKey(), nodeId = await enroll(key), socket = await authenticate(nodeId, key), messageId = crypto.randomUUID();
    await register(socket, nodeId, [...capabilities]);
    await runInDurableObject(session(nodeId), (instance, state) => {
      const ws = state.getWebSockets().find(w => (w.deserializeAttachment() as { authed?: boolean })?.authed)!;
      expect((ws.deserializeAttachment() as { diagnosticCapabilities?: string[] }).diagnosticCapabilities).toEqual([...capabilities]);
      (instance as unknown as { sendControl(w: WebSocket, t: string, b: object): void }).sendControl(ws, "error",
        { messageId, error: "loop-resolution-required", diagnostic: blockerDiagnostic("resolution-ambiguous", 0, "duplicate") });
    });
    const frame = (await until(socket, "error", { messageId }, 32)).at(-1)!.body as Diagnosed;
    expect(frame.diagnostic?.code).toBe(code);
    socket.ws.close();
  }
});
