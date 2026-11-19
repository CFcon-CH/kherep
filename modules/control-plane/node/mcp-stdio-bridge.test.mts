import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, writeConfig } from "./config.mts";
import { recordMcpCredential } from "./mcp-local.mts";
import { isPrivateWindowsAcl, readPrivateMcpCredential, type CredentialPowerShellDeps } from "./mcp-credential-file.mts";
import { REAL_POWERSHELL, fakePowerShell } from "./mcp-credential-fixture.mts";
import { McpBridgeError, forwardMcpLine, type BridgeOptions } from "./mcp-stdio-bridge.mts";

const NODE = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "40000000-0000-4000-8000-000000000001";
const TOKEN_A = `synthetic-a-${"a".repeat(40)}`;
const TOKEN_B = `synthetic-b-${"b".repeat(40)}`;
// Supported Node 24.1.0 emits this exact warning when loading .mts files.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");

// Only the Windows verifier and the stdio test start the real helper (issue #219).
const CREDENTIAL: CredentialPowerShellDeps = { spawn: fakePowerShell().spawn };
const forward = (line: string, root: string, options: BridgeOptions = {}) =>
  forwardMcpLine(line, root, { credential: CREDENTIAL, ...options });

function fixture(t: test.TestContext, controlUrl = "wss://control.example.invalid/",
  credential: CredentialPowerShellDeps = CREDENTIAL) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl, nodeId: NODE, name: "synthetic",
    publicKey: "synthetic", privateKeyFile: path.join(paths.dir, "synthetic-key"),
    policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  recordMcpCredential(paths, { requestId: REQUEST, ok: true, token: TOKEN_A, version: 1 }, credential);
  return { root, paths };
}

function rpc(id: number | null = 1, meta: Record<string, unknown> | null = {
  sessionId: "session-a", threadId: "thread-a", callId: "call-a",
}): string {
  return JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method: "tools/call",
    params: { name: "sessions", arguments: { requestId: REQUEST }, ...(meta ? { _meta: meta } : {}) } });
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { ...init,
    headers: { "content-type": "application/json", ...init.headers } });
}

function code(error: unknown): string {
  assert.ok(error instanceof McpBridgeError);
  return error.code;
}

