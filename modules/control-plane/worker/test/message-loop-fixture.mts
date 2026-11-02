import { MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";
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

