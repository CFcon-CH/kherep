import { bindingNode } from "./binding-node-fixture.mts";
import { MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { authenticate, enroll, FACTS, newKey, registry, session } from "./helpers.mts";
export async function pair() {
  const a = await enroll(await newKey(), "synthetic-loop-a");
  const b = await enroll(await newKey(), "synthetic-loop-b");
  for (const nodeId of [a, b]) {
    await registry().updateRegistration(nodeId, FACTS, [], [MESSAGING_CAPABILITY, MESSAGING_ACK_CAPABILITY, "messaging.loop-brake.v1"]);
    await registry().replaceSessions(nodeId, [{ sessionId: "session", name: "alias", runtime: "codex", state: "running" }]);
  }
  const send = (from: string, to: string, text: string, inReplyTo?: string, messageId = crypto.randomUUID()) =>
    registry().sendMessage({ messageId, from: { nodeId: from, session: "session" }, to: { nodeId: to, session: "session" }, text,
      ...(inReplyTo ? { inReplyTo } : {}) }, "synthetic-test");
  return { a, b, send };
}


import type { SessionInfo } from "../../protocol.mts";
export const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const BRAKE_CAPS = [MESSAGING_CAPABILITY, MESSAGING_ACK_CAPABILITY, "messaging.loop-brake.v1"];
export function attestedRows(now = Date.now(), lifecycleGeneration = 0): SessionInfo[] {
  return [ID_A, ID_B].map((sessionId, i) => ({ sessionId, name: `alias-${i}`, runtime: "codex", state: "unknown", canonicalIdentity: {
    version: 1, source: "codex-hook", runtime: "codex", sessionId, observedAt: now, lifecycleGeneration,
  } }));
}
export async function attestedPair(capabilities = BRAKE_CAPS) {
  const fixture = await bindingNode(attestedRows().map(({ sessionId, runtime, name }) => ({ sessionId, runtime, name })), capabilities);
  const { nodeId } = fixture;
  let manualLocal = false;
  await registry().replaceSessions(nodeId, attestedRows(), { version: 1, generation: 1 });
  const send = async (from = ID_A, to = ID_B, parent?: string, text = `Synthetic novel result ${crypto.randomUUID()}`) => {
    // Arrange a synthetic complete local cache separately from the Registry.
    // Missing published rows do not erase this Node fixture's retained metadata.
    const published = (await registry().listSessions()).filter(r => r.nodeId === nodeId);
    if (!manualLocal && published.length) fixture.setRows(published.map(({ sessionId, runtime, name }) => ({ sessionId, runtime, name: name ?? "" })));
    return registry().sendMessage({
    messageId: crypto.randomUUID(), from: { nodeId, session: from }, to: { nodeId, session: to }, text, inReplyTo: parent,
  }, "synthetic-test");
  };
  const take = async (id: string) => {
    await registry().reportMessageStatus(nodeId, { messageId: id, state: "delivered" });
    await registry().ackMessageStatus(nodeId, { messageId: id, name: "message.status.ack", state: "delivered" });
  };
  return { ...fixture, nodeId, send, take,
    setLocalRows: (rows: { sessionId: string; runtime: string; name: string }[]) => { fixture.setRows(rows); manualLocal = true; } };
}
