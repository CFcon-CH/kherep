// Issue #538. The Codex messaging intent hook runs through the hook adapter in the
// phase pre-intent: the hook's allow with updatedInput passes only as the call's
// tool_input plus a UUID requestId, its deny tokens pass unchanged, and a missing,
// empty, broken, silent, late or off-contract hook is a deny in fixed text that
// names the file's basename and the installer. Guards are synthetic files in a
// mkdtemp named mcp-intent-hook.mts; I2 and I3 run the real hook of the checkout
// against a temporary config root. No real home, config or Codex is involved.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { nodePaths, type NodePaths } from "../../modules/control-plane/node/config.mts";
import { recordMcpIntentReceipt } from "../../modules/control-plane/node/mcp-local.mts";
import { copyAdapter, copySource } from "./hook-adapter.fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const ADAPTER = path.join(import.meta.dirname, "hook-adapter.mts");
const HOOK = path.join(REPO, "modules", "control-plane", "node", "mcp-intent-hook.mts");
const FLAG = "--disable-warning=ExperimentalWarning";
const TOOL_INPUT = { to: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" }, text: "x" };
const MCP = { hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__send", session_id: "s", tool_use_id: "c", tool_input: TOOL_INPUT };
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const TAIL = "the messaging call is blocked until the Codex installer reinstalls the messaging client";
const intentReason = (why: string): string => `[hook-adapter] mcp-intent-hook.mts cannot run (${why}); ${TAIL}`;
const shapeReason = (rule: string): string => intentReason(`stdout is not a PreToolUse decision (${rule})`);
const allowDoc = (requestId: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "allow", updatedInput: { ...TOOL_INPUT, requestId } } });
const denyDoc = (reason: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "deny", permissionDecisionReason: reason } });
// Raw error text that must never reach the reason or stderr in pre-intent.
const RAW = /SyntaxError|mcp-intent-hook|Cannot find module|abs\/path|[\\/]/;

function tmp(t: TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A guard named like the intent hook; `input` is its parsed stdin.
function fixture(t: TestContext, body: string): string {
  const guard = path.join(tmp(t, "kherep-intent-"), "mcp-intent-hook.mts");
  fs.writeFileSync(guard, ["import fs from 'node:fs';", "const input = JSON.parse(fs.readFileSync(0, 'utf8'));", body].join("\n"));
  return guard;
}
const print = (doc: string): string => `process.stdout.write(${JSON.stringify(doc)});`;
// The hook's rewrite, built from its stdin; without --config-root it denies, as the real hook does.
const REWRITE = `const ok = process.argv.includes('--config-root');
process.stdout.write(JSON.stringify(ok ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
  updatedInput: { ...input.tool_input, requestId: ${JSON.stringify(UUID)} } } }
  : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'remote_mcp_invalid_arguments' } }));`;

const runAdapter = (args: string[], input: string = JSON.stringify(MCP), adapter = ADAPTER) => spawnSync(process.execPath,
  [FLAG, adapter, ...args], { input, encoding: "utf8", windowsHide: true, timeout: 20_000, killSignal: "SIGKILL" });
const intentArgs = (guard: string, root = "/x"): string[] => [guard, "pre-intent", "--config-root", root];

function reasonOf(stdout: string): string {
  const output = (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny", stdout);
  return String(output.permissionDecisionReason);
}

test("I1 the adapter passes the guard --config-root and renders the allow with tool_input plus requestId", (t) => {
  const run = runAdapter(intentArgs(fixture(t, REWRITE)));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, allowDoc(UUID));
  assert.equal(run.stderr, "");
});

function enabledRoot(t: TestContext): { root: string; paths: NodePaths } {
  const root = tmp(t, "kherep-intent-root-");
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  return { root, paths };
}

async function queued(paths: NodePaths): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const [name] = fs.readdirSync(paths.mcpIntents).filter((entry) => /^[0-9a-f-]{36}\.json$/.test(entry));
      if (name) return name.slice(0, -5);
    } catch { /* created by the hook */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("intent was not queued");
}

