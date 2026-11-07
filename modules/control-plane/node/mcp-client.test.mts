import { MESSAGING_DIAGNOSTICS_CAPABILITY, MESSAGING_DIAGNOSTICS_V2_CAPABILITY } from "../protocol-diagnostics.mts";
import { MESSAGING_LOOP_BRAKE_CAPABILITY } from "../protocol-loop-brake.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope } from "../protocol.mts";
import { CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY, type McpIntentRegistration } from "../protocol-mcp.mts";
import { MESSAGING_ACK_CAPABILITY, MESSAGING_PROGRESS_V2_CAPABILITY } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { generateIdentity } from "./identity.mts";
import { advertisedCapabilities, DEFAULT_POLICY, loadPolicy, mcpRuntimeEnabled, type NodePolicy } from "./policy.mts";

const NODE = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "30000000-0000-4000-8000-000000000001";
const policy: NodePolicy = { ...DEFAULT_POLICY, remoteMcp: { enabled: true } };

const decode = (frames: string[]): Envelope[] => frames.map((frame) => {
  const parsed = parseEnvelope(frame);
  assert.ok(parsed.ok);
  return parsed.envelope;
});

function setup(hasCredential = false, activePolicy: NodePolicy = policy) {
  const credentials: unknown[] = [];
  const receipts: unknown[] = [];
  let disabled = 0;
  const client = new NodeClient({
    nodeId: NODE, identity: generateIdentity(), policy: activePolicy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [{ name: "codex", kind: "cli" }],
    sessions: async () => [{ sessionId: "session-a", runtime: "codex", state: "running" }],
    storeMessage: () => {}, mcpCredentialPresent: () => hasCredential,
    mcpCredential: (body) => { credentials.push(body); hasCredential = true; }, mcpIntentReceipt: (body) => receipts.push(body),
    mcpDisabled: () => { disabled += 1; hasCredential = false; },
    readMcpInbox: (sessionId, limit) => sessionId === "session-a" ? [{
      messageId: "30000000-0000-4000-8000-000000000099", from: { nodeId: NODE, session: "peer" },
      createdAt: "2026-09-30T00:00:00.000Z", text: "synthetic", depth: 0,
    }].slice(0, limit) : [],
  });
  return { client, credentials, receipts, disabled: () => disabled };
}

test("Claude MCP policy requires a literal nested opt-in and advertises its separate capability", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-claude-mcp-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "policy.json");
  const read = (remoteMcp: unknown) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp }));
    return loadPolicy(file);
  };

  for (const remoteMcp of [{ enabled: true }, { enabled: true, claudeCode: false }, { enabled: true, claudeCode: "true" }]) {
    const parsed = read(remoteMcp);
    assert.equal(mcpRuntimeEnabled(parsed, "codex"), true);
    assert.equal(mcpRuntimeEnabled(parsed, "claude-code"), false);
    assert.equal(advertisedCapabilities(parsed).includes(CLAUDE_MCP_CAPABILITY), false);
  }
  const enabled = read({ enabled: true, claudeCode: true });
  assert.equal(mcpRuntimeEnabled(enabled, "claude-code"), true);
  assert.equal(mcpRuntimeEnabled(enabled, "unknown"), false);
  assert.deepEqual(advertisedCapabilities(enabled), [MESSAGING_ACK_CAPABILITY, MESSAGING_PROGRESS_V2_CAPABILITY, MESSAGING_LOOP_BRAKE_CAPABILITY, MESSAGING_DIAGNOSTICS_CAPABILITY, MESSAGING_DIAGNOSTICS_V2_CAPABILITY, REMOTE_MCP_CAPABILITY,
    CLAUDE_MCP_CAPABILITY]);
});

function rotationId(frames: Envelope[]): string {
  const body = frames.find((frame) => frame.type === "mcp.credential.rotate")?.body as { requestId?: unknown } | undefined;
  const requestId = body?.requestId;
  assert.ok(typeof requestId === "string");
  return requestId;
}

