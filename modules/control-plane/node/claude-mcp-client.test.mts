import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_CLIENT_GRAPH, CLAUDE_TOOL_MATCHER, renderClaudeClient, stageClaudeClient, verifyClaudeClient,
} from "./claude-mcp-client.mts";
import { fakePowerShell } from "./mcp-credential-fixture.mts";
import {
  answerIntent, awaitClose, awaitPublishedIntent, describe, ensureClosed, type HookRun, intentRenamePreload,
  ownedRoot, preloadEvents, startStagedHook, text,
} from "./mcp-intent-hook-fixture.mts";

const NODE_ID = "00000000-0000-4000-8000-0000000000aa";
const REQUEST_ID = "40000000-0000-4000-8000-000000000001";

// The root is removed only after every hook started under it closed (issue #657).
function fixture(t: test.TestContext) {
  const { root, runs } = ownedRoot(t, "kherep-claude-client-");
  const outputRoot = path.join(root, "candidate");
  const clientRoot = path.join(root, "home with space", "kherep", "claude-messaging-client");
  const configRoot = path.join(root, "config with space");
  fs.mkdirSync(configRoot, { recursive: true });
  return { root, outputRoot, clientRoot, configRoot, runs };
}

// Answers the published intent and asserts the full Claude rewrite: a denial
// or an ack timeout also exits 0, so the exit code alone proves nothing.
async function assertRewrite(run: HookRun, intents: string, receipts: string, name: string): Promise<void> {
  const intent = JSON.parse(fs.readFileSync(path.join(intents, name), "utf8"));
  answerIntent(receipts, intent.requestId);
  const closure = await awaitClose(run);
  assert.equal(closure.kind, "closed", describe(run, closure));
  assert.equal(closure.code, 0, describe(run, closure));
  const output = JSON.parse(text(run.stdout));
  assert.equal(Object.hasOwn(output.hookSpecificOutput, "permissionDecision"), false, describe(run));
  assert.deepEqual(output.hookSpecificOutput.updatedInput, { limit: 5, requestId: intent.requestId });
}

test("renders an exact hook-only plugin and one credential-free MCP server", () => {
  const clientRoot = "/opt/Kherep Client";
  const configRoot = "/opt/Kherep Config";
  const rendered = renderClaudeClient({ clientRoot, configRoot, nodeCommand: "/usr/local/bin/node" });
  const hooks = JSON.parse(rendered.hooksJson);
  const handler = hooks.hooks.PreToolUse[0];
  assert.equal(handler.matcher, CLAUDE_TOOL_MATCHER);
  assert.deepEqual(handler.hooks, [{ type: "command", command: "/usr/local/bin/node", args: [
    "/opt/Kherep Client/control-plane/node/mcp-intent-hook.mts", "--config-root", configRoot,
    "--runtime", "claude-code",
  ] }]);
  assert.deepEqual(JSON.parse(rendered.mcpJson), { mcpServers: { kherep_messaging: {
    command: "/usr/local/bin/node", args: ["/opt/Kherep Client/control-plane/node/mcp-stdio-bridge.mts",
      "--config-root", configRoot],
  } } });
  assert.deepEqual(rendered.activationArgs, ["--plugin-dir", "/opt/Kherep Client/plugin",
    "--mcp-config", "/opt/Kherep Client/mcp.json", "--strict-mcp-config"]);
  assert.doesNotMatch(`${rendered.pluginJson}${rendered.hooksJson}${rendered.mcpJson}`,
    /allowedTools|permissionDecision|Authorization|Bearer|token|listen|env/i);
});

test("rejects unsafe expansion and control syntax in every rendered command path", () => {
  const base = { clientRoot: "/safe/client", configRoot: "/safe/config", nodeCommand: "/safe/node" };
  for (const [key, value] of [["clientRoot", "/bad/$HOME"], ["configRoot", "/bad/`id`"],
    ["nodeCommand", "/bad/%PATH%"], ["clientRoot", "/bad\npath"]] as const) {
    assert.throws(() => renderClaudeClient({ ...base, [key]: value }), /unsafe command path/);
  }
  assert.throws(() => renderClaudeClient({ ...base, configRoot: "relative" }), /absolute/);
});

