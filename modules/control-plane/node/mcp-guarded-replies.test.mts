import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import type { McpRuntime } from "../protocol-mcp.mts";
import type { MessageDeliverBody } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { nodePaths } from "./config.mts";
import { deliveryDepth, exchangeOptions, getSent, recordSent, writeOutbox } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { processMcpIntentHook } from "./mcp-intent-hook.mts";
import { recordMcpIntentReceipt } from "./mcp-local.mts";
import { DEFAULT_POLICY, type NodePolicy } from "./policy.mts";
import { automaticReplyDecision } from "./reply-admission.mts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const PARENT = "00000000-0000-4000-8000-000000000003";
const guarded = { version: 1 as const, threadId: PARENT, depth: 1, generation: 0, ordinal: 2 };
function fixture(t: test.TestContext, loop = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-guarded-mcp-")), paths = nodePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy: NodePolicy = { ...DEFAULT_POLICY, remoteMcp: { enabled: true, claudeCode: true }, messaging: { accept: [{ session: "*", from: ["*"] }] } };
  fs.mkdirSync(paths.dir, { recursive: true }); fs.writeFileSync(paths.policy, JSON.stringify(policy));
  storeMessage(paths.inbox, { messageId: PARENT, from: { nodeId: PEER, session: "synthetic-peer" }, toSession: OWNER,
    text: "Synthetic guarded history", createdAt: new Date().toISOString(), ...(loop ? { loop: guarded } : {}) }, Date.now(), 1);
  const client = new NodeClient({ nodeId: OWNER, identity: generateIdentity(), policy,
    facts: () => ({ hostname: "synthetic.example", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1024 }),
    runtimes: async () => [], sessions: async () => [],
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] }, ...exchangeOptions(paths),
    storeMessage: (body) => { storeMessage(paths.inbox, body, Date.now(), deliveryDepth(paths, body)); } });
  return { root, paths, client };
}
async function reply(f: ReturnType<typeof fixture>, runtime: McpRuntime, dropParent = false, extra: Record<string, unknown> = {}) {
  let intents = 0;
  const pump = setInterval(() => {
    if (!fs.existsSync(f.paths.mcpIntents)) return;
    for (const file of fs.readdirSync(f.paths.mcpIntents).filter((name) => name.endsWith(".json"))) {
      const input = JSON.parse(fs.readFileSync(path.join(f.paths.mcpIntents, file), "utf8")); intents++;
      if (dropParent) fs.rmSync(path.join(f.paths.inbox, `${PARENT}.json`), { force: true });
      recordMcpIntentReceipt(f.paths, new Set(), { requestId: input.requestId, ok: true, expiresAt: Date.now() + 30_000, version: 1 });
    }
  }, 5);
  try {
    const output = await processMcpIntentHook({ hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__reply",
      session_id: OWNER, tool_use_id: "synthetic-reply", tool_input: { inReplyTo: PARENT, text: "Synthetic useful reply", ...extra } }, f.root, Date.now(), runtime);
    return { output, intents };
  } finally { clearInterval(pump); }
}
const descendant = (requestId: string, loop = false): MessageDeliverBody => ({ messageId: crypto.randomUUID(),
  from: { nodeId: PEER, session: "synthetic-peer" }, toSession: OWNER, text: "Synthetic descendant", inReplyTo: requestId,
  createdAt: new Date().toISOString(), ...(loop ? { loop: { ...guarded, depth: 3, ordinal: 4 } } : {}) });
const deliver = (f: ReturnType<typeof fixture>, body: MessageDeliverBody) => f.client.onFrame(JSON.stringify(makeEnvelope("message.deliver", body, 0, 0)));
const authenticate = (f: ReturnType<typeof fixture>) => f.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));

