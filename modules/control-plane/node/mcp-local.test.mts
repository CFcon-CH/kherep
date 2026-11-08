import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { digestMcpArguments } from "../protocol-mcp.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { fakePowerShell } from "./mcp-credential-fixture.mts";
import { processMcpIntentHook } from "./mcp-intent-hook.mts";
import {
  disableMcp, enqueueMcpIntent, hasMcpCredential, readMcpInbox, recordMcpCredential, recordMcpIntentReceipt,
} from "./mcp-local.mts";

const NODE = "00000000-0000-4000-8000-0000000000aa";
const MESSAGE = "40000000-0000-4000-8000-000000000001";
// The Windows helper has its own tests; these start no powershell.exe (issue #219).
const CREDENTIAL = { spawn: fakePowerShell().spawn };

test("assignment hook binds only slot plus native session/turn/call and rejects supplied identity", async t => {
  const { root, paths } = temporary(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  const sessionId = "11111111-1111-4111-8111-111111111111", turnId = "22222222-2222-4222-8222-222222222222";
  const input = { hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__assign_self",
    session_id: sessionId, tool_use_id: "native-call", turn_id: turnId, prompt: "SYNTHETIC PROMPT MUST NOT PERSIST",
    tool_input: { slot: "codex-mac" } };
  for (const denied of [{ ...input, turn_id: undefined }, { ...input, session_id: "short" },
    { ...input, tool_input: { slot: "codex-windows" } }, { ...input, tool_input: { slot: "codex-mac", chatName: "forged" } },
    { ...input, tool_input: { slot: "kherep-lead", approved: true } },
    { ...input, tool_input: { slot: "kherep-lead", leadGuardVersion: 1 } },
    { ...input, tool_input: { slot: "kherep-lead", transcriptPath: "/synthetic/transcript.jsonl" } }]) {
    const output = await processMcpIntentHook(denied, root);
    assert.equal(output?.hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal((await processMcpIntentHook(input, root, Date.now(), "claude-code"))?.hookSpecificOutput.permissionDecision, "deny");
  const pending = processMcpIntentHook(input, root);
  const requestId = await queuedRequestId(paths);
  const text = fs.readFileSync(path.join(paths.mcpIntents, `${requestId}.json`), "utf8"), queued = JSON.parse(text);
  assert.equal(queued.sessionId, sessionId);assert.equal(queued.threadId, sessionId);assert.equal(queued.callId, "native-call");
  assert.deepEqual(queued.assignment, { slot: "codex-mac", turnId });assert.equal(text.includes(input.prompt), false);
  recordMcpIntentReceipt(paths, new Set(), { requestId, ok: true, expiresAt: Date.now() + 30_000, version: 1 });
  assert.deepEqual((await pending)?.hookSpecificOutput.updatedInput, { slot: "codex-mac", requestId });
});

function temporary(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths: nodePaths(root) };
}

function customPolicy(paths: NodePaths, file: string): void {
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE,
    name: "synthetic", publicKey: "synthetic", privateKeyFile: path.join(paths.dir, "synthetic-key"), policyFile: file,
    enrolledAt: new Date(0).toISOString() });
}

async function queuedRequestId(paths: NodePaths): Promise<string> {
  let names: string[] = [];
  for (let attempt = 0; attempt < 100 && names.length === 0; attempt++) {
    try {
      names = fs.readdirSync(paths.mcpIntents).filter((name) =>
        /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name));
    } catch { /* created asynchronously */ }
    if (names.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(names.length, 1);
  return names[0]!.slice(0, -5);
}

async function runHookCli(root: string, input: Record<string, unknown>, extra: string[]): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "mcp-intent-hook.mts"), "--config-root", root, ...extra],
    { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(input));
  const [code] = await once(child, "close");
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  return JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
}

test("queued intent polling waits for the published UUID file and ignores atomic staging files", async (t) => {
  const { paths } = temporary(t);
  fs.mkdirSync(paths.mcpIntents, { recursive: true });
  fs.writeFileSync(path.join(paths.mcpIntents, `.${MESSAGE}.${NODE}.json`), "synthetic-staging");
  const publish = setTimeout(() => fs.writeFileSync(path.join(paths.mcpIntents, `${MESSAGE}.json`), "{}"), 30);
  t.after(() => clearTimeout(publish));
  assert.equal(await queuedRequestId(paths), MESSAGE);
});

