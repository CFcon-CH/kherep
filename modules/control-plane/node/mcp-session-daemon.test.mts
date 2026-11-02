import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type SessionInfo } from "../protocol.mts";
import { MESSAGING_ACK_CAPABILITY, MESSAGING_PROGRESS_V2_CAPABILITY } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon, SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { getMessage, storeMessage, UNDELIVERABLE_AFTER_MS } from "./inbox.mts";
import { knownSessionsFile } from "./known-sessions.mts";
import { enqueueMcpIntent } from "./mcp-local.mts";
import { loadPolicy } from "./policy.mts";
import { beginServiceDrain } from "./service-drain.mts";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const OLD: SessionInfo = { sessionId: "session-old", runtime: "codex", state: "idle" };
const normalized = (rows: SessionInfo[]) => rows.map(row => ({ ...row, state: "unknown" }));
const NEW: SessionInfo = { sessionId: "session-new", runtime: "codex", state: "working" };
const decode = (frame: string) => {
  const parsed = parseEnvelope(frame);
  assert.ok(parsed.ok);
  return parsed.envelope;
};

async function fixture(t: test.TestContext, options: { initialGate?: Promise<void> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-session-daemon-"));
  const paths = nodePaths(root), identity = generateIdentity();
  fs.mkdirSync(paths.dir, { recursive: true });
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid",
    nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval,
    clear: globalThis.clearInterval, frame: NodeClient.prototype.onFrame, refresh: NodeClient.prototype.refreshPolicy };
  const timers = new Map<number, (() => void)[]>(), frames: string[] = [], logs: string[] = [];
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  let sessions = [OLD], reads = 0, gate: Promise<void> | undefined = options.initialGate;
  let signal: AbortSignal | undefined, policyGate: Promise<void> | undefined;
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true,
    value: class {
      static OPEN = 1; static CONNECTING = 0;
      readyState = 1;
      addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
      send(frame: string) { frames.push(frame); }
      close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
    } });
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    timers.set(ms, [...timers.get(ms) ?? [], callback]); return { interval: ms };
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  // Stub authentication only. Discovery, policy-file reads, registration,
  // snapshots, scheduling and recording use the production daemon path.
  NodeClient.prototype.onFrame = async function (raw) {
    if (raw !== "synthetic-auth-ok") return original.frame.call(this, raw);
    this.authenticated = true;
    const registration = await this.refreshPolicy(loadPolicy(paths.policy));
    return options.initialGate ? registration : [...registration, ...await this.sessionsSnapshot()];
  };
  NodeClient.prototype.refreshPolicy = async function (policy) {
    await policyGate;
    return original.refresh.call(this, policy);
  };
  const handle = startDaemon(config, paths, line => logs.push(line), async aborted => {
    reads++; signal = aborted; const found = sessions; await gate; return found;
  });
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.onFrame = original.frame;
    NodeClient.prototype.refreshPolicy = original.refresh;
    fs.rmSync(root, { recursive: true, force: true });
  });
  listeners.get("open")?.({});
  listeners.get("message")?.({ data: "synthetic-auth-ok" });
  await flush();
  frames.length = 0; reads = 0;
  const tick = timers.get(EXCHANGE_INTERVAL_MS)?.[0];
  assert.ok(tick);
  const snapshotTick = timers.get(SESSIONS_INTERVAL_MS)?.[0];
  assert.ok(snapshotTick);
  return { paths, frames, logs, tick, snapshotTick, reads: () => reads, signal: () => signal,
    hold: (value: Promise<void> | undefined) => { gate = value; }, sessions: (value: SessionInfo[]) => { sessions = value; },
    holdPolicy: (value: Promise<void> | undefined) => { policyGate = value; },
    receive: (raw: string) => listeners.get("message")?.({ data: raw }) };
}

function enqueue(f: Awaited<ReturnType<typeof fixture>>) {
  enqueueMcpIntent(f.paths, { requestId: "40000000-0000-4000-8000-000000000001", runtime: "codex",
    sessionId: NEW.sessionId, callId: "synthetic-native-call", tool: "status", argumentsDigest: "a".repeat(64) });
}

