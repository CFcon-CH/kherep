import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { REMOTE_MCP_CAPABILITY, digestMcpArguments } from "../../protocol-mcp.mts";
import { makeEnvelope } from "../../protocol.mts";
import { NodeClient } from "../../node/client.mts";
import { generateIdentity } from "../../node/identity.mts";
import { DEFAULT_POLICY } from "../../node/policy.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { handleMcp } from "../src/mcp-http.mts";
import type { Env } from "../src/env.mts";
import { FACTS, BASE, authenticate, newKey, registry, session, workerFetch } from "./helpers.mts";

const enabledEnv = { ...env, REMOTE_MCP_ENABLED: "true" } as Env;

async function source() {
  const key = await newKey();
  const { code } = await registry().createEnrollment("test");
  const enrolled = await registry().redeemEnrollment({ code, publicKey: key.publicKey, name: "mcp-source", facts: FACTS,
    runtimes: [{ name: "codex", kind: "cli" }] });
  if (!enrolled.ok) throw new Error(enrolled.reason);
  await registry().updateRegistration(enrolled.nodeId, FACTS, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
  await registry().replaceSessions(enrolled.nodeId, [{ sessionId: "thread-source", runtime: "codex", state: "running" }]);
  const credential = await registry().rotateMcpCredential(enrolled.nodeId);
  if (!credential.ok) throw new Error(credential.error);
  return { nodeId: enrolled.nodeId, credential, key };
}

function mcpFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return handleMcp(new Request(input, init), enabledEnv);
}

async function client(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    authProvider: { token: async () => token }, fetch: mcpFetch,
  });
  const instance = new Client({ name: "synthetic-codex", version: "1.0.0" });
  await instance.connect(transport);
  return instance;
}

async function target() {
  const key = await newKey();
  const { code } = await registry().createEnrollment("test");
  const enrolled = await registry().redeemEnrollment({ code, publicKey: key.publicKey, name: "target", facts: FACTS,
    runtimes: [{ name: "codex", kind: "cli" }] });
  if (!enrolled.ok) throw new Error(enrolled.reason);
  await registry().updateRegistration(enrolled.nodeId, FACTS, [{ name: "codex", kind: "cli" }], [MESSAGING_CAPABILITY]);
  await registry().replaceSessions(enrolled.nodeId, [{ sessionId: "target-session", runtime: "codex", state: "running" }]);
  return enrolled.nodeId;
}

