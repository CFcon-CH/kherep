import { expect, it, vi } from "vitest";
import { getMessage } from "../../node/inbox.mts";
import { registry } from "./helpers.mts";
import { CHAT_A, CHAT_B, WAIT, claudeMeta, sessionsOf, startNativeNode } from "./mcp-two-chat-fixture.mts";

// In-process real protocol/MCP clients, owned temporary homes and test Worker.
// The fixture name denotes native-hook shape, not a launched agent runtime.
it("two authenticated synthetic nodes exchange twenty linked replies through the real MCP and client paths", async () => {
  const a = await startNativeNode("synthetic-loop-client-a", sessionsOf(CHAT_A));
  const b = await startNativeNode("synthetic-loop-client-b", sessionsOf(CHAT_B));
  try {
    const ac = await a.mcp(), bc = await b.mcp();
    let parent: string | undefined, thread: string | undefined;
    for (let depth = 0; depth <= 20; depth++) {
      const sender = depth % 2 === 0 ? a : b, target = depth % 2 === 0 ? b : a;
      const session = depth % 2 === 0 ? CHAT_A : CHAT_B, targetSession = depth % 2 === 0 ? CHAT_B : CHAT_A;
      const call = `synthetic-loop-${depth}`, tool = parent ? "reply" : "send";
      const args = parent ? { inReplyTo: parent, text: `Synthetic novel result ${depth}` }
        : { to: { nodeId: target.nodeId, session: targetSession }, text: "Synthetic initial result0" };
      const input = await sender.hook(session, call, tool, args);
      const sent = await (depth % 2 === 0 ? ac : bc).callTool({ name: tool, arguments: input, _meta: claudeMeta(call) });
      expect(sent.structuredContent).toMatchObject({ ok: true, state: "queued" });
      parent = String(input.requestId); thread ??= parent;
      const id = parent;
      await vi.waitFor(async () => {
        expect(getMessage(target.paths.inbox, id)).toMatchObject({ depth, loop: { threadId: thread, depth, ordinal: depth + 1 } });
        expect((await registry().mcpMessageStatus(sender.nodeId, id))?.state).toBe("accepted");
      }, WAIT);
      // Preserve the production ACK-deletion seam, including MCP inbox target recovery.
      await registry().reportMessageStatus(target.nodeId, { messageId: id, state: "delivered" });
      await registry().ackMessageStatus(sender.nodeId, { name: "message.status.ack", messageId: id, state: "delivered" });
    }
    expect(a.received.filter((f) => f.type === "message.deliver")).toHaveLength(10);
    expect(b.received.filter((f) => f.type === "message.deliver")).toHaveLength(11);
  } finally { await b.close(); await a.close(); }
}, 30_000);