test("renders native Windows paths as structured exec arguments", () => {
  const clientRoot = String.raw`C:\Users\Example User\.claude\kherep\claude-messaging-client`;
  const configRoot = String.raw`D:\Kherep Config`;
  const nodeCommand = String.raw`C:\Program Files\nodejs\node.exe`;
  const rendered = renderClaudeClient({ clientRoot, configRoot, nodeCommand });
  const hook = JSON.parse(rendered.hooksJson).hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(hook, { type: "command", command: nodeCommand, args: [
    path.win32.join(clientRoot, "control-plane", "node", "mcp-intent-hook.mts"),
    "--config-root", configRoot, "--runtime", "claude-code",
  ] });
  assert.deepEqual(JSON.parse(rendered.mcpJson).mcpServers.kherep_messaging.args, [
    path.win32.join(clientRoot, "control-plane", "node", "mcp-stdio-bridge.mts"), "--config-root", configRoot,
  ]);
});

test("stages and verifies the complete closed public graph", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  const result = stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  assert.deepEqual(CLAUDE_CLIENT_GRAPH, [
    "protocol.mts", "protocol-mcp.mts", "protocol-messages.mts", "protocol-loop-brake.mts", "protocol-session-identity.mts", "protocol-message-binding.mts", "protocol-task-control.mts",
    "protocol-tasks.mts", "node/config.mts", "node/inbox.mts", "node/inbox-storage.mts", "node/inbox-selected-read.mts", "node/inbox-record-lock.mts", "node/mcp-local.mts",
    "node/mcp-credential-file.mts", "node/guarded-replies.mts", "node/message-owner.mts", "node/session-publication.mts", "node/policy.mts",
    "node/session-policy.mts", "node/mcp-intent-hook.mts", "node/mcp-stdio-bridge.mts",
  ]);
  for (const relative of CLAUDE_CLIENT_GRAPH) {
    assert.equal(fs.readFileSync(path.join(outputRoot, "control-plane", relative), "utf8"),
      fs.readFileSync(path.join(import.meta.dirname, "..", relative), "utf8"), relative);
  }
  assert.deepEqual(verifyClaudeClient(outputRoot), result);
  fs.writeFileSync(path.join(outputRoot, "unmanaged.txt"), "extra");
  assert.throws(() => verifyClaudeClient(outputRoot), /unmanaged client content/);
});

test("verification binds the manifest to its rendered bytes and intended target", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  assert.throws(() => verifyClaudeClient(outputRoot, "/different/client"), /client root identity/);
  const manifestFile = path.join(outputRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.configRoot = "/different/config";
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyClaudeClient(outputRoot), /manifest rendering mismatch/);
});

test("verification accepts reordered manifest file and directory declarations", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  const staged = stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const manifestFile = path.join(outputRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files = Object.fromEntries(Object.entries(manifest.files).reverse());
  manifest.directories.reverse();
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestFile, bytes);
  assert.deepEqual(verifyClaudeClient(outputRoot), {
    files: staged.files, manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  });
});

test("the fixed graph cannot be expanded by editing the manifest", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const manifestFile = path.join(outputRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const extra = path.join(outputRoot, "unmanaged.txt");
  fs.writeFileSync(extra, "extra");
  manifest.files["unmanaged.txt"] = createHash("sha256").update("extra").digest("hex");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyClaudeClient(outputRoot), /unmanaged client content/);
});

test("the fixed graph cannot be reduced by editing the manifest", (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const manifestFile = path.join(outputRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const required = "control-plane/node/mcp-local.mts";
  fs.rmSync(path.join(outputRoot, required));
  delete manifest.files[required];
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyClaudeClient(outputRoot), /required client content/);
});

