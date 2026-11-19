import { describe, expect, it, vi } from "vitest";

import { makeEnvelope, type Envelope, type MessageType } from "../../protocol.mts";
import {
  digestMcpArguments, isCodexActivityRegistration, type CodexActivityRegistration, type McpAssignmentNative,
} from "../../protocol-mcp.mts";
import { CLOSE } from "../src/handshake.mts";
import { authenticate, connect, enroll, newKey, registry, session, type TestSocket } from "./helpers.mts";

// Issue #965: the refusal branches of NodeSession.dispatch, driven by frames
// on an authenticated socket. A refusal that sends nothing is proven by the
// probe that follows it: the probe's reply is the very next frame.
async function online(): Promise<{ nodeId: string; socket: TestSocket; send: (type: MessageType, body: unknown) => void }> {
  const key = await newKey();
  const nodeId = await enroll(key);
  const socket = await authenticate(nodeId, key);
  let seq = 0;
  return { nodeId, socket, send: (type, body) => socket.send(makeEnvelope(type, body, ++seq, 0)) };
}

const PROBE = { type: "error", body: { error: "invalid runtimes" } };
const uuid = () => crypto.randomUUID();

describe("NodeSession frame refusals", () => {
  it("answers each malformed frame with its own error", async () => {
    const { socket, send } = await online();
    const cases: [MessageType, unknown, string][] = [
      ["register", {}, "invalid register body"],
      ["capabilities.update", { runtimes: "codex" }, "invalid runtimes"],
      ["sessions.snapshot", { sessions: "none" }, "invalid sessions"],
      ["sessions.snapshot", { sessions: [], identitySnapshot: "bad" }, "invalid identity snapshot"],
      ["sessions.snapshot", { sessions: [], slotSelection: { slot: "nobody" } }, "invalid slot selection"],
      ["mcp.credential.rotate", { requestId: "not-a-uuid" }, "invalid MCP credential request"],
      ["mcp.intent.register", { requestId: uuid() }, "invalid MCP intent metadata"],
      ["mcp.inbox.response", { requestId: uuid() }, "invalid MCP inbox response"],
    ];
    for (const [type, body, error] of cases) {
      send(type, body);
      expect(await socket.next()).toMatchObject({ type: "error", body: { error } });
    }
    socket.ws.close(1000, "done");
  });

  it("drops frames that carry nothing to act on, without a reply", async () => {
    const { socket, send } = await online();
    const silent: [MessageType, unknown][] = [
      ["command.ack", { commandId: 7 }],
      ["command.result", { commandId: uuid() }],
      ["mcp.inbox.response", { requestId: uuid(), ok: false, error: "late" }],
      ["mcp.lead.confirm.response", { nonce: "not-a-uuid", allowed: true }],
      ["mcp.lead.confirm.response", { nonce: uuid(), allowed: true }],
      ["event", { name: "unrelated.event" }],
      ["event", { name: 42 }],
      ["error", { error: "node-side failure" }],
    ];
    for (const [type, body] of silent) {
      send(type, body);
      send("capabilities.update", { runtimes: "probe" });
      expect(await socket.next()).toMatchObject(PROBE);
    }
    socket.ws.close(1000, "done");
  });

  it("refuses Codex activity self-assignment before the registration is accepted", async () => {
    const { socket, send } = await online();
    const sessionId = uuid(), requestId = uuid();
    const body: CodexActivityRegistration = { kind: "codex-activity-v1", observedAt: Date.now(), identitySnapshot: { version: 1, generation: 1 },
      sessions: [{ sessionId, runtime: "codex", kind: "codex", state: "unknown", title: "Synthetic original" }],
      intent: { requestId, runtime: "codex", sessionId, threadId: sessionId, callId: uuid(), tool: "assign_self",
        argumentsDigest: await digestMcpArguments({ slot: "codex-mac" }), assignment: { slot: "codex-mac", turnId: uuid(),
          native: { sessionId, chatName: "Synthetic original", platform: "darwin", originalMain: true } as McpAssignmentNative } } };
    expect(isCodexActivityRegistration(body)).toBe(true);
    send("mcp.intent.register", body);
    expect(await socket.next()).toMatchObject({ type: "mcp.intent.receipt", body: { requestId, ok: false,
      error: "current enrolled-node registration is required for self-assignment" } });
    socket.ws.close(1000, "done");
  });

  it("replaces the runtimes from a valid capabilities update", async () => {
    const { nodeId, socket, send } = await online();
    send("capabilities.update", { runtimes: [{ name: "codex", kind: "cli" }] });
    await vi.waitFor(async () => expect((await registry().getNode(nodeId))?.runtimes).toEqual([{ name: "codex", kind: "cli" }]));
    socket.ws.close(1000, "done");
  });

  it("answers an unparsable frame with an error once authenticated", async () => {
    const { socket } = await online();
    socket.ws.send("not json");
    const frame: Envelope = await socket.next();
    expect(frame.type).toBe("error");
    expect(typeof (frame.body as { error?: unknown }).error).toBe("string");
    socket.ws.close(1000, "done");
  });

  it("closes an unauthenticated socket on an unparsable frame", async () => {
    const nodeId = await enroll(await newKey());
    const { socket } = await connect(nodeId);
    socket.ws.send("not json");
    expect((await socket.closed).code).toBe(CLOSE.protocol);
  });
});

describe("NodeSession upgrade refusals", () => {
  it("refuses a request without a WebSocket upgrade", async () => {
    const response = await session(uuid()).fetch(new Request("https://control.example.com/connect"));
    expect(response.status).toBe(426);
  });

  it("refuses an upgrade with an invalid nodeId", async () => {
    const response = await session(uuid()).fetch(new Request("https://control.example.com/connect?nodeId=bad",
      { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(400);
  });
});

describe("NodeSession revoke", () => {
  it("refuses new commands and reports no connection after a revoke", async () => {
    const { nodeId, socket } = await online();
    await session(nodeId).revoke();
    expect((await socket.closed).code).toBe(CLOSE.unknownOrRevoked);
    expect(await session(nodeId).enqueue("node.status")).toEqual({ ok: false, error: "node revoked" });
    expect(await session(nodeId).status()).toMatchObject({ status: "revoked", connected: false });
  });
});