function started(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const child = spawn(process.execPath, [FLAG, ADAPTER, ...args], { windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  child.stdin.end(JSON.stringify(MCP));
  return new Promise((resolve) => child.on("close", (status) => { clearTimeout(killer); resolve({ stdout, stderr, status }); }));
}

for (const [name, delayMs] of [["at once", 0], ["7.0 s after the intent is queued", 7_000]] as const) {
  test(`I2 the real intent hook, receipt ${name}: allow with updatedInput, unchanged bytes`, { timeout: 25_000 }, async (t) => {
    const { root, paths } = enabledRoot(t);
    const done = started(intentArgs(HOOK, root));
    const requestId = await queued(paths);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    recordMcpIntentReceipt(paths, new Set([requestId]), { requestId, ok: true, expiresAt: Date.now() + 120_000, version: 1 });
    const run = await done;
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, allowDoc(requestId));
    assert.equal(run.stderr, "");
  });
}

test("I3 the real intent hook without a receipt: its ack-timeout deny passes unchanged", { timeout: 25_000 }, (t) => {
  const { root } = enabledRoot(t);
  const run = runAdapter(intentArgs(HOOK, root));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, denyDoc("remote_mcp_intent_ack_timeout"));
});

test("I4 a hook that cannot run or breaks its contract is a deny in fixed text without paths or stderr", (t) => {
  const dir = tmp(t, "kherep-intent-faults-");
  const missing = path.join(dir, "missing", "mcp-intent-hook.mts");
  const empty = path.join(dir, "empty", "mcp-intent-hook.mts");
  const directory = path.join(dir, "directory", "mcp-intent-hook.mts");
  fs.mkdirSync(path.dirname(empty));
  fs.writeFileSync(empty, "");
  fs.mkdirSync(directory, { recursive: true });
  const cases: Array<[string, string]> = [
    [missing, "missing"], [empty, "empty, 0 bytes"], [directory, "not a regular file"],
    [fixture(t, "const = ;"), "exit code 1"],
    [fixture(t, "process.exit(0);"), "printed no decision"],
    [fixture(t, "process.stdout.write('hello');"), "stdout is not a PreToolUse decision"],
    [fixture(t, "process.stderr.write('secret /abs/path\\n'); process.exit(2);"), "exit code 2"],
    [fixture(t, print(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }))),
      "asked for confirmation; Codex has no ask"],
  ];
  for (const [guard, why] of cases) {
    const run = runAdapter(intentArgs(guard));
    assert.equal(run.status, 0, run.stderr);
    const reason = reasonOf(run.stdout);
    assert.equal(reason, intentReason(why), why);
    assert.doesNotMatch(reason, /[\\/]/, why);
    assert.equal(run.stderr, "", why);
    assert.doesNotMatch(run.stderr, RAW, why);
  }
});

test("I4 adapter-level failures in pre-intent name codex-hook-adapter.mts by its basename", (t) => {
  const adapter = path.join(tmp(t, "kherep-intent-self-"), "codex-hook-adapter.mts");
  copyAdapter(path.dirname(adapter), "codex-hook-adapter.mts");
  const guard = fixture(t, REWRITE);
  for (const [args, input, why] of [[["", "pre-intent"], "{}", "no guard given"],
    [["mcp-intent-hook.mts", "pre-intent"], "{}", "guard path is not absolute"],
    [[guard, "pre-intent"], "not json", "stdin is not a JSON object"]] as Array<[string[], string, string]>) {
    const run = runAdapter(args, input, adapter);
    assert.equal(run.status, 0, run.stderr);
    const reason = reasonOf(run.stdout);
    assert.equal(reason, `[hook-adapter] codex-hook-adapter.mts cannot run (${why}); the messaging call is blocked until hook integrity restores it`);
    assert.doesNotMatch(reason, /[\\/]/, why);
    assert.equal(run.stderr, "", why);
  }
});

test("I5 every stdout outside the hook's contract is a deny naming the rule", (t) => {
  const doc = (output: Record<string, unknown>): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...output } });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ permissionDecision: "deny", permissionDecisionReason: "r", updatedInput: { ...TOOL_INPUT, requestId: UUID } }, "invalid field updatedInput"],
    [{ permissionDecision: "allow" }, "allow without updatedInput"],
    [{ permissionDecision: "allow", updatedInput: "x" }, "invalid field updatedInput"],
    [{ permissionDecision: "allow", updatedInput: { ...TOOL_INPUT, text: "changed", requestId: UUID } }, "updatedInput is not tool_input plus requestId"],
    [{ permissionDecision: "allow", updatedInput: { ...TOOL_INPUT, requestId: UUID, extra: 1 } }, "updatedInput is not tool_input plus requestId"],
    [{ permissionDecision: "allow", updatedInput: { ...TOOL_INPUT } }, "updatedInput is not tool_input plus requestId"],
    [{ permissionDecision: "allow", updatedInput: { ...TOOL_INPUT, requestId: 7 } }, "updatedInput is not tool_input plus requestId"],
    [{ permissionDecision: "allow", updatedInput: { ...TOOL_INPUT, requestId: "not-a-uuid" } }, "requestId is not a UUID"],
    [{ permissionDecision: "allow", updatedInput: { ...TOOL_INPUT, requestId: "123e4567-e89b-02d3-a456-426614174000" } }, "requestId is not a UUID"],
    [{ additionalContext: "x" }, "no permissionDecision"],
    [{ permissionDecision: "deny", permissionDecisionReason: "r", "/Users/secret/path": 1 }, "unsupported field"],
  ];
  for (const [output, rule] of cases) {
    const run = runAdapter(intentArgs(fixture(t, print(doc(output)))));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(reasonOf(run.stdout), shapeReason(rule), JSON.stringify(output));
  }
});

