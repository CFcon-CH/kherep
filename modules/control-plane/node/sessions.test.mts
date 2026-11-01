import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type SessionInfo } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { generateIdentity } from "./identity.mts";
import { DEFAULT_POLICY } from "./policy.mts";
import { CLAUDE_RUNTIME, claudeInvocation, execFileText, LIST_TIMEOUT_MS, listSessions, mapClaudeAgents, nativeClaude } from "./sessions.mts";

const STARTED = Date.UTC(2026, 0, 2, 3, 4, 5);
const ROW = { pid: 4242, cwd: "/work/repo", kind: "interactive", startedAt: STARTED, sessionId: "0f0e0d0c-1111-4222-8333-444455556666",
  name: "review", status: "running", extra: { ignored: true } };

test("maps claude agents rows to session info and ignores unknown fields", () => {
  assert.deepEqual(mapClaudeAgents([ROW]), [{
    sessionId: ROW.sessionId, runtime: CLAUDE_RUNTIME, state: "running", startedAt: new Date(STARTED).toISOString(),
    name: "review", cwd: "/work/repo", kind: "interactive",
  }]);
  // Optional fields that are missing or out of bounds are left out, not guessed.
  assert.deepEqual(mapClaudeAgents([{ sessionId: "s2", status: "idle", name: "n".repeat(129), startedAt: "yesterday" }]),
    [{ sessionId: "s2", runtime: CLAUDE_RUNTIME, state: "idle-loaded" }]);
});

test("skips malformed rows and fails only on output that is not a list", () => {
  const rows = [null, 7, "x", {}, { sessionId: "", status: "running" }, { sessionId: "s1" }, { sessionId: "s1", status: 3 }, ROW];
  assert.deepEqual(mapClaudeAgents(rows)?.map((s) => s.sessionId), [ROW.sessionId]);
  assert.equal(mapClaudeAgents({ sessions: [] }), null);
});

async function invoked(resolved: string, platform: NodeJS.Platform): Promise<unknown[]> {
  const calls: unknown[] = [];
  const sessions = await listSessions({
    findClaude: () => resolved, platform, comSpec: "C:\\Windows\\system32\\cmd.exe",
    exec: async (file, args, options) => { calls.push([file, args, options]); return JSON.stringify([ROW]); },
  });
  assert.equal(sessions.length, 1);
  return calls;
}

test("runs claude agents --json directly, without a shell, for an executable", async () => {
  const direct = (file: string) => [[file, ["agents", "--json"], { timeout: LIST_TIMEOUT_MS }]];
  assert.deepEqual(await invoked("/opt/bin/claude", "linux"), direct("/opt/bin/claude"));
  assert.deepEqual(await invoked("C:\\tools\\claude.exe", "win32"), direct("C:\\tools\\claude.exe"));
  assert.deepEqual(await invoked("C:\\tools\\claude", "win32"), direct("C:\\tools\\claude"));
  // A .cmd name only means a shim on Windows.
  assert.deepEqual(await invoked("/opt/bin/claude.cmd", "darwin"), direct("/opt/bin/claude.cmd"));
});

test("runs a Windows npm shim through cmd.exe with a fixed command line", async () => {
  const shim = "C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd";
  assert.deepEqual(await invoked(shim, "win32"), [["C:\\Windows\\system32\\cmd.exe",
    ["/d", "/s", "/c", `"${shim}" agents --json`], { timeout: LIST_TIMEOUT_MS, windowsVerbatimArguments: true }]]);
  assert.equal(claudeInvocation("C:\\npm\\CLAUDE.BAT", "win32", "cmd.exe").file, "cmd.exe");
  assert.throws(() => claudeInvocation("C:\\%PATH%\\claude.cmd", "win32"), /not safe/);
});

test("claude not on PATH contributes no sessions and runs nothing", async () => {
  let ran = false;
  assert.deepEqual(await listSessions({ findClaude: () => null, exec: async () => { ran = true; return "[]"; } }), []);
  assert.equal(ran, false);
});

test("a failing, timed out or non-JSON listing rejects instead of reporting no sessions", async () => {
  const claude = () => "/opt/bin/claude";
  await assert.rejects(listSessions({ findClaude: claude, exec: async () => { throw new Error("spawn EACCES"); } }), /claude agents failed: spawn EACCES/);
  await assert.rejects(listSessions({ findClaude: claude, exec: async () => { throw new Error("timed out"); } }), /claude agents failed/);
  await assert.rejects(listSessions({ findClaude: claude, exec: async () => "Error: not logged in" }), /no JSON/);
  await assert.rejects(listSessions({ findClaude: claude, exec: async () => "{}" }), /no session list/);
});

