import { describe, expect, it, vi } from "vitest";

import { makeEnvelope } from "../../protocol.mts";
import { SELECTED_BINDING_CAPABILITY, type ResolveRequest } from "../../protocol-message-binding.mts";
import { digestMcpArguments, MCP_LEAD_CONFIRM_MS, type McpLeadConfirmRequest } from "../../protocol-mcp.mts";
import { MCP_INBOX_MAX_PENDING, MCP_INBOX_TIMEOUT_MS } from "../src/node-session.mts";
import { authenticate, connect, enroll, FACTS, newKey, session, until, type TestSocket } from "./helpers.mts";

// Issue #965: the requests NodeSession sends to its node and awaits: native
// Lead confirmation, MCP inbox reads and reference resolution. Each refusal
// resolves without a frame; each accepted request is answered over the socket.
interface Node { nodeId: string; socket: TestSocket; seq: () => number }

async function node(register = true): Promise<Node> {
  const key = await newKey();
  const nodeId = await enroll(key);
  const socket = await authenticate(nodeId, key);
  let seq = 0;
  if (register) {
    socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }],
      capabilities: [SELECTED_BINDING_CAPABILITY] }, ++seq, 0));
    await vi.waitFor(async () => expect((await session(nodeId).loopCapabilityEvidence()).registered).toBe(true));
  }
  return { nodeId, socket, seq: () => ++seq };
}

async function leadRequest(nodeId: string, expiresIn = MCP_LEAD_CONFIRM_MS - 500): Promise<McpLeadConfirmRequest> {
  const sessionId = crypto.randomUUID();
  return { nonce: crypto.randomUUID(), nodeId, requestId: crypto.randomUUID(), sessionId, threadId: sessionId,
    turnId: "turn-1", callId: "call-1", slot: "kherep-lead", argumentsDigest: await digestMcpArguments({ slot: "kherep-lead" }),
    credentialVersion: 1, leadGuardVersion: 1, expiresAt: Date.now() + expiresIn };
}

describe("NodeSession native Lead confirmation", () => {
  it("resolves the node's answer to a confirmation request", async () => {
    const { nodeId, socket, seq } = await node();
    for (const allowed of [true, false]) {
      const request = await leadRequest(nodeId);
      const pending = session(nodeId).requestLeadConfirmation(request);
      await until(socket, "mcp.lead.confirm.request", { nonce: request.nonce });
      socket.send(makeEnvelope("mcp.lead.confirm.response", { nonce: request.nonce, allowed }, seq(), 0));
      expect(await pending).toBe(allowed);
    }
    socket.ws.close(1000, "done");
  });

  it("refuses requests that are malformed, foreign, expired or too far out", async () => {
    const { nodeId, socket } = await node();
    const base = await leadRequest(nodeId);
    const refused = [
      { ...base, slot: "codex-mac" },
      { ...base, nodeId: crypto.randomUUID() },
      { ...base, expiresAt: Date.now() - 1 },
      { ...base, expiresAt: Date.now() + MCP_LEAD_CONFIRM_MS + 60_000 },
    ] as McpLeadConfirmRequest[];
    for (const request of refused) expect(await session(nodeId).requestLeadConfirmation(request)).toBe(false);
    socket.ws.close(1000, "done");
  });

  it("refuses without a registered connection", async () => {
    const unregistered = await node(false);
    expect(await session(unregistered.nodeId).requestLeadConfirmation(await leadRequest(unregistered.nodeId))).toBe(false);
    unregistered.socket.ws.close(1000, "done");
    await unregistered.socket.closed;
    expect(await session(unregistered.nodeId).requestLeadConfirmation(await leadRequest(unregistered.nodeId))).toBe(false);
  });

  it("refuses a duplicate nonce while the first request is pending", async () => {
    const { nodeId, socket, seq } = await node();
    const request = await leadRequest(nodeId);
    const first = session(nodeId).requestLeadConfirmation(request);
    await until(socket, "mcp.lead.confirm.request", { nonce: request.nonce });
    expect(await session(nodeId).requestLeadConfirmation(request)).toBe(false);
    socket.send(makeEnvelope("mcp.lead.confirm.response", { nonce: request.nonce, allowed: true }, seq(), 0));
    expect(await first).toBe(true);
    socket.ws.close(1000, "done");
  });

  it("fails closed when the request expires unanswered", async () => {
    const { nodeId, socket } = await node();
    const request = await leadRequest(nodeId, 200);
    const pending = session(nodeId).requestLeadConfirmation(request);
    await until(socket, "mcp.lead.confirm.request", { nonce: request.nonce });
    expect(await pending).toBe(false);
    socket.ws.close(1000, "done");
  });

  it("fails closed when the socket closes while the request is pending", async () => {
    const { nodeId, socket } = await node();
    const request = await leadRequest(nodeId);
    const pending = session(nodeId).requestLeadConfirmation(request);
    await until(socket, "mcp.lead.confirm.request", { nonce: request.nonce });
    socket.ws.close(1000, "gone");
    expect(await pending).toBe(false);
  });

  it("keeps a pending request when another, unauthenticated socket closes", async () => {
    const { nodeId, socket, seq } = await node();
    const request = await leadRequest(nodeId);
    const pending = session(nodeId).requestLeadConfirmation(request);
    await until(socket, "mcp.lead.confirm.request", { nonce: request.nonce });
    const other = await connect(nodeId);
    other.socket.ws.close(1000, "abandoned handshake");
    await other.socket.closed; // the server completes the close only after webSocketClose ran
    socket.send(makeEnvelope("mcp.lead.confirm.response", { nonce: request.nonce, allowed: true }, seq(), 0));
    expect(await pending).toBe(true);
    socket.ws.close(1000, "done");
  });
});