test("I6 a hook that ignores SIGTERM is killed at the 12 s cap; the adapter ends by itself", { timeout: 25_000 }, (t) => {
  const guard = fixture(t, "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 30_000);");
  const begin = Date.now();
  const run = runAdapter(intentArgs(guard));
  assert.equal(run.error, undefined, "the adapter ended by itself");
  assert.ok(Date.now() - begin < 14_500, `took ${Date.now() - begin} ms`);
  assert.equal(reasonOf(run.stdout), intentReason("timed out after 12.0 s"));
});

test("I7 outside pre-intent updatedInput stays an unsupported field", (t) => {
  const guard = fixture(t, REWRITE);
  const run = runAdapter([guard, "pre", "--config-root", "/x"]);
  assert.equal(reasonOf(run.stdout), `[hook-adapter] ${path.basename(guard)} cannot run (stdout is not a PreToolUse decision (unsupported field updatedInput)); `
    + "the tool call is blocked until hook integrity restores it");
});

// I8: the installed layout, a heartbeat 31 minutes old. The re-check runs; its notice goes to
// stderr only, so the documents are exactly the hook's own (pattern of hook-adapter-recheck.test.mts).
const MIN = 60_000;
function installedBox(t: TestContext, guardBody: string): { adapter: string; guard: string } {
  const root = tmp(t, "kherep-intent-installed-");
  const dir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  const adapter = path.join(dir, "codex-hook-adapter.mts");
  copyAdapter(dir, "codex-hook-adapter.mts");
  copySource("shell-checks.mts", path.join(dir, "codex-shell-checks.mts"));
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "guard-recheck.mts"), path.join(dir, "lib", "guard-recheck.mts"));
  fs.writeFileSync(path.join(dir, "codex-hook-integrity.mts"), "console.log('all 2 files OK (0 restored), heartbeat refreshed');\n");
  const peers: Record<string, Record<string, string>> = {};
  for (const name of ["codex-hook-adapter.mts", "codex-shell-checks.mts"]) {
    const s = fs.statSync(path.join(dir, name), { bigint: true });
    peers[name] = { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), sha256: "fixture" };
  }
  const beat = path.join(root, ".cache", "hook-integrity", "heartbeat.json");
  fs.mkdirSync(path.dirname(beat), { recursive: true });
  fs.writeFileSync(beat, `${JSON.stringify({ peers })}\n`);
  const then = new Date(Date.now() - 31 * MIN);
  fs.utimesSync(beat, then, then);
  const guard = path.join(root, "orchestra", "control-plane", "node", "mcp-intent-hook.mts");
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  fs.writeFileSync(guard, ["import fs from 'node:fs';", "const input = JSON.parse(fs.readFileSync(0, 'utf8'));", guardBody].join("\n"));
  return { adapter, guard };
}

test("I8 installed layout with a stale heartbeat: the allow keeps its exact bytes, the notice goes to stderr", (t) => {
  const { adapter, guard } = installedBox(t, REWRITE);
  const run = runAdapter(intentArgs(guard), JSON.stringify(MCP), adapter);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, allowDoc(UUID));
  assert.match(run.stderr, /hook integrity re-check \(stale heartbeat, last OK [^)]+\):\n {2}- all 2 files OK/);
});

test("I8 installed layout with a stale heartbeat: the hook's deny keeps its exact bytes, no systemMessage", (t) => {
  const { adapter, guard } = installedBox(t, print(denyDoc("remote_mcp_intent_rejected")));
  const run = runAdapter(intentArgs(guard), JSON.stringify(MCP), adapter);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, denyDoc("remote_mcp_intent_rejected"));
  assert.match(run.stderr, /hook integrity re-check \(stale heartbeat/);
});
