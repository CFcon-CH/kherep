import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { makeEnvelope, PING_FRAME, PONG_FRAME } from "../protocol.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { FakeClock, flush } from "./connection-test-fixture.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { NodeClient } from "./client.mts";
import { DIRECTORY_INTERVAL_MS } from "./exchange.mts";

export async function heartbeatFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-heartbeat-")), clock = new FakeClock();
  const paths = nodePaths(root), logs: string[] = [], sockets: FakeSocket[] = [];
  const original = { ws: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval, random: Math.random };
  const intervals = new Map<number, () => void>();
  let rejectDirectory = false, resets = 0;
  const directoryRequest = NodeClient.prototype.directoryRequest, connectionClosed = NodeClient.prototype.connectionClosed;
  mock.method(NodeClient.prototype, "directoryRequest", function (this: NodeClient) {
    if (rejectDirectory) { rejectDirectory = false; throw new Error("synthetic chain rejection"); }
    return directoryRequest.call(this);
  });
  mock.method(NodeClient.prototype, "connectionClosed", function (this: NodeClient) {
    resets++; connectionClosed.call(this);
  });
  // Confine every discovery and process operation to synthetic fixtures.
  mock.method(os, "homedir", () => root);
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const)
    mock.method(cp, method, () => { throw new Error("forbidden native process"); });
  mock.method(process, "kill", () => { throw new Error("forbidden process probe"); });
  mock.method(globalThis, "fetch", () => { throw new Error("forbidden network"); });
  syncBuiltinESMExports();
  const source = await import("./daemon-source.mts");
  mock.module(new URL("./daemon-source.mts", import.meta.url).href, { namedExports: { ...source,
    captureRuntimeSourceIdentity: () => ({ root, commit: "0".repeat(40), digest: "0".repeat(64), kind: "checkout", verified: true }),
  } });
  let discoveryResolve!: (rows: []) => void, discoverySignal: AbortSignal | undefined;
  let blockDiscovery = false, blockRuntime = false, runtimeResolve!: (rows: []) => void;
  const discovery = await import("./discovery.mts");
  mock.module(new URL("./discovery.mts", import.meta.url).href, { namedExports: { ...discovery,
    detectFacts: () => ({ hostname: "synthetic.example.invalid", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    discoverRuntimes: () => blockRuntime ? new Promise<[]>(resolve => { runtimeResolve = resolve; }) : Promise.resolve([]),
  } });
  const { startDaemon } = await import("./daemon.mts");
  class FakeSocket {
    static OPEN = 1; readyState = 0; sent: string[] = []; closes = 0; failSend = false;
    listeners = new Map<string, (event: { data?: unknown; code?: number; wasClean?: boolean }) => void>();
    constructor() { sockets.push(this); }
    addEventListener(name: string, listener: (event: { data?: unknown; code?: number }) => void): void { this.listeners.set(name, listener); }
    emit(name: string, event: { data?: unknown; code?: number; wasClean?: boolean } = {}): void { this.listeners.get(name)?.(event); }
    open(): void { this.readyState = 1; this.emit("open"); }
    receive(data: unknown): void { this.emit("message", { data }); }
    send(data: string): void { if (this.failSend) throw new Error("synthetic send failure"); this.sent.push(data); }
    // Deliberately never emit close. Timeout and stop must not wait for it.
    close(): void { this.closes++; this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.setInterval = ((run: () => void, ms: number) => { intervals.set(ms, run); return { ms }; }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: { ms: number }) => { intervals.delete(timer.ms); }) as unknown as typeof clearInterval;
  Math.random = () => 0;
  const identity = generateIdentity(); fs.mkdirSync(paths.dir, { recursive: true }); writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic", publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() };
  const handle = startDaemon(config, paths, line => logs.push(line), signal => {
    discoverySignal = signal;
    return blockDiscovery ? new Promise<[]>(resolve => { discoveryResolve = resolve; }) : Promise.resolve([]);
  }, undefined, undefined, {}, { fallbackMs: 2_000_000 }, undefined, clock);
  return { clock, sockets, logs, paths, intervals, handle,
    rejectChain: () => { rejectDirectory = true; intervals.get(DIRECTORY_INTERVAL_MS)!(); }, resets: () => resets,
    auth: (socket = sockets.at(-1)!) => socket.receive(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))),
    blockDiscovery: () => { blockDiscovery = true; }, discoverySignal: () => discoverySignal,
    releaseDiscovery: () => { blockDiscovery = false; discoveryResolve?.([]); },
    blockRuntime: () => { blockRuntime = true; }, releaseRuntime: () => { blockRuntime = false; runtimeResolve?.([]); },
    async close() {
      blockDiscovery = false; discoveryResolve?.([]); blockRuntime = false; runtimeResolve?.([]);
      handle.stop(); await handle.done; await flush();
      assert.equal(clock.timers.size, 0); assert.equal(intervals.size, 0);
      globalThis.WebSocket = original.ws; globalThis.setInterval = original.interval; globalThis.clearInterval = original.clear;
      Math.random = original.random; mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export { PING_FRAME, PONG_FRAME, flush };
