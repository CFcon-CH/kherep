import assert from "node:assert/strict";
import test from "node:test";
import { isMessageDeliverBody, isMessageSendBody } from "./protocol-messages.mts";
const nodeId = "00000000-0000-4000-8000-000000000001";
const sentAt = "2026-01-01T00:00:00.000Z";
const body = { messageId: nodeId, fromSession: "sender", to: { nodeId, session: "target" }, text: "synthetic" };
test("node sends cannot supply a delivery attestation or a noncanonical sender timestamp", () => {
  assert.equal(isMessageSendBody({ ...body, senderOrigin: { nodeId, sentAt } }), false);
  for (const senderSentAt of [null, 1, "2026-01-01T00:00:00Z", "1969-12-31T23:59:59.999Z", "+275760-09-13T00:00:00.000Z"]) {
    assert.equal(isMessageSendBody({ ...body, senderSentAt }), false);
  }
  assert.equal(isMessageSendBody({ ...body, senderSentAt: sentAt }), true);
  assert.equal(isMessageSendBody(body), true);
});
test("deliveries bind their origin to the authenticated source node", () => {
  const deliver = { messageId: nodeId, from: { nodeId, session: "sender" }, toSession: "target", text: "synthetic", createdAt: sentAt };
  assert.equal(isMessageDeliverBody({ ...deliver, senderOrigin: { nodeId: "00000000-0000-4000-8000-000000000002", sentAt } }), false);
  assert.equal(isMessageDeliverBody({ ...deliver, senderOrigin: { nodeId, sentAt } }), true);
  assert.equal(isMessageDeliverBody(deliver), true);
});
