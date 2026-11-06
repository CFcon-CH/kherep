import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { makeEnvelope } from "../../protocol.mts";
import { MESSAGING_CAPABILITY, type MessageDeliverBody, type MessageStatusBody } from "../../protocol-messages.mts";
import { nodePaths } from "../../node/config.mts";
import { getSent, recordSent, writeOutbox } from "../../node/exchange.mts";
import { setMessageProgress, storeMessage, unreportedStatuses } from "../../node/inbox.mts";
import { runMsgArgs } from "../../node/msg-cli.mts";
import { authenticate, enroll, FACTS, newKey, nextMessageStatus, registry } from "./helpers.mts";

// Existing messaging-only fixture contract, without newer optional capabilities.
// This is source compatibility evidence, not an assertion about a deployed Worker.
it("round trips accepted budget-exhausted and retryAt through the existing Worker fixture", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "budget status fixture "));
  const senderKey = await newKey(), targetKey = await newKey();
  const senderId = await enroll(senderKey, "budget-sender"), targetId = await enroll(targetKey, "budget-target");
  await registry().updateRegistration(senderId, FACTS, [], [MESSAGING_CAPABILITY]);
  await registry().updateRegistration(targetId, FACTS, [], [MESSAGING_CAPABILITY]);
  const sender = await authenticate(senderId, senderKey), target = await authenticate(targetId, targetKey);
  try {
    const a = nodePaths(path.join(root, "sender")), b = nodePaths(path.join(root, "target"));
    const messageId = crypto.randomUUID(), now = Date.now(), retryAt = now + 60000;
    const outgoing = { messageId, fromSession: "sender", to: { nodeId: targetId, session: "target" }, text: "synthetic" };
    writeOutbox(a, { ...outgoing, createdAt: new Date(now).toISOString() });
    sender.send(makeEnvelope("message.send", outgoing, 0, 0));
    await nextMessageStatus(sender, { messageId, state: "queued" });
    const delivered = await target.next();
    expect(delivered.type).toBe("message.deliver");
    storeMessage(b.inbox, delivered.body as unknown as MessageDeliverBody, now);
    const progress = setMessageProgress(b.inbox, messageId, "waiting", "budget-exhausted", now, retryAt)!;
    const report = unreportedStatuses(b.inbox, now).find(r => r.messageId === messageId)!;
    target.send(makeEnvelope("message.status", { messageId, state: report.state, progress: report.progress }, 0, 0));
    const returned = await nextMessageStatus(sender, { messageId, state: "accepted", progress }) as MessageStatusBody;
    recordSent(a, messageId, returned.state, returned.reason, now, returned.progress);
    expect(getSent(a, messageId)).toMatchObject({ state: "accepted", progress });
    for (const paths of [a, b]) {
      const lines: string[] = [];
      expect(await runMsgArgs({ positionals: ["status", messageId], values: {} }, { paths, env: {}, now: () => now,
        out: line => lines.push(line), err: line => { throw new Error(line); } })).toBe(0);
      expect(lines.join("\n")).toContain("waiting/budget-exhausted");
      expect(lines.join("\n")).toContain(new Date(retryAt).toISOString());
    }
  } finally {
    sender.ws.close(); target.ws.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