describe("stateless remote MCP HTTP", () => {
  it("stays absent when the global route flag is disabled", async () => {
    expect((await workerFetch("/mcp", { method: "POST" })).status).toBe(404);
  });

  it("requires a current per-node bearer without echoing malformed input", async () => {
    const missing = await handleMcp(new Request(`${BASE}/mcp`, { method: "POST", body: "secret-looking-malformed" }), enabledEnv);
    expect(missing.status).toBe(401);
    expect(await missing.text()).not.toContain("secret-looking-malformed");

    const { credential } = await source();
    const first = await client(credential.token);
    expect((await first.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["assign_self", "inbox", "reply", "send", "sessions", "status"]);
    await first.close();

    await registry().rotateMcpCredential((await registry().authenticateMcpCredential(credential.token))?.nodeId ?? "stale");
    await expect(client(credential.token)).rejects.toThrow();
  });

  it("uses exact Codex metadata and a native intent for a read-only tool", async () => {
    const { nodeId, credential } = await source();
    const requestId = "20000000-0000-4000-8000-000000000001";
    const args = { limit: 5 };
    const intent = await registry().registerMcpIntent(nodeId, {
      requestId, runtime: "codex", sessionId: "thread-source", threadId: "thread-source", callId: "call-1",
      tool: "sessions", argumentsDigest: await digestMcpArguments(args),
    });
    expect(intent.ok).toBe(true);

    const instance = await client(credential.token);
    const result = await instance.callTool({ name: "sessions", arguments: { requestId, ...args },
      _meta: { sessionId: "thread-source", threadId: "thread-source", callId: "call-1" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ source: { nodeId, sessionId: "thread-source" } });
    await instance.close();
  });

  it("marks node-managed background task sessions with their reported kind", async () => {
    const { nodeId, credential } = await source();
    await registry().replaceSessions(nodeId, [{ sessionId: "thread-source", runtime: "codex", state: "running", kind: "codex" },
      { sessionId: "task-thread", runtime: "codex", state: "idle", kind: "codex-task" },
      { sessionId: "intercom-thread", runtime: "codex", state: "running", kind: "codex-intercom" },
      { sessionId: "legacy-thread", runtime: "codex", state: "running" }]);
    const requestId = "20000000-0000-4000-8000-000000000012";
    const args = { limit: 100 };
    await registry().registerMcpIntent(nodeId, { requestId, runtime: "codex", sessionId: "thread-source",
      threadId: "thread-source", callId: "call-kind", tool: "sessions", argumentsDigest: await digestMcpArguments(args) });
    const instance = await client(credential.token);
    const result = await instance.callTool({ name: "sessions", arguments: { requestId, ...args },
      _meta: { sessionId: "thread-source", threadId: "thread-source", callId: "call-kind" } });
    const own = (result.structuredContent as { sessions: Record<string, unknown>[] }).sessions
      .filter((session) => session.nodeId === nodeId);
    expect(own).toEqual(expect.arrayContaining([
      { nodeId, sessionId: "thread-source", runtime: "codex", state: "running", kind: "codex" },
      { nodeId, sessionId: "task-thread", runtime: "codex", state: "idle", kind: "codex-task" },
      { nodeId, sessionId: "intercom-thread", runtime: "codex", state: "running", kind: "codex-intercom" },
      { nodeId, sessionId: "legacy-thread", runtime: "codex", state: "running" },
    ]));
    await instance.close();
  });

  it("distinguishes an online empty inbox from offline and transits bodies only in the RPC", async () => {
    const online = await source();
    const socket = await authenticate(online.nodeId, online.key);
    const requestId = "20000000-0000-4000-8000-000000000002";
    await registry().registerMcpIntent(online.nodeId, { requestId, runtime: "codex", sessionId: "thread-source",
      callId: "call-inbox", tool: "inbox", argumentsDigest: await digestMcpArguments({ limit: 2 }) });
    const instance = await client(online.credential.token);
    const pending = instance.callTool({ name: "inbox", arguments: { requestId, limit: 2 },
      _meta: { sessionId: "thread-source", threadId: "native-thread", callId: "call-inbox" } });
    const read = await socket.next();
    expect(read.type).toBe("mcp.inbox.request");
    socket.send(makeEnvelope("mcp.inbox.response", { requestId: (read.body as { requestId: string }).requestId,
      ok: true, items: [] }, 1, 0));
    const empty = await pending;
    expect(empty.isError).not.toBe(true);
    expect(empty.structuredContent).toMatchObject({ ok: true, items: [] });

    const sentinel = "SENTINEL_PRIVATE_RPC_DETAIL";
    const rejectedId = "20000000-0000-4000-8000-000000000008";
    await registry().registerMcpIntent(online.nodeId, { requestId: rejectedId, runtime: "codex", sessionId: "thread-source",
      callId: "call-inbox-error", tool: "inbox", argumentsDigest: await digestMcpArguments({}) });
    const rejectedCall = instance.callTool({ name: "inbox", arguments: { requestId: rejectedId },
      _meta: { sessionId: "thread-source", threadId: "native-thread", callId: "call-inbox-error" } });
    const rejectedRead = await socket.next();
    socket.send(makeEnvelope("mcp.inbox.response", { requestId: (rejectedRead.body as { requestId: string }).requestId,
      ok: false, error: sentinel }, 2, 0));
    const rejected = await rejectedCall;
    expect(rejected.content).toEqual([{ type: "text", text: "originating node inbox read failed" }]);
    expect(JSON.stringify(await session(online.nodeId).recentCommands())).not.toContain(sentinel);
    const metadata = await runInDurableObject(registry(), (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", rejectedId).one());
    expect(JSON.stringify(metadata)).not.toContain(sentinel);
    await instance.close();

    const offline = await source();
    const offlineId = "20000000-0000-4000-8000-000000000003";
    await registry().registerMcpIntent(offline.nodeId, { requestId: offlineId, runtime: "codex", sessionId: "thread-source",
      callId: "call-offline", tool: "inbox", argumentsDigest: await digestMcpArguments({}) });
    const offlineClient = await client(offline.credential.token);
    const unavailable = await offlineClient.callTool({ name: "inbox", arguments: { requestId: offlineId },
      _meta: { sessionId: "thread-source", threadId: "native-thread", callId: "call-offline" } });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.content).toEqual([{ type: "text", text: "originating node is offline" }]);
    await offlineClient.close();
  });

  it("denies missing metadata, missing intents and altered arguments with fixed errors", async () => {
    const { nodeId, credential } = await source();
    const instance = await client(credential.token);
    const malformedSentinel = "SENTINEL_SECRET_INVALID_ARGUMENT";
    const malformed = await instance.callTool({ name: "sessions", arguments: {
      requestId: "20000000-0000-4000-8000-000000000099", limit: malformedSentinel,
    } as never });
    expect(JSON.stringify(malformed)).not.toContain(malformedSentinel);
    const missingId = "20000000-0000-4000-8000-000000000004";
    const missing = await instance.callTool({ name: "sessions", arguments: { requestId: missingId, limit: 3 },
      _meta: { sessionId: "thread-source", threadId: "native-thread", callId: "call-missing" } });
    expect(missing.content).toEqual([{ type: "text", text: "intent not found" }]);

    const id = "20000000-0000-4000-8000-000000000005";
    await registry().registerMcpIntent(nodeId, { requestId: id, runtime: "codex", sessionId: "thread-source",
      callId: "call-altered", tool: "sessions", argumentsDigest: await digestMcpArguments({ limit: 3 }) });
    const altered = await instance.callTool({ name: "sessions", arguments: { requestId: id, limit: 4 },
      _meta: { sessionId: "thread-source", threadId: "native-thread", callId: "call-altered" } });
    expect(altered.content).toEqual([{ type: "text", text: "tool arguments do not match intent" }]);

    const noMetaId = "20000000-0000-4000-8000-000000000006";
    await registry().registerMcpIntent(nodeId, { requestId: noMetaId, runtime: "codex", sessionId: "thread-source",
      callId: "call-no-meta", tool: "sessions", argumentsDigest: await digestMcpArguments({}) });
    const noMeta = await instance.callTool({ name: "sessions", arguments: { requestId: noMetaId },
      _meta: { "claudecode/toolUseId": "unverified" } });
    expect(noMeta.content).toEqual([{ type: "text", text: "remote MCP runtime is not enabled for this node" }]);
    await instance.close();
  });

  it("resolves an oversized production node response to an actionable MCP error", async () => {
    const online = await source();
    const socket = await authenticate(online.nodeId, online.key);
    const requestId = "20000000-0000-4000-8000-000000000011";
    await registry().registerMcpIntent(online.nodeId, { requestId, runtime: "codex", sessionId: "thread-source",
      callId: "call-oversize", tool: "inbox", argumentsDigest: await digestMcpArguments({}) });
    const instance = await client(online.credential.token);
    try {
      const node = new NodeClient({
        nodeId: online.nodeId, identity: generateIdentity(), policy: { ...DEFAULT_POLICY, remoteMcp: { enabled: true } },
        handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
        facts: () => FACTS, runtimes: async () => [{ name: "codex", kind: "cli" }],
        sessions: async () => [{ sessionId: "thread-source", runtime: "codex", state: "running" }],
        storeMessage: () => {}, mcpCredentialPresent: () => true,
        readMcpInbox: (sessionId, limit) => {
          expect(sessionId).toBe("thread-source");
          expect(limit).toBe(10);
          return Array.from({ length: 4 }, (_, index) => ({
            messageId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            from: { nodeId: online.nodeId, session: "peer" }, createdAt: "2026-09-30T00:00:00.000Z",
            text: "SYNTHETIC_LOCAL_ONLY_BODY".padEnd(16384, "A"), depth: 0,
          }));
        },
      });
      await node.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
      const pending = instance.callTool({ name: "inbox", arguments: { requestId },
        _meta: { sessionId: "thread-source", threadId: "native-thread", callId: "call-oversize" } });
      const read = await socket.next();
      expect(read.type).toBe("mcp.inbox.request");
      const [response] = await node.onFrame(JSON.stringify(read));
      expect(response).toBeTypeOf("string");
      socket.ws.send(response!);
      const result = await pending;
      const error = "inbox response exceeds transport limit; retry with a smaller limit or use the local inbox CLI";
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: error }]);
      expect(result.structuredContent).toEqual({ ok: false, error });
      expect(JSON.stringify(await session(online.nodeId).recentCommands())).not.toContain("SYNTHETIC_LOCAL_ONLY_BODY");
      const row = await runInDurableObject(registry(), (_instance, state) =>
        state.storage.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", requestId).one());
      expect(JSON.stringify(row)).not.toContain("SYNTHETIC_LOCAL_ONLY_BODY");
    } finally {
      await instance.close();
      socket.ws.close();
    }
  }, 10000);

  it("retries a write with the immutable requestId through router idempotency", async () => {
    const sourceNode = await source();
    const targetNode = await target();
    const id = "20000000-0000-4000-8000-000000000007";
    const args = { to: { nodeId: targetNode, session: "target-session" }, text: "synthetic-write" };
    await registry().registerMcpIntent(sourceNode.nodeId, { requestId: id, runtime: "codex", sessionId: "thread-source",
      callId: "call-send", tool: "send", argumentsDigest: await digestMcpArguments(args) });
    const instance = await client(sourceNode.credential.token);
    const call = () => instance.callTool({ name: "send", arguments: { requestId: id, ...args },
      _meta: { sessionId: "thread-source", threadId: "native-thread", callId: "call-send" } });
    expect((await call()).structuredContent).toMatchObject({ ok: true, messageId: id, state: "queued" });
    expect((await call()).structuredContent).toMatchObject({ ok: true, messageId: id, state: "queued" });
    expect((await registry().listMessages(sourceNode.nodeId, 10)).filter((message) => message.messageId === id)).toHaveLength(1);
    await instance.close();
  });

  it("does not expose arbitrary persisted message status reasons", async () => {
    const sourceNode = await source();
    const targetNode = await target();
    const messageId = "20000000-0000-4000-8000-000000000009";
    const sent = await registry().sendMessage({ messageId, from: { nodeId: sourceNode.nodeId, session: "thread-source" },
      to: { nodeId: targetNode, session: "target-session" }, text: "synthetic" }, "test");
    expect(sent.ok).toBe(true);
    const sentinel = "SENTINEL_PRIVATE_STATUS_DETAIL";
    await registry().reportMessageStatus(targetNode, { messageId, state: "refused", reason: sentinel });
    const requestId = "20000000-0000-4000-8000-000000000010";
    await registry().registerMcpIntent(sourceNode.nodeId, { requestId, runtime: "codex", sessionId: "thread-source",
      callId: "call-status", tool: "status", argumentsDigest: await digestMcpArguments({ messageId }) });
    const instance = await client(sourceNode.credential.token);
    const status = await instance.callTool({ name: "status", arguments: { requestId, messageId },
      _meta: { sessionId: "thread-source", threadId: "native-thread", callId: "call-status" } });
    expect(JSON.stringify(status)).not.toContain(sentinel);
    expect(status.structuredContent).toMatchObject({ ok: true, messageId, state: "refused" });
    await instance.close();
  });
});
