// Shared in-process harness of daemon-intake-lane.test.mts and
// daemon-intake-log.test.mts (issue #441): the production daemon with a fake
// socket, fake intervals, a held session listing and fake readiness probes.
// No runtime CLI runs: listings and probes are injected, the owner probe and
// the loopback runtime discovery are stubbed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, type TestContext } from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope, type SessionInfo } from "../protocol.mts";
import type { TaskRuntime } from "../protocol-tasks.mts";
import { nodePaths, type NodeConfig, type NodePaths } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { defaultServiceOwnerProbe } from "./service-drain.mts";
import type { LivenessSource } from "./liveness-pass.mts";

export const NODE = "00000000-0000-4000-8000-0000000000aa";
export const PEER = "00000000-0000-4000-8000-0000000000bb";
export const messageId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

export const deliver = (n: number, toSession: string, options: { text?: string; createdAt?: string } = {}): string =>
  JSON.stringify(makeEnvelope("message.deliver", { messageId: messageId(n), from: { nodeId: PEER, session: "synthetic-peer" },
    toSession, text: options.text ?? "synthetic peer content", createdAt: options.createdAt ?? new Date().toISOString() }, 0, 0));
export const command = (seq: number, name: string): string =>
  JSON.stringify(makeEnvelope("command", { commandId: `c${seq}`, command: name }, seq, 0, `c${seq}`));
export const AUTH_OK = JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0));

type Listener = (event: { data?: string; code?: number }) => void;
export interface FakeSocket { index: number; sent: Envelope[]; message(raw: string): void; close(code?: number): void }

export interface HarnessOptions {
  policy?: Record<string, unknown>;
  probe?: (runtime: TaskRuntime) => Promise<ProbeResult>;
  daemonOptions?: { slowLaneMs?: number; intakeSlowMs?: number };
  livenessSource?: LivenessSource;
}

export function intakeHarness(t: TestContext, options: HarnessOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-intake-"));
  const paths: NodePaths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify(options.policy ?? { version: 1, allowedCommands: ["session.list"],
    sessions: { enabled: true, workspaceRoots: [root], runtimes: ["claude"] },
    messaging: { accept: [{ from: ["*"], session: "*" }] } }));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE, name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    timeout: globalThis.setTimeout, fetch: globalThis.fetch };
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, (() => void)[]>();
  const logs: string[] = [];
  // Issue #441: every frame on the wire must be a stamped, parseable envelope.
  const invalid: string[] = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    readonly listeners = new Map<string, Listener>();
    readonly handle: FakeSocket;
    constructor() {
      this.handle = { index: sockets.length, sent: [],
        message: (raw) => this.listeners.get("message")?.({ data: raw }), close: (code = 1006) => this.close(code) };
      sockets.push(this.handle);
      queueMicrotask(() => this.listeners.get("open")?.({}));
    }
    addEventListener(name: string, callback: Listener) { this.listeners.set(name, callback); }
    send(raw: string) {
      const parsed = parseEnvelope(raw);
      if (parsed.ok && parsed.envelope.seq >= 0) this.handle.sent.push(parsed.envelope);
      else invalid.push(raw.slice(0, 120));
    }
    close(code = 1000) { this.readyState = 3; this.listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    timers.set(ms, [...timers.get(ms) ?? [], callback]);
    return { unref() {} };
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  globalThis.fetch = async () => { throw new Error("synthetic endpoint unavailable"); };
  mock.method(defaultServiceOwnerProbe, "current", () => ({ version: 1 as const, pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z", owner: "S-1-5-21-1-2-3-1001" }));
  // Every listing waits until the test releases it; the release answers all of them.
  let releaseListing: (sessions: SessionInfo[]) => void = () => {};
  let listing = new Promise<SessionInfo[]>((resolve) => { releaseListing = resolve; });
  let listings = 0;
  const handle = startDaemon(config, paths, (line) => logs.push(line), async () => { listings++; return listing; },
    options.probe ?? (async () => ({ ok: true })), undefined, options.daemonOptions, undefined, options.livenessSource);
  t.after(() => {
    assert.deepEqual(invalid, [], "every frame on the wire parses with seq >= 0");
    releaseListing([]);
    handle.stop();
    mock.restoreAll();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    globalThis.setTimeout = original.timeout;
    globalThis.fetch = original.fetch;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    paths, logs, sockets, timers,
    socket: (): FakeSocket => { const last = sockets.at(-1); assert.ok(last); return last; },
    listings: () => listings,
    release: (sessions: SessionInfo[] = []) => {
      releaseListing(sessions);
      listing = new Promise<SessionInfo[]>((resolve) => { releaseListing = resolve; });
    },
    // Closes the current socket and runs the daemon's reconnect at once, without its backoff delay.
    reconnect: async (): Promise<FakeSocket> => {
      let scheduled: (() => void) | undefined;
      globalThis.setTimeout = ((callback: () => void) => { scheduled = callback; return { unref() {} }; }) as unknown as typeof setTimeout;
      try { sockets.at(-1)!.close(1006); } finally { globalThis.setTimeout = original.timeout; }
      assert.ok(scheduled, "the daemon schedules a reconnect");
      scheduled();
      await flush();
      return sockets.at(-1)!;
    },
  };
}

export const statuses = (socket: FakeSocket, id: string, state = "accepted"): Envelope[] =>
  socket.sent.filter((f) => f.type === "message.status" && (f.body as { messageId?: string; state?: string }).messageId === id
    && (f.body as { state?: string }).state === state);
