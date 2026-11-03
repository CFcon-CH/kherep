import { expect, it } from "vitest";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { authenticate, nextMessageStatus, registry, until } from "./helpers.mts";
import { frame, node, row } from "./message-retention-fixture.mts";
const ORIGIN = "messaging.origin.v1";
const SENT = "2026-01-01T00:00:00.000Z";
it("authenticates origin at the node boundary and persists it literally across replay and conflicting retries", async () => {
  const a = await node("origin-a", [MESSAGING_CAPABILITY, ORIGIN]);
  const b = await node("origin-b", [MESSAGING_CAPABILITY, ORIGIN]);
  const sender = await authenticate(a.nodeId, a.key);
  const messageId = crypto.randomUUID();
  const body = { messageId, fromSession: "sender", to: { nodeId: b.nodeId, session: "target" }, text: "synthetic", senderSentAt: SENT };
  frame(sender, "message.send", body);
  await nextMessageStatus(sender, { messageId, state: "queued" });
  const stored = await row(messageId);
  expect(stored?.sender_sent_at).toBe(SENT);
  const delivery = (await registryPending(b.nodeId)).deliveries[0]!.body;
  expect(delivery.senderOrigin).toEqual({ nodeId: a.nodeId, sentAt: SENT });
  expect(delivery.createdAt).not.toBe(SENT);
  for (const replacement of [{ senderSentAt: "2026-01-02T00:00:00.000Z" }, { to: { ...body.to, session: "other" } }, { text: "changed" }]) {
    frame(sender, "message.send", { ...body, ...replacement });
    await until(sender, "error", { messageId, error: "conflicting message binding" });
    expect(await row(messageId)).toEqual(stored);
  }
  frame(sender, "message.send", body);
  await nextMessageStatus(sender, { messageId, state: "queued" });
  expect((await registryPending(b.nodeId)).deliveries[0]!.body.senderOrigin).toEqual(delivery.senderOrigin);
});
it("rejects future and caller-attested origin and never upgrades a legacy origin-null row", async () => {
  const a = await node("origin-legacy-a", [MESSAGING_CAPABILITY, ORIGIN]);
  const b = await node("origin-legacy-b", [MESSAGING_CAPABILITY]);
  const sender = await authenticate(a.nodeId, a.key);
  const base = { fromSession: "s", to: { nodeId: b.nodeId, session: "t" }, text: "synthetic" };
  const messageId = crypto.randomUUID();
  frame(sender, "message.send", { ...base, messageId });
  await nextMessageStatus(sender, { messageId, state: "queued" });
  expect((await registryPending(b.nodeId)).deliveries[0]!.body.senderOrigin).toBeUndefined();
  frame(sender, "message.send", { ...base, messageId, senderSentAt: SENT });
  await until(sender, "error", { messageId, error: "conflicting message binding" });
  expect((await row(messageId))?.sender_sent_at).toBeNull();
  for (const extra of [{ senderSentAt: "9999-01-01T00:00:00.000Z" }, { senderOrigin: { nodeId: a.nodeId, sentAt: SENT } }]) {
    const id = crypto.randomUUID();
    frame(sender, "message.send", { ...base, messageId: id, ...extra });
    await until(sender, "error", { error: "invalid message.send body" });
    expect(await row(id)).toBeUndefined();
  }
});
const registryPending = (target: string) => registry().pendingMessagesFor(target);

it("old-capability senders do not acquire authenticated origin", async () => {
  const a = await node("origin-old-sender", [MESSAGING_CAPABILITY]);
  const b = await node("origin-new-target", [MESSAGING_CAPABILITY, ORIGIN]);
  const sender = await authenticate(a.nodeId, a.key);
  const messageId = crypto.randomUUID();
  frame(sender, "message.send", { messageId, fromSession: "sender", to: { nodeId: b.nodeId, session: "target" }, text: "synthetic", senderSentAt: SENT });
  await nextMessageStatus(sender, { messageId, state: "queued" });
  expect((await registryPending(b.nodeId)).deliveries[0]!.body.senderOrigin).toBeUndefined();
  expect((await row(messageId))?.sender_sent_at).toBeNull();
});
