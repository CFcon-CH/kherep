import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

import { parseEnvelope, type Envelope } from "../../protocol.mts";
import { routeEffects } from "../src/message-routing.mts";
import type { MessageEffects } from "../src/message-store.mts";
import { authenticate, registry, type TestSocket } from "./helpers.mts";
import { audits, nodes, row } from "./message-proxy-fixture.mts";

// Issue #408, PR 4, design r3 sections 4.2 and 4.3: the owner's reply or the
// owner node's delivered report refuses a proxy still queued; a delivery
// effect produced before that refusal is dropped at the push boundary of
// either path; a refused proxy that a node still reports taken is audited.

// Every frame a socket receives from now on. TestSocket.next with a timeout
// would leave a stale waiter that swallows the next frame.
function record(socket: TestSocket): Envelope[] {
  const frames: Envelope[] = [];
  socket.ws.addEventListener("message", (event) => {
    const parsed = parseEnvelope(event.data as string);
    if (parsed.ok) frames.push(parsed.envelope);
  });
  return frames;
}
const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const deliveries = (frames: Envelope[], id: string) => frames.filter((f) => f.type === "message.deliver"
  && (f.body as { messageId?: string }).messageId === id);
const effects = (result: { ok: boolean }): MessageEffects => (result as unknown as { effects: MessageEffects }).effects;

it("the owner's reply refuses a queued proxy with a status to the owner's node, and leaves an accepted one", async () => {
  const { peer, owner, send, original, proxy } = await nodes();
  const id = await original();
  const queued = (await proxy(id)).messageId;
  const reply = await send(owner, "s-owner", peer, "s-peer", { inReplyTo: id });
  expect(await row(queued)).toMatchObject({ state: "refused", reason: "superseded by the owner's reply" });
  expect(reply.result.ok && reply.result.effects.statuses).toEqual(expect.arrayContaining([
    { nodeId: owner, body: { messageId: queued, state: "refused", reason: "superseded by the owner's reply" } }]));
  expect(await row(id)).toMatchObject({ state: "replied", reply_message_id: reply.messageId });

  const second = await original();
  const accepted = (await proxy(second)).messageId;
  await registry().reportMessageStatus(peer, { messageId: accepted, state: "accepted" });
  await send(owner, "s-owner", peer, "s-peer", { inReplyTo: second });
  expect(await row(accepted)).toMatchObject({ state: "accepted", reason: null });
});

it("the owner node's delivered report refuses a queued proxy; an accepted one stays", async () => {
  const { peer, owner, original, proxy } = await nodes();
  const id = await original();
  const queued = (await proxy(id)).messageId;
  const report = await registry().reportMessageStatus(owner, { messageId: id, state: "delivered" });
  expect(await row(queued)).toMatchObject({ state: "refused", reason: "superseded: the owner read the message" });
  expect(report.effects.statuses).toEqual(expect.arrayContaining([
    { nodeId: owner, body: { messageId: queued, state: "refused", reason: "superseded: the owner read the message" } }]));
  expect(await row(id)).toMatchObject({ state: "delivered" });

  const second = await original();
  const accepted = (await proxy(second)).messageId;
  await registry().reportMessageStatus(peer, { messageId: accepted, state: "accepted" });
  await registry().reportMessageStatus(owner, { messageId: second, state: "delivered" });
  expect(await row(accepted)).toMatchObject({ state: "accepted", reason: null });
});

it("a delivery effect held while the owner replied is dropped at the local push; control: delivered", async () => {
  for (const replied of [true, false]) {
    const { peer, owner, send, original, proxy } = await nodes();
    const id = await original();
    const held = await proxy(id);
    if (replied) await send(owner, "s-owner", peer, "s-peer", { inReplyTo: id });
    expect(await row(held.messageId)).toMatchObject({ state: replied ? "refused" : "queued" });
    const local: { type: string; body: Record<string, unknown> }[] = [];
    await routeEffects(env, effects(held.result), { nodeId: peer, send: (type, body) => { local.push({ type, body }); return true; } });
    expect(local.filter((f) => f.type === "message.deliver" && f.body.messageId === held.messageId)).toHaveLength(replied ? 0 : 1);
  }
});

it("a delivery effect held while the owner replied is dropped at the remote push; control: delivered", async () => {
  for (const replied of [true, false]) {
    const { peer, owner, keys, send, original, proxy } = await nodes();
    const id = await original();
    const held = await proxy(id);
    if (replied) await send(owner, "s-owner", peer, "s-peer", { inReplyTo: id });
    const socket = await authenticate(peer, keys[peer]!);
    const frames = record(socket);
    await settle();
    expect(deliveries(frames, held.messageId), "at authentication").toHaveLength(replied ? 0 : 1);
    await routeEffects(env, effects(held.result));
    await settle();
    expect(deliveries(frames, held.messageId), "from the held effect").toHaveLength(replied ? 0 : 2);
    socket.ws.close(1000, "done");
  }
});

it("a node reporting a refused proxy accepted or delivered is audited as a late delivery", async () => {
  const { peer, owner, send, original, proxy } = await nodes();
  const id = await original();
  const queued = (await proxy(id)).messageId;
  await send(owner, "s-owner", peer, "s-peer", { inReplyTo: id });
  expect(await row(queued)).toMatchObject({ state: "refused" });
  await registry().reportMessageStatus(peer, { messageId: queued, state: "accepted" });
  expect(await row(queued)).toMatchObject({ state: "refused" });
  expect((await audits("message.proxy.late-delivery")).filter((d) => d.messageId === queued)).toHaveLength(1);
  const plain = await original();
  await registry().reportMessageStatus(owner, { messageId: plain, state: "refused", reason: "synthetic" });
  await registry().reportMessageStatus(owner, { messageId: plain, state: "accepted" });
  expect((await audits("message.proxy.late-delivery")).filter((d) => d.messageId === plain)).toHaveLength(0);
});