test("the daemon reloads a policy-file revocation after discovery and sends no native frames", async t => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  enqueue(f); f.tick(); await flush();
  assert.equal(f.reads(), 1);
  fs.writeFileSync(f.paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
  release(); await flush();
  const frames = f.frames.map(decode);
  assert.deepEqual(frames.map(frame => frame.type), ["register"]);
  assert.deepEqual((frames[0]!.body as { capabilities: unknown }).capabilities, [MESSAGING_ACK_CAPABILITY, MESSAGING_PROGRESS_V2_CAPABILITY]);
});

test("the daemon publishes the one complete discovery result before the intent with ascending seq", async t => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  enqueue(f); f.tick(); await flush();
  const frames = f.frames.map(decode);
  assert.deepEqual(frames.map(frame => frame.type), ["sessions.snapshot", "mcp.intent.register"]);
  assert.deepEqual(frames[0]!.body, { sessions: normalized([OLD, NEW]) });
  assert.ok(frames[0]!.seq < frames[1]!.seq);
  assert.equal(f.reads(), 1);
});

test("service drain defers periodic discovery without publishing an empty snapshot", async t => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  const endDrain = beginServiceDrain(f.paths);
  f.snapshotTick();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.frames, []);
  endDrain();
  await new Promise(resolve => setTimeout(resolve, 40));
  await flush();
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["sessions.snapshot"]);
});

test("service drain defers command discovery and resumes the same command after release", async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.paths.policy, JSON.stringify({ version: 1, allowedCommands: ["session.list"], remoteMcp: { enabled: true } }));
  f.sessions([OLD, NEW]);
  const endDrain = beginServiceDrain(f.paths);
  f.receive(JSON.stringify(makeEnvelope("command", { commandId: "drained-list", command: "session.list" }, 1, 0)));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.reads(), 0);
  assert.equal(f.frames.map(frame => decode(frame).type).includes("command.result"), false);
  endDrain();
  await new Promise(resolve => setTimeout(resolve, 40));
  await flush();
  assert.equal(f.reads(), 1);
  const result = f.frames.map(decode).find(frame => frame.type === "command.result");
  assert.deepEqual((result?.body as { result?: unknown }).result, normalized([OLD, NEW]));
});

test("timed out daemon discovery cannot publish or rewrite any session cache after late completion", async t => {
  const f = await fixture(t);
  const files = [f.paths.sessions, knownSessionsFile(f.paths)];
  const before = files.map(file => fs.readFileSync(file, "utf8"));
  f.sessions([OLD, NEW]);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  enqueue(f); f.tick(); await flush();
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(f.signal()?.aborted, true);
  assert.ok(f.logs.some(line => line.includes("MCP_SESSION_DISCOVERY_TIMEOUT")));
  release(); await flush();
  assert.deepEqual(f.frames, []);
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), before);
});

test("a blocked periodic listing does not postpone a new caller or overwrite its later snapshot", async t => {
  const f = await fixture(t);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  f.snapshotTick(); await flush();
  const periodicSignal = f.signal();
  f.hold(undefined); f.sessions([OLD, NEW]);
  enqueue(f); f.tick(); await flush();
  const beforeRelease = f.frames.map(decode);
  const cached = fs.readFileSync(f.paths.sessions, "utf8");
  release(); await flush();
  assert.deepEqual(beforeRelease.map(frame => frame.type), ["sessions.snapshot", "mcp.intent.register"]);
  assert.ok(beforeRelease[0]!.seq < beforeRelease[1]!.seq);
  assert.equal(periodicSignal?.aborted, true);
  assert.equal(f.frames.length, 2);
  assert.equal(fs.readFileSync(f.paths.sessions, "utf8"), cached);
});