test("native discovery cancellation reaches the executable and never returns a late population", async () => {
  const controller = new AbortController();
  await assert.rejects(listSessions({ findClaude: () => "/opt/bin/claude", signal: controller.signal,
    exec: async (_file, _args, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort();
      return JSON.stringify([ROW]);
    },
  }), /abort/i);
});

test("native discovery rejects cancellation only after the started helper is closed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-session-abort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pidFile = path.join(root, "pid");
  const controller = new AbortController();
  const pending = execFileText(process.execPath,
    // The helper publishes its pid with an atomic rename, so a pid file that exists is complete.
    ["-e", "const fs=require('node:fs');fs.writeFileSync(process.argv[1]+'.tmp',String(process.pid));fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);setTimeout(()=>{},30000)", pidFile],
    { timeout: 10_000, signal: controller.signal });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : "<missing>";
  const pid = Number(raw);
  assert.ok(Number.isInteger(pid) && pid > 0, `the helper published its pid, got ${JSON.stringify(raw)}`);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the listing promise cannot release its admission before process close");
});

function client(sessions: () => Promise<SessionInfo[]>) {
  const identity = generateIdentity();
  const results = { log: [] as string[] };
  const node = new NodeClient({
    nodeId: "00000000-0000-4000-8000-0000000000aa", identity, policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": sessions },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions, storeMessage: () => {}, log: (line) => results.log.push(line),
  });
  return { node, results };
}

const types = (frames: string[]) => frames.map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return p.envelope.type; });
const authOk = JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0));

test("sends a sessions snapshot on register and afterwards only when the list changed", async () => {
  let list: SessionInfo[] = [{ sessionId: "s1", runtime: CLAUDE_RUNTIME, state: "running" }];
  const { node } = client(async () => list);
  assert.deepEqual(await node.sessionsSnapshot(), []); // not authenticated
  assert.deepEqual(types(await node.onFrame(authOk)), ["register", "sessions.snapshot", "directory.get"]);
  assert.deepEqual(await node.sessionsSnapshot(), []);
  list = [...list, { sessionId: "s2", runtime: CLAUDE_RUNTIME, state: "idle-loaded" }];
  assert.deepEqual(types(await node.sessionsSnapshot()), ["sessions.snapshot"]);
  assert.deepEqual(await node.sessionsSnapshot(), []);
  // A new connection registers again with a fresh snapshot.
  node.connectionClosed();
  assert.deepEqual(types(await node.onFrame(authOk)), ["register", "sessions.snapshot", "directory.get"]);
});

test("a failed listing skips the snapshot and fails session.list with the reason", async () => {
  let fail = false;
  const { node, results } = client(async () => {
    if (fail) throw new Error("claude agents failed: timed out");
    return [{ sessionId: "s1", runtime: CLAUDE_RUNTIME, state: "running" }];
  });
  await node.onFrame(authOk);
  fail = true;
  assert.deepEqual(await node.sessionsSnapshot(), []);
  assert.match(results.log.join("\n"), /snapshot skipped: claude agents failed: timed out/);
  const out = (await node.onFrame(JSON.stringify(makeEnvelope("command", { commandId: "c1", command: "session.list" }, 1, 0, "c1"))))
    .map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return p.envelope; });
  assert.deepEqual(out[1].body, { commandId: "c1", ok: false, error: "claude agents failed: timed out" });
  // Registering while the listing fails sends no snapshot either.
  node.connectionClosed();
  assert.deepEqual(types(await node.onFrame(authOk)), ["register", "directory.get"]);
});

test("an npm shim resolves to the native executable next to it, so no prompt passes through cmd.exe", () => {
  const shim = String.raw`C:\Users\u\AppData\Roaming\npm\claude.cmd`;
  const native = String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`;
  assert.equal(nativeClaude(shim, (file) => file === native), native);
  assert.equal(nativeClaude(shim, () => false), shim);
  assert.equal(nativeClaude("/usr/local/bin/claude", () => true), "/usr/local/bin/claude");
});
