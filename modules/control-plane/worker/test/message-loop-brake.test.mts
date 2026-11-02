import { expect, it } from "vitest";
import { MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

import { pair } from "./message-loop-fixture.mts";

it("admits twenty novel alternating replies in one Worker-authoritative thread, including an ACK-deleted parent", async () => {
  const { a, b, send } = await pair();
  let parent: string | undefined;
  let thread: string | undefined;
  for (let depth = 0; depth <= 20; depth++) {
    const from = depth % 2 === 0 ? a : b;
    const to = depth % 2 === 0 ? b : a;
    const result = await send(from, to, `Synthetic test ${depth} now passes at /work/${depth}`, parent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.status.state).toBe("queued");
    const body = result.effects.deliveries[0]?.body;
    thread ??= result.status.messageId;
    expect(body?.loop).toMatchObject({ version: 1, threadId: thread, depth, ordinal: depth + 1 });
    await registry().reportMessageStatus(to, { messageId: result.status.messageId, state: "delivered" });
    await registry().ackMessageStatus(from, { name: "message.status.ack", messageId: result.status.messageId, state: "delivered" });
    parent = result.status.messageId;
  }
});

it("refuses the third acknowledgement and keeps the unordered pair held across roots and retries", async () => {
  const { a, b, send } = await pair();
  const root = await send(a, b, "Investigate synthetic build 17");
  if (!root.ok) throw new Error(root.error);
  let parent = root.status.messageId;
  await registry().reportMessageStatus(b, { messageId: parent, state: "accepted" });
  for (const [index, text] of ["ack", "OK!", "received"].entries()) {
    const result = await send(index % 2 === 0 ? b : a, index % 2 === 0 ? a : b, text, parent);
    if (!result.ok) throw new Error(result.error);
    expect(result.status.state).toBe(index === 2 ? "refused" : "queued");
    if (index === 2) {
      expect(result.status.reason).toMatch(/^loop-held: ack-or-repeat; hold=/);
      const retry = await send(b, a, text, parent, result.status.messageId);
      expect(retry.ok && retry.status).toEqual(result.status);
      const fresh = await send(a, b, "A different synthetic root");
      expect(fresh.ok && fresh.status.reason).toEqual(result.status.reason);
      expect(result.effects.deliveries).toEqual([]);
    }
    if (index < 2) await registry().reportMessageStatus(index % 2 === 0 ? a : b, { messageId: result.status.messageId, state: "accepted" });
    parent = result.status.messageId;
  }
});