test("remote MCP capability and credential provisioning are explicit opt-ins", async () => {
  assert.equal(advertisedCapabilities(DEFAULT_POLICY).includes(REMOTE_MCP_CAPABILITY), false);
  assert.equal(advertisedCapabilities(policy).includes(REMOTE_MCP_CAPABILITY), true);
  const fresh = setup(false);
  const frames = decode(await fresh.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))));
  assert.deepEqual(frames.map((frame) => frame.type), ["register", "mcp.credential.rotate", "sessions.snapshot", "directory.get"]);
  const existing = setup(true);
  assert.deepEqual(decode(await existing.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))))
    .map((frame) => frame.type), ["register", "sessions.snapshot", "directory.get"]);
});

test("credential and intent receipts stay in typed callbacks", async () => {
  const ctx = setup();
  const frames = decode(await ctx.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))));
  ctx.client.registrationSent();
  const credential = { requestId: rotationId(frames), ok: true, token: "x".repeat(43), version: 1 };
  assert.deepEqual(await ctx.client.onFrame(JSON.stringify(makeEnvelope("mcp.credential", credential, 0, 0))), []);
  assert.deepEqual(ctx.credentials, [credential]);
  const receipt = { requestId: REQUEST, ok: true, expiresAt: Date.now() + 120_000, version: 1 };
  assert.deepEqual(await ctx.client.onFrame(JSON.stringify(makeEnvelope("mcp.intent.receipt", receipt, 0, 0))), []);
  assert.deepEqual(ctx.receipts, [receipt]);
});

test("registered intents and inbox bodies use ephemeral typed frames", async () => {
  const { client } = setup(true);
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const intent: McpIntentRegistration = { requestId: REQUEST, runtime: "codex", sessionId: "session-a", callId: "call-a",
    tool: "inbox", argumentsDigest: "a".repeat(64) };
  assert.equal(decode(client.registerMcpIntent(intent))[0]?.type, "mcp.intent.register");
  const response = decode(await client.onFrame(JSON.stringify(makeEnvelope("mcp.inbox.request",
    { requestId: REQUEST, sessionId: "session-a", limit: 10 }, 0, 0))));
  assert.equal(response[0]?.type, "mcp.inbox.response");
  assert.deepEqual(response[0]?.body, { requestId: REQUEST, ok: true, items: [{
    messageId: "30000000-0000-4000-8000-000000000099", from: { nodeId: NODE, session: "peer" },
    createdAt: "2026-09-30T00:00:00.000Z", text: "synthetic", depth: 0,
  }] });
});

test("a connected node retracts remote MCP immediately when current policy removes the opt-in", async () => {
  const ctx = setup(true);
  await ctx.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));

  const refreshed = decode(await ctx.client.refreshPolicy(DEFAULT_POLICY));
  assert.deepEqual(refreshed.map((frame) => frame.type), ["register"]);
  assert.equal((refreshed[0]?.body as { capabilities: string[] }).capabilities.includes(REMOTE_MCP_CAPABILITY), false);
  assert.equal(ctx.disabled(), 1);
  assert.deepEqual(await ctx.client.refreshPolicy(DEFAULT_POLICY), refreshed.map((frame) => JSON.stringify(frame)));
  ctx.client.registrationSent();
  assert.deepEqual(await ctx.client.refreshPolicy(DEFAULT_POLICY), []);

  const intent: McpIntentRegistration = { requestId: REQUEST, runtime: "codex", sessionId: "session-a", callId: "call-a",
    tool: "inbox", argumentsDigest: "a".repeat(64) };
  assert.deepEqual(ctx.client.registerMcpIntent(intent), []);
  assert.deepEqual(await ctx.client.onFrame(JSON.stringify(makeEnvelope("mcp.inbox.request",
    { requestId: REQUEST, sessionId: "session-a", limit: 10 }, 0, 0))), []);

  const credential = { requestId: REQUEST, ok: true, token: "y".repeat(43), version: 2 };
  assert.deepEqual(await ctx.client.onFrame(JSON.stringify(makeEnvelope("mcp.credential", credential, 0, 0))), []);
  assert.deepEqual(ctx.credentials, []);

  const enabledAgain = decode(await ctx.client.refreshPolicy(policy));
  assert.deepEqual(enabledAgain.map((frame) => frame.type), ["register", "mcp.credential.rotate"]);
});