describe("NodeSession MCP inbox reads", () => {
  it("refuses a read beyond the pending bound and answers the pending ones", async () => {
    const { nodeId, socket, seq } = await node(false);
    const sessionId = crypto.randomUUID();
    const reads = Array.from({ length: MCP_INBOX_MAX_PENDING }, () => session(nodeId).requestMcpInbox(sessionId, 5, "codex"));
    const ids: string[] = [];
    while (ids.length < MCP_INBOX_MAX_PENDING) {
      const frame = await socket.next();
      if (frame.type === "mcp.inbox.request") ids.push((frame.body as { requestId: string }).requestId);
    }
    expect(await session(nodeId).requestMcpInbox(sessionId, 5, "codex"))
      .toMatchObject({ ok: false, error: "originating node inbox reader is busy" });
    for (const requestId of ids) socket.send(makeEnvelope("mcp.inbox.response", { requestId, ok: false, error: "synthetic" }, seq(), 0));
    for (const read of reads) expect(await read).toMatchObject({ ok: false, error: "originating node inbox read failed" });
    socket.ws.close(1000, "done");
  });

  it("fails a read the node never answers after the inbox timeout", async () => {
    const { nodeId, socket } = await node(false);
    const started = Date.now();
    const read = session(nodeId).requestMcpInbox(crypto.randomUUID(), 5, "codex");
    await until(socket, "mcp.inbox.request", {});
    expect(await read).toMatchObject({ ok: false, error: "originating node did not answer inbox request" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(MCP_INBOX_TIMEOUT_MS - 50);
    socket.ws.close(1000, "done");
  });
});

describe("NodeSession reference resolution", () => {
  it("reports an invalid resolve request as resolution-unavailable", async () => {
    const { nodeId, socket } = await node();
    expect(await session(nodeId).resolveMessageReferencesDetailed({ version: 2 } as unknown as ResolveRequest))
      .toEqual({ answer: null, code: "resolution-unavailable" });
    socket.ws.close(1000, "done");
  });
});