for (const runtime of ["claude-code", "codex"] as const) {
  test(`${runtime}: real MCP hook retains deny-only provenance before parent loss; no metadata-free inbox acceptance`, async (t) => {
    const f = fixture(t), { output, intents } = await reply(f, runtime, true);
    const requestId = String(output?.hookSpecificOutput.updatedInput?.requestId);
    assert.match(requestId, /^[0-9a-f-]{36}$/); assert.equal(intents, 1);
    assert.equal(getMessage(f.paths.inbox, PARENT), null, "the parent was lost after intent publication");
    assert.equal(recordSent(f.paths, requestId, "accepted"), false, "no fabricated send state or outbox");
    assert.equal(getSent(f.paths, requestId), null);
    await authenticate(f);
    const missing = descendant(requestId);
    assert.deepEqual(await deliver(f, missing), []);
    assert.equal(getMessage(f.paths.inbox, missing.messageId), null, "no inbox record exists to wake from");
    const valid = descendant(requestId, true), frames = await deliver(f, valid);
    const parsed = parseEnvelope(frames[0]); assert.ok(parsed.ok);
    assert.deepEqual(parsed.envelope.body, { messageId: valid.messageId, state: "accepted" });
    assert.deepEqual(automaticReplyDecision(getMessage(f.paths.inbox, valid.messageId)!), { allowed: true, mode: "guarded" });
  });
  test(`${runtime}: provenance persistence failure denies before publishing an intent`, async (t) => {
    const f = fixture(t); fs.mkdirSync(f.paths.mcp, { recursive: true });
    fs.writeFileSync(path.join(f.paths.mcp, "guarded-replies"), "synthetic path blocker");
    const { output, intents } = await reply(f, runtime);
    assert.equal(output?.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(output?.hookSpecificOutput.permissionDecisionReason, "remote_mcp_intent_storage_error");
    assert.equal(intents, 0); assert.equal(output?.hookSpecificOutput.updatedInput, undefined);
  });
}

test("legacy/mixed MCP history and caller-proposed loop metadata cannot mint guarded provenance", async (t) => {
  const f = fixture(t, false), { output } = await reply(f, "claude-code", true, { loop: guarded });
  const requestId = String(output?.hookSpecificOutput.updatedInput?.requestId);
  await authenticate(f);
  const plain = descendant(requestId); await deliver(f, plain);
  assert.deepEqual(automaticReplyDecision(getMessage(f.paths.inbox, plain.messageId)!), { allowed: true, mode: "legacy" });
  writeOutbox(f.paths, { messageId: requestId, fromSession: OWNER, to: { nodeId: PEER, session: "synthetic-peer" },
    text: "Synthetic legacy reply", depth: 5, createdAt: new Date().toISOString() });
  recordSent(f.paths, requestId, "accepted");
  const capped = descendant(requestId); await deliver(f, capped);
  assert.equal(getMessage(f.paths.inbox, capped.messageId)?.depth, 6);
  assert.deepEqual(automaticReplyDecision(getMessage(f.paths.inbox, capped.messageId)!), { allowed: false, code: "legacy-depth" });
});

test("deny-only markers are idempotent, content-free, retained after parent loss and bounded without eviction", async (t) => {
  const { rememberGuardedMcpReply, wasGuardedMcpReply, MAX_GUARDED_MCP_REPLIES } = await import("./guarded-replies.mts");
  const f = fixture(t), requestId = crypto.randomUUID();
  rememberGuardedMcpReply(f.paths, requestId, PARENT);
  const dir = path.join(f.paths.mcp, "guarded-replies"), file = path.join(dir, `${requestId}.json`);
  const before = fs.statSync(file), bytes = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(bytes), { version: 1 });
  rememberGuardedMcpReply(f.paths, requestId, PARENT);
  assert.equal(fs.statSync(file).ino, before.ino); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  for (let i = 1; i < MAX_GUARDED_MCP_REPLIES; i++) fs.writeFileSync(path.join(dir, `synthetic-${i}.json`), '{"version":1}');
  rememberGuardedMcpReply(f.paths, requestId, PARENT);
  assert.throws(() => rememberGuardedMcpReply(f.paths, crypto.randomUUID(), PARENT), /guarded-reply-provenance-unavailable/);
  fs.rmSync(path.join(f.paths.inbox, `${PARENT}.json`));
  assert.equal(wasGuardedMcpReply(f.paths, requestId), true);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length, MAX_GUARDED_MCP_REPLIES);
});

test("an unreadable or malformed deny-only marker cannot become legacy permission", async (t) => {
  const { rememberGuardedMcpReply } = await import("./guarded-replies.mts");
  const f = fixture(t), requestId = crypto.randomUUID(); rememberGuardedMcpReply(f.paths, requestId, PARENT);
  const file = path.join(f.paths.mcp, "guarded-replies", `${requestId}.json`);
  fs.writeFileSync(file, '{"version":2}');
  assert.throws(() => deliveryDepth(f.paths, descendant(requestId)), /guarded-reply-provenance-unavailable/);
  fs.writeFileSync(file, '{"version":1}');
  const read = fs.readFileSync;
  const mock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (args[0] === file) throw Object.assign(new Error("synthetic marker disappeared after stat"), { code: "ENOENT" });
    return Reflect.apply(read, fs, args);
  });
  assert.throws(() => deliveryDepth(f.paths, descendant(requestId)), /guarded-reply-provenance-unavailable/);
  assert.equal(deliveryDepth(f.paths, descendant(requestId, true)), 3, "valid Worker context remains the authority");
  mock.mock.restore();
});

test("partial retained guarded history fails closed and cannot produce a marker or intent", async (t) => {
  const f = fixture(t);
  const parent = getMessage(f.paths.inbox, PARENT)!;
  fs.writeFileSync(path.join(f.paths.inbox, `${PARENT}.json`), JSON.stringify({ ...parent, loop: null }));
  const { output, intents } = await reply(f, "claude-code");
  assert.equal(output?.hookSpecificOutput.permissionDecision, "deny"); assert.equal(intents, 0);
  assert.equal(fs.existsSync(path.join(f.paths.mcp, "guarded-replies")), false);
});
