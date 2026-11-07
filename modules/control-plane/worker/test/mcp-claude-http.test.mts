import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY, digestMcpArguments } from "../../protocol-mcp.mts";
import { makeEnvelope } from "../../protocol.mts";
import { handleMcp } from "../src/mcp-http.mts";
import type { Env } from "../src/env.mts";
import { BASE, FACTS, authenticate, newKey, registry } from "./helpers.mts";

const SESSION_A = "claude-http-a";
const SESSION_B = "claude-http-b";
const CALL = "claude-http-call";
const enabledEnv = { ...env, REMOTE_MCP_ENABLED: "true" } as Env;

async function source() {
  const key = await newKey();
  const { code } = await registry().createEnrollment("test");
  const result = await registry().redeemEnrollment({ code, publicKey: key.publicKey, name: "claude-http", facts: FACTS,
    runtimes: [{ name: "claude-code", kind: "cli" }] });
  if (!result.ok) throw new Error(result.reason);
  await registry().updateRegistration(result.nodeId, FACTS, [{ name: "claude-code", kind: "cli" }],
    [REMOTE_MCP_CAPABILITY, CLAUDE_MCP_CAPABILITY]);
  await registry().replaceSessions(result.nodeId, [
    { sessionId: SESSION_A, runtime: "claude-code", state: "running" },
    { sessionId: SESSION_B, runtime: "claude-code", state: "running" },
  ]);
  const credential = await registry().rotateMcpCredential(result.nodeId);
  if (!credential.ok) throw new Error(credential.error);
  return { nodeId: result.nodeId, credential, key };
}

async function client(token: string) {
  const instance = new Client({ name: "synthetic-claude", version: "1.0.0" });
  await instance.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), {
    authProvider: { token: async () => token },
    fetch: (input, init) => handleMcp(new Request(input, init), enabledEnv),
  }));
  return instance;
}

describe("Claude native MCP HTTP join", () => {
  it("rejects Claude self-assignment without changing any slot or revision", async () => {
    const sourceNode = await source(), instance = await client(sourceNode.credential.token);
    try {
      const before = await registry().listIntercomSlots();
      const result = await instance.callTool({ name: "assign_self", arguments: { requestId: crypto.randomUUID(), slot: "kherep-lead" },
        _meta: { "claudecode/toolUseId": "synthetic-claude-call" } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "self-assignment requires the original Codex Mac native thread" }]);
      expect(await registry().listIntercomSlots()).toEqual(before);
    } finally { await instance.close(); }
  });

  it("tells callers that the native hook supplies every required requestId", async () => {
    const sourceNode = await source();
    const instance = await client(sourceNode.credential.token);
    try {
      const tools = await instance.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual(["assign_self", "inbox", "reply", "send", "sessions", "status"]);
      for (const tool of tools.tools) {
        expect(tool.description).toContain("The native hook supplies requestId; omit it from tool arguments.");
      }
    } finally {
      await instance.close();
    }
  });

  it("joins the actual Claude tool-use ID to the retained source session without caller session metadata", async () => {
    const sourceNode = await source();
    const requestId = "72000000-0000-4000-8000-000000000001";
    const args = { limit: 5 };
    expect((await registry().registerMcpIntent(sourceNode.nodeId, { requestId, runtime: "claude-code",
      sessionId: SESSION_A, callId: CALL, tool: "sessions", argumentsDigest: await digestMcpArguments(args) })).ok).toBe(true);
    const instance = await client(sourceNode.credential.token);
    try {
      const result = await instance.callTool({ name: "sessions", arguments: { requestId, ...args },
        _meta: { "claudecode/toolUseId": CALL } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ source: { nodeId: sourceNode.nodeId, sessionId: SESSION_A } });
    } finally {
      await instance.close();
    }
  });

  it("rejects missing, mixed, partial, invalid and mismatched Claude metadata without consuming the intent", async () => {
    const sourceNode = await source();
    const requestId = "72000000-0000-4000-8000-000000000002";
    const args = { limit: 3 };
    await registry().registerMcpIntent(sourceNode.nodeId, { requestId, runtime: "claude-code",
      sessionId: SESSION_A, callId: CALL, tool: "sessions", argumentsDigest: await digestMcpArguments(args) });
    const instance = await client(sourceNode.credential.token);
    try {
      const call = (meta?: Record<string, unknown>, limit = 3) => instance.callTool({
        name: "sessions", arguments: { requestId, limit }, ...(meta ? { _meta: meta } : {}),
      });
      for (const meta of [
        undefined,
        { "claudecode/toolUseId": CALL, sessionId: SESSION_A },
        { "claudecode/toolUseId": CALL, threadId: "partial" },
        { "claudecode/toolUseId": CALL, callId: CALL },
        { "claudecode/toolUseId": "" },
        { "claudecode/toolUseId": "x".repeat(129) },
      ]) {
        const result = await call(meta);
        expect(result.content).toEqual([{ type: "text", text: "verified native call metadata is required" }]);
      }
      expect((await call({ "claudecode/toolUseId": "another-call" })).content)
        .toEqual([{ type: "text", text: "native call identity does not match intent" }]);
      expect((await call({ "claudecode/toolUseId": CALL }, 4)).content)
        .toEqual([{ type: "text", text: "tool arguments do not match intent" }]);
      const retained = await runInDurableObject(registry(), (_instance, state) =>
        state.storage.sql.exec("SELECT claimed_at FROM mcp_intents WHERE request_id = ?", requestId).one());
      expect(retained).toEqual({ claimed_at: null });
      expect((await call({ "claudecode/toolUseId": CALL })).isError).not.toBe(true);
    } finally {
      await instance.close();
    }
  });

  it("routes a Claude inbox read to the retained session and carries the verified runtime", async () => {
    const sourceNode = await source();
    const socket = await authenticate(sourceNode.nodeId, sourceNode.key);
    const requestId = "72000000-0000-4000-8000-000000000003";
    await registry().registerMcpIntent(sourceNode.nodeId, { requestId, runtime: "claude-code",
      sessionId: SESSION_B, callId: CALL, tool: "inbox", argumentsDigest: await digestMcpArguments({ limit: 2 }) });
    const instance = await client(sourceNode.credential.token);
    try {
      const pending = instance.callTool({ name: "inbox", arguments: { requestId, limit: 2 },
        _meta: { "claudecode/toolUseId": CALL } });
      const read = await socket.next();
      expect(read.type).toBe("mcp.inbox.request");
      expect(read.body).toMatchObject({ sessionId: SESSION_B, runtime: "claude-code", limit: 2 });
      socket.send(makeEnvelope("mcp.inbox.response", {
        requestId: (read.body as { requestId: string }).requestId, ok: true, items: [],
      }, 1, 0));
      const response = await pending;
      expect(response.structuredContent).toMatchObject({ ok: true, source: {
        nodeId: sourceNode.nodeId, sessionId: SESSION_B,
      }, items: [] });
    } finally {
      await instance.close();
      socket.ws.close();
    }
  });
});