test("a completed periodic read cannot record stale sessions ahead of its queued publication", async t => {
  const f = await fixture(t);
  const messageId = "50000000-0000-4000-8000-000000000001";
  storeMessage(f.paths.inbox, { messageId, from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" },
    toSession: OLD.sessionId, text: "synthetic message", createdAt: new Date(0).toISOString() }, Date.now() - UNDELIVERABLE_AFTER_MS - 1);
  const files = [f.paths.sessions, knownSessionsFile(f.paths)], before = files.map(file => fs.readFileSync(file, "utf8"));
  let release!: () => void;
  f.holdPolicy(new Promise<void>(resolve => { release = resolve; }));
  f.tick(); await flush();
  enqueue(f); f.sessions([]); f.snapshotTick(); await flush();
  const beforeRelease = files.map(file => fs.readFileSync(file, "utf8"));
  const messageBeforeRelease = getMessage(f.paths.inbox, messageId)?.state;
  f.sessions([OLD, NEW]); f.holdPolicy(undefined);
  release(); await flush();
  assert.deepEqual(beforeRelease, before, "recording effects must wait for the publication lane");
  assert.equal(messageBeforeRelease, "accepted");
  assert.equal(getMessage(f.paths.inbox, messageId)?.state, "accepted");
  assert.deepEqual(f.frames.map(frame => decode(frame).type).filter(type => type !== "message.status"), ["sessions.snapshot", "mcp.intent.register"]);
  const cached = JSON.parse(fs.readFileSync(f.paths.sessions, "utf8"));
  assert.deepEqual(cached.sessions.map((session: SessionInfo) => session.sessionId), [OLD.sessionId, NEW.sessionId]);
});

test("an ordinary session.list cancels an older periodic read before it can record or publish", async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.paths.policy, JSON.stringify({ version: 1, allowedCommands: ["session.list"], remoteMcp: { enabled: true } }));
  const messageId = "50000000-0000-4000-8000-000000000002";
  storeMessage(f.paths.inbox, { messageId, from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" },
    toSession: OLD.sessionId, text: "synthetic message", createdAt: new Date(0).toISOString() }, Date.now() - UNDELIVERABLE_AFTER_MS - 1);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  f.sessions([]); f.snapshotTick(); await flush();
  const periodicSignal = f.signal();
  f.hold(undefined); f.sessions([OLD, NEW]);
  f.receive(JSON.stringify(makeEnvelope("command", { commandId: "ordinary-list", command: "session.list" }, 1, 0)));
  await flush();
  const beforeRelease = f.frames.map(decode), files = [f.paths.sessions, knownSessionsFile(f.paths)];
  const cached = files.map(file => fs.readFileSync(file, "utf8"));
  release(); await flush();
  assert.deepEqual(beforeRelease.map(frame => frame.type), ["register", "command.ack", "command.result"]);
  assert.deepEqual((beforeRelease[2]!.body as { result: unknown }).result, normalized([OLD, NEW]));
  assert.equal(periodicSignal?.aborted, true);
  assert.equal(f.frames.length, beforeRelease.length);
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), cached);
  assert.equal(getMessage(f.paths.inbox, messageId)?.state, "accepted");
});

test("an ordinary session.list cancels a stale initial read before it can overwrite the newer result", async t => {
  let releaseInitial!: () => void;
  const f = await fixture(t, { initialGate: new Promise<void>(resolve => { releaseInitial = resolve; }) });
  fs.writeFileSync(f.paths.policy, JSON.stringify({ version: 1, allowedCommands: ["session.list"], remoteMcp: { enabled: true } }));
  const initialSignal = f.signal();
  assert.ok(initialSignal, "authentication starts the initial listing");

  f.hold(undefined);
  f.sessions([OLD, NEW]);
  f.receive(JSON.stringify(makeEnvelope("command", { commandId: "newer-list", command: "session.list" }, 1, 0)));
  await flush();
  const beforeRelease = f.frames.map(decode);
  assert.deepEqual(beforeRelease.map(frame => frame.type), ["register", "command.ack", "command.result"]);
  assert.deepEqual((beforeRelease[2]!.body as { result: unknown }).result, normalized([OLD, NEW]));
  assert.equal(initialSignal.aborted, true);
  const cached = fs.existsSync(f.paths.sessions) ? fs.readFileSync(f.paths.sessions, "utf8") : undefined;

  releaseInitial();
  await flush();
  assert.deepEqual(f.frames.map(decode), beforeRelease);
  assert.equal(fs.existsSync(f.paths.sessions) ? fs.readFileSync(f.paths.sessions, "utf8") : undefined, cached);
});
