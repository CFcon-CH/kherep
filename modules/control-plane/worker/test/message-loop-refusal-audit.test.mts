import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { FACTS, registry } from "./helpers.mts";
import { attestedPair, attestedRows, ID_A, ID_B, pair } from "./message-loop-fixture.mts";
// #773: every loop-compatibility refusal names the branch that fired and the two
// endpoint reference codes in the audit detail. The status reason stays fixed.
const COMPATIBILITY = "loop-compatibility: legacy reply limit";
const refusal = (action: string, messageId: string) => runInDurableObject(registry(), (_i, state) => state.storage.sql
  .exec("SELECT detail FROM audit WHERE action = ? AND detail LIKE ?", action, `%${messageId}%`).toArray()
  .map(row => JSON.parse(String(row.detail)) as Record<string, unknown>).find(detail => detail.state === "refused"));
const tombstone = (column: string, value: number | null, id: string) => runInDurableObject(registry(), (_i, state) => {
  state.storage.sql.exec(`UPDATE message_tombstones SET ${column} = ? WHERE id = ?`, value, id);
});

it("admit-endpoint: an endpoint without a current proof refuses a guarded reply", async () => {
  const { nodeId, send, take } = await attestedPair();
  const root = await send(); if (!root.ok) throw new Error(root.error); await take(root.status.messageId);
  await registry().replaceSessions(nodeId, attestedRows(Date.now() + 61_000), { version: 1, generation: 2 });
  const reply = await send(ID_B, ID_A, root.status.messageId); if (!reply.ok) throw new Error(reply.error);
  expect(reply.status.reason).toBe(COMPATIBILITY);
  expect(await refusal("message.send", reply.status.messageId)).toMatchObject(
    { reason: COMPATIBILITY, loopBranch: "admit-endpoint", fromCode: "INVALID_PROOF", toCode: "INVALID_PROOF" });
});
it("admit-binding: an unbound guarded parent without positive compatibility refuses", async () => {
  const { send, take } = await attestedPair();
  const root = await send(); if (!root.ok) throw new Error(root.error); await take(root.status.messageId);
  await tombstone("loop_identity", null, root.status.messageId);
  const reply = await send(ID_B, ID_A, root.status.messageId); if (!reply.ok) throw new Error(reply.error);
  expect(await refusal("message.send", reply.status.messageId)).toMatchObject(
    { reason: COMPATIBILITY, loopBranch: "admit-binding", fromCode: "ATTESTED", toCode: "ATTESTED" });
});
it("deliver-identity: a queued bound row whose endpoints lost their proof refuses", async () => {
  const { nodeId, send } = await attestedPair();
  const root = await send(); if (!root.ok) throw new Error(root.error);
  await registry().replaceSessions(nodeId, attestedRows(Date.now() + 61_000), { version: 1, generation: 2 });
  expect(await registry().messageDeliveryReady(root.status.messageId)).toBe(false);
  expect(await refusal("message.state", root.status.messageId)).toMatchObject(
    { reason: COMPATIBILITY, loopBranch: "deliver-identity", fromCode: "INVALID_PROOF", toCode: "INVALID_PROOF" });
});
it("deliver-capability: a queued unbound guarded row refuses after a brake downgrade", async () => {
  const { a, b, send } = await pair();
  const root = await send(a, b, "Synthetic queued result"); if (!root.ok) throw new Error(root.error);
  await registry().updateRegistration(a, FACTS, [], [MESSAGING_CAPABILITY]);
  expect(await registry().messageDeliveryReady(root.status.messageId)).toBe(false);
  expect(await refusal("message.state", root.status.messageId)).toMatchObject(
    { reason: COMPATIBILITY, loopBranch: "deliver-capability", fromCode: "LEGACY_KNOWN", toCode: "LEGACY_KNOWN" });
});
it("deliver-capability: a queued bound attested row refuses after a brake downgrade", async () => {
  const { nodeId, send } = await attestedPair();
  const root = await send(); if (!root.ok) throw new Error(root.error);
  await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], [MESSAGING_CAPABILITY]);
  expect(await registry().messageDeliveryReady(root.status.messageId)).toBe(false);
  expect(await refusal("message.state", root.status.messageId)).toMatchObject(
    { reason: COMPATIBILITY, loopBranch: "deliver-capability", fromCode: "ATTESTED", toCode: "ATTESTED" });
});
it("other loop refusals record no loop branch", async () => {
  const { send, take } = await attestedPair();
  const root = await send(); if (!root.ok) throw new Error(root.error); await take(root.status.messageId);
  await tombstone("loop_ordinal", 0, root.status.messageId);
  const reply = await send(ID_B, ID_A, root.status.messageId); if (!reply.ok) throw new Error(reply.error);
  const detail = await refusal("message.send", reply.status.messageId);
  expect(detail).toMatchObject({ reason: "loop-lineage-unavailable" });
  expect(detail).not.toHaveProperty("loopBranch");
});