test("a connected node cannot register a Claude intent after only the Claude opt-in is retracted", async () => {
  const claudePolicy: NodePolicy = { ...policy, remoteMcp: { enabled: true, claudeCode: true } };
  const ctx = setup(true, claudePolicy);
  await ctx.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const intent: McpIntentRegistration = { requestId: REQUEST, runtime: "claude-code", sessionId: "session-a", callId: "call-a",
    tool: "inbox", argumentsDigest: "a".repeat(64) };
  assert.equal(decode(ctx.client.registerMcpIntent(intent))[0]?.type, "mcp.intent.register");
  assert.deepEqual(ctx.client.registerMcpIntent({ ...intent, threadId: "invented-thread" } as unknown as McpIntentRegistration), []);

  const refreshed = decode(await ctx.client.refreshPolicy(policy));
  assert.equal((refreshed[0]?.body as { capabilities: string[] }).capabilities.includes(CLAUDE_MCP_CAPABILITY), false);
  assert.deepEqual(ctx.client.registerMcpIntent(intent), []);
  assert.equal(decode(ctx.client.registerMcpIntent({ ...intent, runtime: "codex" }))[0]?.type, "mcp.intent.register");
});

test("failed credential provisioning remains bounded and retryable while enabled", async () => {
  const ctx = setup(false);
  const initial = decode(await ctx.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))));
  assert.deepEqual(initial.map((frame) => frame.type), ["register", "mcp.credential.rotate", "sessions.snapshot", "directory.get"]);
  ctx.client.registrationSent();

  const failed = { requestId: rotationId(initial), ok: false as const, error: "synthetic failure" };
  await ctx.client.onFrame(JSON.stringify(makeEnvelope("mcp.credential", failed, 0, 0)));
  const retry = await ctx.client.refreshPolicy(policy);
  assert.deepEqual(decode(retry).map((frame) => frame.type), ["register", "mcp.credential.rotate"]);
  assert.deepEqual(await ctx.client.refreshPolicy(policy), retry);
});

test("policy refresh before reconnect authentication never republishes a removed MCP capability", async () => {
  const ctx = setup(true);
  assert.deepEqual(await ctx.client.refreshPolicy(DEFAULT_POLICY), []);
  const frames = decode(await ctx.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))));
  assert.deepEqual(frames.map((frame) => frame.type), ["register", "sessions.snapshot", "directory.get"]);
  assert.equal((frames[0]?.body as { capabilities: string[] }).capabilities.includes(REMOTE_MCP_CAPABILITY), false);
});

test("delayed credential responses cannot overwrite the fresh credential after re-enabling", async () => {
  const ctx = setup();
  const first = rotationId(decode(await ctx.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)))));
  ctx.client.registrationSent();
  await ctx.client.refreshPolicy(DEFAULT_POLICY);
  ctx.client.registrationSent();
  const second = rotationId(decode(await ctx.client.refreshPolicy(policy)));
  ctx.client.registrationSent();
  assert.notEqual(second, first);
  const fresh = { requestId: second, ok: true, token: "b".repeat(43), version: 1 };
  await ctx.client.onFrame(JSON.stringify(makeEnvelope("mcp.credential", fresh, 0, 0)));
  await ctx.client.onFrame(JSON.stringify(makeEnvelope("mcp.credential",
    { requestId: first, ok: true, token: "a".repeat(43), version: 1 }, 0, 0)));
  await ctx.client.onFrame(JSON.stringify(makeEnvelope("mcp.credential",
    { requestId: first, ok: false, error: "synthetic delayed failure" }, 0, 0)));
  assert.deepEqual(ctx.credentials, [fresh]);
  assert.deepEqual(await ctx.client.refreshPolicy(policy), []);
});

test("an unsent credential rotation survives another capability change", async () => {
  const { client } = setup();
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const frames = decode(await client.refreshPolicy({ ...policy, allowedCommands: ["runtime.list"] }));
  assert.deepEqual(frames.map((frame) => frame.type), ["register", "mcp.credential.rotate"]);
});