test("credential is stored privately and inbox reads do not alter delivery state", (t) => {
  const { paths } = temporary(t);
  assert.equal(hasMcpCredential(paths), false);
  recordMcpCredential(paths, { requestId: MESSAGE, ok: true, token: "s".repeat(43), version: 1 }, CREDENTIAL);
  assert.equal(hasMcpCredential(paths), true);
  const mode = fs.statSync(paths.mcpCredential).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600);

  storeMessage(paths.inbox, { messageId: MESSAGE, from: { nodeId: NODE, session: "peer" }, toSession: "session-a",
    text: "local-only", createdAt: "2026-09-30T00:00:00.000Z" });
  assert.equal(readMcpInbox(paths, "other-session", 10).length, 0);
  assert.equal(readMcpInbox(paths, "session-a", 10)[0]?.text, "local-only");
  assert.equal(getMessage(paths.inbox, MESSAGE)?.state, "accepted");
});

test("disabling remote MCP removes private credentials and pending local exchange state", (t) => {
  const { paths } = temporary(t);
  const pending = "40000000-0000-4000-8000-000000000002";
  recordMcpCredential(paths, { requestId: MESSAGE, ok: true, token: "s".repeat(43), version: 1 }, CREDENTIAL);
  const credentialTemp = path.join(paths.mcp, `.credential.json.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(credentialTemp, "synthetic-stale-credential");
  recordMcpIntentReceipt(paths, new Set(), { requestId: MESSAGE, ok: true, expiresAt: Date.now() + 120_000, version: 1 });
  enqueueMcpIntent(paths, { requestId: pending, runtime: "codex", sessionId: "session-a", callId: "call-a",
    tool: "sessions", argumentsDigest: "a".repeat(64) });
  const inflight = new Set([pending]);

  disableMcp(paths, inflight);

  assert.equal(hasMcpCredential(paths), false);
  assert.equal(fs.existsSync(credentialTemp), false);
  assert.deepEqual(fs.readdirSync(paths.mcpIntents), []);
  assert.deepEqual(fs.readdirSync(paths.mcpReceipts), []);
  assert.equal(inflight.size, 0);
});

test("trusted hook rejects a model requestId and waits for durable registration receipt", async (t) => {
  const { root, paths } = temporary(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  const base = { hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "session-a", tool_use_id: "call-a" };
  const denied = await processMcpIntentHook({ ...base, tool_input: { requestId: MESSAGE, limit: 5 } }, root);
  assert.deepEqual(denied?.hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "remote_mcp_request_id_must_be_native" });

  const pending = processMcpIntentHook({ ...base, tool_input: { limit: 5 } }, root);
  const requestId = await queuedRequestId(paths);
  recordMcpIntentReceipt(paths, new Set([requestId]), { requestId, ok: true, expiresAt: Date.now() + 120_000, version: 1 });
  const accepted = await pending;
  assert.deepEqual(accepted?.hookSpecificOutput, {
    hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { limit: 5, requestId },
  });

  assert.equal(fs.existsSync(path.join(paths.mcpReceipts, `${requestId}.json`)), false);
});

test("trusted hook denies missing native identity without queuing an intent", async (t) => {
  const { root, paths } = temporary(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  const base = { hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "session-a", tool_use_id: "call-a", tool_input: { limit: 5 } };
  for (const invalid of [{ session_id: undefined }, { tool_use_id: undefined },
    { hook_event_name: "PostToolUse" }, { tool_input: [] }]) {
    const result = await processMcpIntentHook({ ...base, ...invalid }, root);
    assert.deepEqual(result?.hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: "remote_mcp_missing_native_identity" });
  }
  assert.equal(fs.existsSync(paths.mcpIntents), false);
});

test("trusted hook denies rejected durable registration without rewriting arguments", async (t) => {
  const { root, paths } = temporary(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  const pending = processMcpIntentHook({ hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "session-a", tool_use_id: "call-a", tool_input: { limit: 5 } }, root);
  const requestId = await queuedRequestId(paths);
  recordMcpIntentReceipt(paths, new Set([requestId]), { requestId, ok: false, error: "synthetic-rejection" });
  assert.deepEqual((await pending)?.hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "remote_mcp_intent_rejected" });
  assert.equal(fs.existsSync(path.join(paths.mcpReceipts, `${requestId}.json`)), false);
});

test("trusted Claude hook records native identity and rewrites only after a positive durable receipt", async (t) => {
  const { root, paths } = temporary(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    remoteMcp: { enabled: true, claudeCode: true } }));
  const input = { hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "actual-claude-session", tool_use_id: "actual-claude-call", tool_input: { limit: 5 } };
  const pending = runHookCli(root, input, ["--runtime", "claude-code"]);
  const requestId = await queuedRequestId(paths);
  const recorded = JSON.parse(fs.readFileSync(path.join(paths.mcpIntents, `${requestId}.json`), "utf8"));
  assert.deepEqual(recorded, { requestId, runtime: "claude-code", sessionId: "actual-claude-session",
    callId: "actual-claude-call", tool: "sessions", argumentsDigest: await digestMcpArguments(input.tool_input) });
  recordMcpIntentReceipt(paths, new Set([requestId]), { requestId, ok: true, expiresAt: Date.now() + 120_000, version: 1 });
  assert.deepEqual((await pending).hookSpecificOutput, {
    hookEventName: "PreToolUse", updatedInput: { limit: 5, requestId },
  });
});

test("trusted hook CLI rejects every explicit runtime except Claude Code", async (t) => {
  const { root } = temporary(t);
  const output = await runHookCli(root, {}, ["--runtime", "codex"]);
  assert.deepEqual(output.hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "remote_mcp_invalid_arguments" });
});

test("trusted Claude hook denies caller request IDs and negative durable receipts", async (t) => {
  const { root, paths } = temporary(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    remoteMcp: { enabled: true, claudeCode: true } }));
  const base = { hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "actual-claude-session", tool_use_id: "actual-claude-call" };
  const supplied = await processMcpIntentHook({ ...base, tool_input: { requestId: MESSAGE } }, root, Date.now(), "claude-code");
  assert.equal(supplied?.hookSpecificOutput.permissionDecisionReason, "remote_mcp_request_id_must_be_native");

  const pending = processMcpIntentHook({ ...base, tool_input: {} }, root, Date.now(), "claude-code");
  const requestId = await queuedRequestId(paths);
  recordMcpIntentReceipt(paths, new Set([requestId]), { requestId, ok: false, error: "synthetic-rejection" });
  assert.deepEqual((await pending)?.hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "remote_mcp_intent_rejected" });
});

test("trusted Claude hook fails closed without the literal Claude runtime opt-in", async (t) => {
  for (const [index, remoteMcp] of [{ enabled: true }, { enabled: true, claudeCode: false },
    { enabled: true, claudeCode: "true" }].entries()) {
    const { root, paths } = temporary(t);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp }));
    const result = await processMcpIntentHook({ hook_event_name: "PreToolUse",
      tool_name: "mcp__kherep_messaging__sessions", session_id: `session-${index}`,
      tool_use_id: `call-${index}`, tool_input: {} }, root, Date.now(), "claude-code");
    assert.equal(result?.hookSpecificOutput.permissionDecisionReason, "remote_mcp_disabled");
    assert.equal(fs.existsSync(paths.mcpIntents), false);
  }
});

test("trusted hook fails closed without the current remote MCP policy opt-in", async (t) => {
  const { root, paths } = temporary(t);
  const result = await processMcpIntentHook({ hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "session-a", tool_use_id: "call-a", tool_input: { limit: 5 } }, root, Date.now() - 8_000);
  assert.equal(result?.hookSpecificOutput.permissionDecisionReason, "remote_mcp_disabled");
  assert.equal(fs.existsSync(paths.mcpIntents), false);
});

test("trusted hook uses an enabled custom effective policy", async (t) => {
  const { root, paths } = temporary(t);
  const effective = path.join(root, "custom-policy.json");
  customPolicy(paths, effective);
  fs.writeFileSync(effective, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  const result = await processMcpIntentHook({ hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "session-a", tool_use_id: "call-a", tool_input: { limit: 5 } }, root, Date.now() - 8_000);
  assert.equal(result?.hookSpecificOutput.permissionDecisionReason, "remote_mcp_intent_ack_timeout");
  assert.equal(fs.readdirSync(paths.mcpIntents).length, 1);
});

test("trusted hook rejects a disabled custom policy even when the default path is enabled", async (t) => {
  const { root, paths } = temporary(t);
  const effective = path.join(root, "custom-policy.json");
  customPolicy(paths, effective);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  fs.writeFileSync(effective, JSON.stringify({ version: 1, allowedCommands: [] }));
  const result = await processMcpIntentHook({ hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
    session_id: "session-a", tool_use_id: "call-a", tool_input: { limit: 5 } }, root, Date.now() - 8_000);
  assert.equal(result?.hookSpecificOutput.permissionDecisionReason, "remote_mcp_disabled");
  assert.equal(fs.existsSync(paths.mcpIntents), false);
});
