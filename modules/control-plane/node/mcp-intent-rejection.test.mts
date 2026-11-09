import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { generateIdentity } from "./identity.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { consumeMcpIntentReceipt, pollMcpIntents, recordMcpIntentReceipt } from "./mcp-local.mts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SENTINEL = "SYNTHETIC_SECRET_SENTINEL";
const GENERIC = "remote_mcp_intent_rejected";
const WORKER_ERRORS = [
  ["invalid intent metadata", "worker_metadata"],
  ["native original assignment evidence is required", "worker_metadata"],
  ["remote MCP is not enabled for this node", "worker_capability"],
  ["remote MCP runtime is not enabled for this node", "worker_capability"],
  ["Codex Mac assignment requires an eligible enrolled Mac node", "worker_enrollment"],
  ["current enrolled-node registration is required for self-assignment", "worker_enrollment"],
  ["native session is not registered on this node", "worker_session"],
  ["remote MCP credential is not provisioned", "worker_credential"],
  ["requestId already has different intent metadata", "worker_conflict"],
  ["too many unexpired MCP intents", "worker_capacity"],
  ["too many retained MCP intents", "worker_capacity"],
  ["Intercom roster unavailable", "worker_roster"],
] as const;

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-intent-rejection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  return { root, paths };
}

// Node 24.1 emits this exact warning and hint when loading .mts children.
// Allow one pair at the start; preserve every other stderr byte for the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n");

function readHookOutput(stdout: string, stderr: string): Record<string, unknown> {
  assert.equal((stdout + stderr).includes(SENTINEL), false, "synthetic secret leaked in raw hook output");
  assert.equal(stderr.replace(TYPE_STRIPPING_WARNING, ""), "", "unexpected hook stderr");
  return JSON.parse(stdout).hookSpecificOutput as Record<string, unknown>;
}

function syntheticHookOutput(stderr: string, stdout = JSON.stringify({ hookSpecificOutput: { synthetic: true } })) {
  const child = spawnSync(process.execPath, ["-e",
    "const data = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); "
      + "process.stdout.write(data.stdout); process.stderr.write(data.stderr);"],
    { input: JSON.stringify({ stdout, stderr }), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return readHookOutput(child.stdout, child.stderr);
}

const SYNTHETIC_TYPE_STRIPPING_WARNING = "(node:1234) ExperimentalWarning: Type Stripping is an experimental feature "
  + "and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n";

test("hook output accepts only the known type-stripping warning or empty stderr", () => {
  for (const stderr of ["", SYNTHETIC_TYPE_STRIPPING_WARNING, SYNTHETIC_TYPE_STRIPPING_WARNING.replaceAll("\n", "\r\n")]) {
    assert.deepEqual(syntheticHookOutput(stderr), { synthetic: true });
  }
});

test("hook output rejects unrelated stderr even alongside the known warning", () => {
  for (const stderr of ["unexpected noise\n", SYNTHETIC_TYPE_STRIPPING_WARNING + "unexpected noise\n",
    "unexpected noise\n" + SYNTHETIC_TYPE_STRIPPING_WARNING,
    SYNTHETIC_TYPE_STRIPPING_WARNING.replace("Type Stripping", "Other Feature"),
    SYNTHETIC_TYPE_STRIPPING_WARNING.split("\n")[1] + "\n",
    SYNTHETIC_TYPE_STRIPPING_WARNING.replace("created)", "created) extra"),
    SYNTHETIC_TYPE_STRIPPING_WARNING + "\n", SYNTHETIC_TYPE_STRIPPING_WARNING.repeat(2),
    SYNTHETIC_TYPE_STRIPPING_WARNING.split("\n")[0] + "\n"]) {
    assert.throws(() => syntheticHookOutput(stderr), /unexpected hook stderr/);
  }
});

test("hook output checks raw stdout and stderr for synthetic secrets before allowing runtime warnings", () => {
  for (const stderr of [SENTINEL, SYNTHETIC_TYPE_STRIPPING_WARNING + SENTINEL,
    SYNTHETIC_TYPE_STRIPPING_WARNING.replace("created)", `created) ${SENTINEL}`)]) {
    assert.throws(() => syntheticHookOutput(stderr), /synthetic secret leaked in raw hook output/);
  }
  assert.throws(() => syntheticHookOutput(SYNTHETIC_TYPE_STRIPPING_WARNING,
    JSON.stringify({ hookSpecificOutput: { secret: SENTINEL } })), /synthetic secret leaked in raw hook output/);
});

function hook(t: test.TestContext, root: string, tool = "status", toolInput: object = { messageId: OTHER }) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "mcp-intent-hook.mts"), "--config-root", root],
    { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const result = once(child, "close").then(([code]) => {
    assert.equal(code, 0, stderr);
    return readHookOutput(stdout, stderr);
  });
  child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION,
    tool_use_id: crypto.randomUUID(), turn_id: OTHER, tool_name: `mcp__kherep_messaging__${tool}`, tool_input: toolInput }));
  return result;
}

async function queued(paths: NodePaths, except = new Set<string>()): Promise<string> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const names = fs.existsSync(paths.mcpIntents) ? fs.readdirSync(paths.mcpIntents) : [];
    const name = names.find(name => /^[a-f0-9-]{36}\.json$/.test(name) && !except.has(name.slice(0, -5)));
    if (name) return name.slice(0, -5);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("synthetic hook did not enqueue its own intent");
}

function denied(output: Record<string, unknown>, reason: string) {
  assert.deepEqual(output, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason });
}