test("forwards native JSON-RPC metadata unchanged to the derived endpoint", async (t) => {
  const { root } = fixture(t);
  const native = JSON.parse(rpc()) as Record<string, unknown>;
  let captured: { url: string; init: RequestInit } | undefined;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured = { url: String(input), init: init ?? {} };
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  };

  const output = await forward(JSON.stringify(native), root, { fetch: fetchImpl });

  assert.equal(captured?.url, "https://control.example.invalid/mcp");
  assert.deepEqual(JSON.parse(String(captured?.init.body)), native);
  assert.equal((captured?.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN_A}`);
  assert.equal(captured?.init.redirect, "error");
  assert.deepEqual(output.map((value) => JSON.parse(value)), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});

test("does not synthesize missing native metadata", async (t) => {
  const { root } = fixture(t);
  let request: Record<string, unknown> | undefined;
  const denial = { jsonrpc: "2.0", id: 1, result: { isError: true,
    content: [{ type: "text", text: "verified Codex native call metadata is required" }] } };
  const output = await forward(rpc(1, null), root, { fetch: async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse(denial);
  } });
  assert.equal(Object.hasOwn((request?.params as Record<string, unknown>), "_meta"), false);
  assert.deepEqual(output.map((value) => JSON.parse(value)), [denial]);
});

test("reloads the credential and policy for every HTTP call", async (t) => {
  const { root, paths } = fixture(t);
  const authorizations: string[] = [];
  let calls = 0;
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls += 1;
    authorizations.push((init?.headers as Record<string, string>).Authorization);
    return jsonResponse({ jsonrpc: "2.0", id: calls, result: {} });
  };
  await forward(rpc(1), root, { fetch: fetchImpl });
  recordMcpCredential(paths, { requestId: REQUEST, ok: true, token: TOKEN_B, version: 2 }, CREDENTIAL);
  await forward(rpc(2), root, { fetch: fetchImpl });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
  await assert.rejects(forward(rpc(3), root, { fetch: fetchImpl }),
    (error) => code(error) === "remote_mcp_disabled");
  assert.deepEqual(authorizations, [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
  assert.equal(calls, 2);
});

test("fails closed for missing, invalid and unsafe-mode credentials before HTTP", async (t) => {
  const { root, paths } = fixture(t);
  let calls = 0;
  const invoke = () => forward(rpc(), root, { fetch: async () => {
    calls += 1; return jsonResponse({});
  } });

  fs.rmSync(paths.mcpCredential);
  await assert.rejects(invoke(), (error) => code(error) === "remote_mcp_credential_unavailable");
  recordMcpCredential(paths, { requestId: REQUEST, ok: true, token: TOKEN_A, version: 1 }, CREDENTIAL);
  fs.writeFileSync(paths.mcpCredential, "not-json", { mode: 0o600 });
  await assert.rejects(invoke(), (error) => code(error) === "remote_mcp_credential_invalid");
  if (process.platform !== "win32") {
    fs.rmSync(paths.mcpCredential);
    recordMcpCredential(paths, { requestId: REQUEST, ok: true, token: TOKEN_A, version: 1 }, CREDENTIAL);
    fs.chmodSync(paths.mcpCredential, 0o644);
    await assert.rejects(invoke(), (error) => code(error) === "remote_mcp_credential_unsafe");
  }
  assert.equal(calls, 0);
});

test("rejects a credential symlink before HTTP", async (t) => {
  const { root, paths } = fixture(t);
  fs.rmSync(paths.mcpCredential);
  fs.writeFileSync(path.join(root, "synthetic-credential.json"),
    JSON.stringify({ requestId: REQUEST, ok: true, token: TOKEN_A, version: 1 }), { mode: 0o600 });
  try { fs.symlinkSync(path.join(root, "synthetic-credential.json"), paths.mcpCredential); } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
      return t.skip("Windows fixture requires symbolic-link privilege");
    throw error;
  }
  let calls = 0; const invoke = () => forward(rpc(), root, { fetch: async () => {
    calls += 1; return jsonResponse({});
  } });
  await assert.rejects(invoke(), (error) => code(error) === "remote_mcp_credential_unsafe");
  assert.equal(calls, 0);
});

test("handles JSON, SSE and notification responses without transport metadata", async (t) => {
  const { root } = fixture(t, "https://control.example.invalid/");
  const sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
  const event = await forward(rpc(), root, { fetch: async () => new Response(sse,
    { headers: { "content-type": "text/event-stream; charset=utf-8" } }) });
  assert.deepEqual(event.map((value) => JSON.parse(value)), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);

  const notification = await forward(rpc(null), root, {
    fetch: async () => new Response(null, { status: 202 }),
  });
  assert.deepEqual(notification, []);
  await assert.rejects(forward(rpc(), root, {
    fetch: async () => new Response(null, { status: 202 }),
  }), (error) => code(error) === "remote_mcp_response_invalid");
});

test("returns fixed transport errors without exposing credentials", async (t) => {
  const { root } = fixture(t);
  const cases: Array<[() => Promise<Response>, string]> = [
    [async () => { throw new Error(`failed with ${TOKEN_A}`); }, "remote_mcp_transport_failed"],
    [async () => new Response("denied", { status: 401 }), "remote_mcp_transport_rejected"],
    [async () => new Response("text", { headers: { "content-type": "text/plain" } }), "remote_mcp_response_invalid"],
    [async () => new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
      "remote_mcp_response_too_large"],
  ];
  for (const [fetchCase, expected] of cases) {
    await assert.rejects(forward(rpc(), root, { fetch: fetchCase }), (error) => {
      assert.equal(code(error), expected);
      assert.doesNotMatch(String((error as Error).message), new RegExp(TOKEN_A));
      return true;
    });
  }
});

test("bounds input and deadline failures with fixed error codes", async (t) => {
  const { root } = fixture(t);
  await assert.rejects(forward(`{"jsonrpc":"2.0","id":1,"padding":"${"x".repeat(256 * 1024)}"}`, root),
    (error) => code(error) === "remote_mcp_input_too_large");
  await assert.rejects(forward(rpc(), root, { timeoutMs: 5, fetch: async (_input, init) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort",
      () => reject(new DOMException("synthetic", "AbortError")), { once: true }));
    throw new Error("unreachable");
  } }), (error) => code(error) === "remote_mcp_transport_timeout");
});

test("deadline cancels JSON and SSE bodies that never end after headers", async (t) => {
  const { root } = fixture(t);
  for (const contentType of ["application/json", "text/event-stream"]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    await assert.rejects(forward(rpc(), root, { timeoutMs: 5,
      fetch: async () => new Response(body, { headers: { "content-type": contentType } }) }),
    (error) => code(error) === "remote_mcp_transport_timeout");
    assert.equal(cancelled, true, contentType);
  }
});

test("Windows ACL contract accepts only current-user, SYSTEM and administrators readers", () => {
  const own = "S-1-5-21-1000";
  const rule = (sid: string, allow = true, rights = 1) => ({ sid, allow, rights });
  assert.equal(isPrivateWindowsAcl({ user: own, owner: own, rules: [
    rule(own), rule("S-1-5-18"), rule("S-1-5-32-544"),
  ] }), true);
  assert.equal(isPrivateWindowsAcl({ user: own, owner: "S-1-5-18", rules: [rule(own)] }), false);
  assert.equal(isPrivateWindowsAcl({ user: own, owner: own, rules: [rule(own), rule("S-1-5-32-545")] }), false);
  assert.equal(isPrivateWindowsAcl({ user: own, owner: own, rules: [rule(own, true, 0)] }), false);
});

test("Windows verifier reads a private credential and rejects a broad Users grant",
  { skip: process.platform !== "win32" }, (t) => {
    const { paths } = fixture(t, undefined, REAL_POWERSHELL);
    const windows = process.env.SystemRoot || process.env.WINDIR || "";
    const powershell = path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = { SystemRoot: windows, WINDIR: windows, KHEREP_MCP_TEST_FILE: paths.mcpCredential };
    // The real credential writer in fixture() already created the protected DACL.
    assert.equal(readPrivateMcpCredential(paths.mcpCredential, "win32", REAL_POWERSHELL).ok, true);

    const broadAcl = String.raw`
$file = [Environment]::GetEnvironmentVariable('KHEREP_MCP_TEST_FILE', 'Process')
$acl = [IO.File]::GetAccessControl($file, [Security.AccessControl.AccessControlSections]::Access)
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Allow))
[IO.File]::SetAccessControl($file, $acl)
`;
    const broadened = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", broadAcl],
      { encoding: "utf8", windowsHide: true, env });
    assert.equal(broadened.status, 0, broadened.stderr);
    assert.deepEqual(readPrivateMcpCredential(paths.mcpCredential, "win32", REAL_POWERSHELL),
      { ok: false, code: "remote_mcp_credential_unsafe" });
  });

test("stdio errors and arguments never expose credential material", (t) => {
  // The child's Windows ACL check runs the real helper under its production limit.
  const { root, paths } = fixture(t, undefined, REAL_POWERSHELL);
  fs.writeFileSync(paths.mcpCredential, JSON.stringify({ token: TOKEN_A }), { mode: 0o600 });
  const args = [path.join(import.meta.dirname, "mcp-stdio-bridge.mts"), "--config-root", root];
  assert.equal(args.some((value) => value.includes(TOKEN_A)), false);
  const result = spawnSync(process.execPath, args, { input: `${rpc()}\n`, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { jsonrpc: "2.0", id: 1,
    error: { code: -32000, message: "remote_mcp_credential_invalid" } });
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(TOKEN_A));

  const oversized = spawnSync(process.execPath, args, {
    input: `{"jsonrpc":"2.0","id":1,"padding":"${"x".repeat(256 * 1024)}"}`,
    encoding: "utf8",
  });
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stderr.replace(TYPE_STRIPPING_WARNING, "").trim(), "remote_mcp_input_too_large");
  assert.equal(oversized.stdout, "");
  assert.doesNotMatch(`${oversized.stdout}\n${oversized.stderr}`, new RegExp(TOKEN_A));
});

test("the bridge allows ws loopback but rejects insecure or non-origin endpoints before sending credentials", async t => {
  const { root, paths } = fixture(t, "ws://127.0.0.1:8765/");
  const requests: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => { requests.push(String(input)); return jsonResponse({ result: {} }); };
  await forward(rpc(), root, { fetch: fetchImpl });
  assert.deepEqual(requests, ["http://127.0.0.1:8765/mcp"]);

  const base = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  for (const controlUrl of ["not a URL", "ws://control.example.invalid/", "https://control.example.invalid/prefix",
    "https://control.example.invalid/?q=1", "https://control.example.invalid/#fragment", "https://synthetic@control.example.invalid/"]) {
    writeConfig(paths.config, { ...base, controlUrl });
    await assert.rejects(forward(rpc(), root, { fetch: fetchImpl }), { code: "remote_mcp_config_invalid" });
  }
  assert.deepEqual(requests, ["http://127.0.0.1:8765/mcp"]);
});

test("stdio keeps request IDs across CRLF and final unterminated lines, while notifications stay silent", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-stdio-empty-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(import.meta.dirname, "mcp-stdio-bridge.mts");
  const invalid = spawnSync(process.execPath, [bridge, "--config-root", "relative"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.replace(TYPE_STRIPPING_WARNING, "").trim(), "remote_mcp_invalid_arguments");

  const notifications = JSON.stringify([JSON.parse(rpc(null)), JSON.parse(rpc(null))]);
  const run = spawnSync(process.execPath, [bridge, "--config-root", root], { encoding: "utf8", timeout: 10_000,
    input: `\r\n${rpc(7)}\r\n${notifications}\r\nbad JSON\r\n${rpc(8)}` });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr.replace(TYPE_STRIPPING_WARNING, "").trim(), "");
  const unavailable = { code: -32000, message: "remote_mcp_config_unavailable" };
  assert.deepEqual(run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)), [
    { jsonrpc: "2.0", id: 7, error: unavailable },
    { jsonrpc: "2.0", id: null, error: { code: -32000, message: "remote_mcp_input_invalid" } },
    { jsonrpc: "2.0", id: 8, error: unavailable },
  ]);
});