test("staging refuses a source graph reached through a symlink ancestor", (t) => {
  const { root, outputRoot, clientRoot, configRoot } = fixture(t);
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);
  for (const relative of CLAUDE_CLIENT_GRAPH.filter((entry) => !entry.startsWith("node/"))) {
    fs.copyFileSync(path.join(import.meta.dirname, "..", relative), path.join(sourceRoot, relative));
  }
  try {
    fs.symlinkSync(import.meta.dirname, path.join(sourceRoot, "node"));
  } catch (error) {
    if (["EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip("directory symlinks are unavailable");
    throw error;
  }
  assert.throws(() => stageClaudeClient({ outputRoot, clientRoot, configRoot,
    nodeCommand: process.execPath, sourceRoot }), /symlink ancestor/);
});

test("the staged hook performs a Claude rewrite without automatic approval", async (t) => {
  const { outputRoot, clientRoot, configRoot, runs } = fixture(t);
  const { run, intents, receipts } = startStagedHook({ outputRoot, clientRoot, configRoot, runs });
  try {
    const outcome = await awaitPublishedIntent(run, intents);
    assert.equal(outcome.kind, "published", describe(run, outcome));
    await assertRewrite(run, intents, receipts, outcome.name);
  } finally {
    // Before fixture()'s t.after removes the root: t.after hooks run after this finally.
    await ensureClosed(run);
  }
});

test("a delayed publication is awaited and still rewrites (issue #657)", async (t) => {
  const { outputRoot, clientRoot, configRoot, runs } = fixture(t);
  const { run, intents, receipts } = startStagedHook({ outputRoot, clientRoot, configRoot, runs,
    preload: [intentRenamePreload({ beforeMs: 2_500 })] });
  try {
    const outcome = await awaitPublishedIntent(run, intents);
    assert.equal(outcome.kind, "published", describe(run, outcome));
    await assertRewrite(run, intents, receipts, outcome.name);
    // Engagement as the hook reports it, not the awaiter's clock.
    const pause = preloadEvents(run).find((event) => event.phase === "before" && "result" in event);
    assert.equal(pause?.result, "timed-out", describe(run));
  } finally { await ensureClosed(run); }
});

test("a hook that exits without publishing is reported with its output, not as a timeout (issue #657)", async (t) => {
  const { outputRoot, clientRoot, configRoot, runs } = fixture(t);
  const { run, intents } = startStagedHook({ outputRoot, clientRoot, configRoot, runs, claudeCode: false });
  try {
    const outcome = await awaitPublishedIntent(run, intents);
    assert.equal(outcome.kind, "exited", describe(run, outcome));
    assert.equal(outcome.code, 0, describe(run, outcome));
    assert.match(text(run.stdout), /remote_mcp_disabled/);
    assert.equal(fs.existsSync(intents), false);
  } finally { await ensureClosed(run); }
});

test("the staged bridge forwards actual Claude metadata unchanged", async (t) => {
  const { outputRoot, clientRoot, configRoot } = fixture(t);
  stageClaudeClient({ outputRoot, clientRoot, configRoot, nodeCommand: process.execPath });
  const installed = path.join(outputRoot, "control-plane", "node");
  const config = await import(pathToFileURL(path.join(installed, "config.mts")).href);
  const loop = await import(pathToFileURL(path.join(outputRoot, "control-plane/protocol-loop-brake.mts")).href);
  assert.equal(loop.MESSAGING_LOOP_BRAKE_CAPABILITY, "messaging.loop-brake.v1");
  const guardedReplies = await import(pathToFileURL(path.join(installed, "guarded-replies.mts")).href);
  assert.equal(typeof guardedReplies.rememberGuardedMcpReply, "function");
  assert.equal(typeof guardedReplies.wasGuardedMcpReply, "function");
  const local = await import(pathToFileURL(path.join(installed, "mcp-local.mts")).href);
  const paths = config.nodePaths(configRoot);
  fs.mkdirSync(paths.dir, { recursive: true });
  config.writeConfig(paths.config, { version: 1, controlUrl: "https://example.invalid/",
    nodeId: NODE_ID, name: "synthetic", publicKey: "synthetic", privateKeyFile: path.join(paths.dir, "key"),
    policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    remoteMcp: { enabled: true, claudeCode: true } }));
  // Metadata forwarding is under test here, not the Windows helper (issue #219).
  const powerShell = fakePowerShell();
  local.recordMcpCredential(paths, { requestId: REQUEST_ID,
    ok: true, token: `synthetic-${"a".repeat(40)}`, version: 1 }, { spawn: powerShell.spawn });
  const bridge = await import(pathToFileURL(path.join(outputRoot, "control-plane/node/mcp-stdio-bridge.mts")).href);
  const native = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sessions", arguments: {},
    _meta: { "claudecode/toolUseId": "actual-call" } } };
  let forwarded: unknown;
  await bridge.forwardMcpLine(JSON.stringify(native), configRoot, { credential: { spawn: powerShell.spawn },
    fetch: async (_url: unknown, init: RequestInit) => {
      forwarded = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        { headers: { "content-type": "application/json" } });
    } });
  assert.deepEqual(forwarded, native);
  // Write, its ACL check and the bridge's ACL check; POSIX starts no helper.
  assert.equal(powerShell.calls.length, process.platform === "win32" ? 3 : 0);
});