test("actual hook classifies exact authenticated Worker negatives without exposing their text", async t => {
  const { root, paths } = fixture(t);
  for (const [error, category] of WORKER_ERRORS) {
    const pending = hook(t, root);
    const requestId = await queued(paths);
    const inflight = new Set([requestId]);
    recordMcpIntentReceipt(paths, inflight, { requestId, ok: false, error });
    denied(await pending, `${GENERIC}_${category}`);
    assert.equal(inflight.size, 0);
    assert.equal(fs.existsSync(path.join(paths.mcpIntents, `${requestId}.json`)), false);
    assert.equal(consumeMcpIntentReceipt(paths, requestId), null);
  }
});

test("two actual hooks consume only their own reversed negative receipts", async t => {
  const { root, paths } = fixture(t);
  const first = hook(t, root), firstId = await queued(paths);
  const second = hook(t, root), secondId = await queued(paths, new Set([firstId]));
  recordMcpIntentReceipt(paths, new Set(), { requestId: secondId, ok: false, error: WORKER_ERRORS[6][0] });
  recordMcpIntentReceipt(paths, new Set(), { requestId: firstId, ok: false, error: WORKER_ERRORS[7][0] });
  const outputs = await Promise.all([first, second]);
  denied(outputs[0]!, `${GENERIC}_worker_credential`);
  denied(outputs[1]!, `${GENERIC}_worker_session`);
});

test("local assignment preparation is classified at the real poller, never inferred from remote text", async t => {
  const { root, paths } = fixture(t);
  const pending = hook(t, root, "assign_self", { slot: "codex-mac" });
  await queued(paths);
  const client = new NodeClient({ nodeId: OTHER, identity: generateIdentity(),
    policy: { version: 1, allowedCommands: [], remoteMcp: { enabled: true } },
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node.example.invalid", os: "darwin", arch: "arm64", cpus: 1, memoryBytes: 1024 }),
    runtimes: async () => [], sessions: async () => [{ sessionId: SESSION, runtime: "codex", state: "running" }],
    assignmentIdentity: async () => null, storeMessage: () => {} });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  await pollMcpIntents(client, paths, new Set(), () => true);
  denied(await pending, `${GENERIC}_node_assignment_preparation`);
});

test("unknown, legacy, spoofed and noncanonical negatives remain generic", async t => {
  const { root, paths } = fixture(t);
  for (const extra of [
    { error: SENTINEL }, { error: `${WORKER_ERRORS[6][0]} ${SENTINEL}` },
    { error: "verified original Codex Mac identity and native title are required" },
    { error: "latest direct appointment in the current original Codex Mac turn is required" },
    { error: "MCP intent rejected", diagnosticVersion: 1, rejectionCategory: "node_assignment_preparation" },
    { error: WORKER_ERRORS[6][0], category: "node_assignment_preparation" },
    { error: WORKER_ERRORS[6][0], extra: SENTINEL },
  ]) {
    const pending = hook(t, root), requestId = await queued(paths);
    recordMcpIntentReceipt(paths, new Set(), { requestId, ok: false, ...extra });
    denied(await pending, GENERIC);
  }
  for (const body of [
    { error: WORKER_ERRORS[6][0] },
    { error: "MCP intent rejected", diagnosticVersion: 1, rejectionCategory: "node_assignment_preparation" },
    { error: "MCP intent rejected", diagnosticVersion: 1, rejectionCategory: "worker_session", extra: SENTINEL },
  ]) {
    const pending = hook(t, root), requestId = await queued(paths);
    fs.mkdirSync(paths.mcpReceipts, { recursive: true });
    writeJsonAtomic(path.join(paths.mcpReceipts, `${requestId}.json`), { requestId, ok: false, ...body });
    denied(await pending, GENERIC);
    fs.unlinkSync(path.join(paths.mcpIntents, `${requestId}.json`));
  }
});

test("a same-file wrong-body UUID cannot supply a category and a sibling receipt stays unconsumed", async t => {
  const { root, paths } = fixture(t);
  const pending = hook(t, root), requestId = await queued(paths);
  recordMcpIntentReceipt(paths, new Set(), { requestId: OTHER, ok: false, error: WORKER_ERRORS[7][0] });
  fs.copyFileSync(path.join(paths.mcpReceipts, `${OTHER}.json`), path.join(paths.mcpReceipts, `${requestId}.json`));
  denied(await pending, GENERIC);
  assert.ok(consumeMcpIntentReceipt(paths, OTHER));
  assert.equal(consumeMcpIntentReceipt(paths, OTHER), null);
});

test("actual hook retains storage-error behavior for malformed receipts and positive native rewriting", async t => {
  const { root, paths } = fixture(t);
  const invalid = hook(t, root), invalidId = await queued(paths);
  fs.mkdirSync(paths.mcpReceipts, { recursive: true });
  fs.writeFileSync(path.join(paths.mcpReceipts, `${invalidId}.json`), "{");
  denied(await invalid, "remote_mcp_intent_storage_error");
  fs.unlinkSync(path.join(paths.mcpIntents, `${invalidId}.json`));
  const positive = hook(t, root), requestId = await queued(paths);
  recordMcpIntentReceipt(paths, new Set(), { requestId, ok: true, expiresAt: Date.now() + 30_000, version: 1 });
  assert.deepEqual(await positive, { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { messageId: OTHER, requestId } });
});

test("a parseable invalid receipt retains the existing timeout and stays unconsumed", async t => {
  const { root, paths } = fixture(t);
  const pending = hook(t, root), requestId = await queued(paths);
  fs.mkdirSync(paths.mcpReceipts, { recursive: true });
  const file = path.join(paths.mcpReceipts, `${requestId}.json`);
  fs.writeFileSync(file, JSON.stringify({ requestId, ok: false, error: 123 }));
  denied(await pending, "remote_mcp_intent_ack_timeout");
  assert.equal(fs.existsSync(file), true);
});
