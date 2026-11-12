import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseEnvelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER, PEER } from "./codex-fork-fixture.mts";
import { relayNode } from "./codex-fork-relay-fixture.mts";
import { codexQueueIdle } from "./codex-queue.mts";
import type { NodeConfig } from "./config.mts";
import { startDaemon, type DaemonHandle } from "./daemon.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import type { ProbeResult } from "./runtime-probe.mts";

// Issue #890 (retirement R3), replacing the #444 gate test: the daemon wires no
// proxy send gate and its poll starts no fork. With wake.codexFork set, an idle
// wake-listed owner, an eligible message and a relay record a node left before
// the upgrade, no round sends a proxy answer, claims an attempt or consults the
// relay guards, also after a daemon restart. Synthetic home, fake socket,
// captured timers; no real Codex.

const MSG = "44400002-0000-4000-8000-000000000001";
const NEXT = "44400003-0000-4000-8000-000000000001";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

test("with wake.codexFork set the daemon sends no proxy answer and starts no fork, also after a restart (issue #890)", async (t) => {
  const n = relayNode(t);
  // At the daemon's real clock: the start purges inbox records older than 7 days, and the
  // relay pass cleans up a record past RELAY_MAX_AGE_MS.
  storeMessage(n.paths.inbox, { messageId: MSG, from: PEER, toSession: FORK_OWNER, text: "synthetic question",
    createdAt: new Date().toISOString() });
  n.seed(MSG, { attemptedAt: Date.now() });
  n.sweep();
  const relay = n.outbox();
  assert.equal(relay.length, 1, "a relay record waits in the outbox");
  storeMessage(n.paths.inbox, { messageId: NEXT, from: PEER, toSession: FORK_OWNER, text: "another synthetic question",
    createdAt: new Date().toISOString() });
  n.session({ lastSeen: new Date().toISOString() });
  assert.deepEqual(n.deps().policy.wake?.codexFork?.sessions, [FORK_OWNER], "the owner is wake-listed and opted in");

  const identity = generateIdentity();
  writePrivateKey(n.paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: n.paths.privateKey, policyFile: n.paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    refresh: NodeClient.prototype.refreshPolicy, frame: NodeClient.prototype.onFrame, codexHome: process.env.CODEX_HOME };
  process.env.CODEX_HOME = n.home;
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  const frames: string[] = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 1;
    addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
    send(data: string) { frames.push(data); }
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = ((callback: () => void, ms: number) => { timers.set(ms, callback); return { interval: ms }; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let refreshes = 0;
  NodeClient.prototype.refreshPolicy = async () => { refreshes++; return []; };
  NodeClient.prototype.onFrame = async () => [];
  const logs: string[] = [];
  let handle: DaemonHandle | undefined;
  const start = (): void => {
    handle = startDaemon(config, n.paths, (line) => { logs.push(line); }, async () => [], () => new Promise<ProbeResult>(() => {}));
    listeners.get("open")?.({});
  };
  t.after(async () => {
    handle?.stop();
    await codexQueueIdle();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.refreshPolicy = original.refresh;
    NodeClient.prototype.onFrame = original.frame;
    if (original.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original.codexHome;
    assert.ok(path.resolve(n.root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  });
  const round = async (): Promise<void> => {
    const tick = timers.get(EXCHANGE_INTERVAL_MS);
    assert.ok(tick);
    const before = refreshes;
    tick();
    // A tick during a running round is coalesced; tick again until this round starts.
    await until(() => {
      if (refreshes === before) tick();
      return refreshes > before;
    }, "the round ran");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    await codexQueueIdle();
    await flush();
  };
  const sends = (): number => frames.map((frame) => parseEnvelope(frame)).filter((p) => p.ok && p.envelope.type === "message.send").length;
  const relayLogs = (): string[] => logs.filter((line) => line.includes("Codex fork relay"));
  const check = (when: string): void => {
    assert.equal(sends(), 0, `${when}: no proxy answer left the node`);
    assert.deepEqual(relayLogs(), [], `${when}: the relay guards were never consulted`);
    assert.deepEqual(n.outbox(), relay, `${when}: the held record waits for its bound`);
    assert.deepEqual([n.app.runs.length, n.turns(), n.audit()], [0, [], []], `${when}: no fork, turn or fork audit`);
    assert.deepEqual(n.attempt(MSG).state, "completed", `${when}: the stored attempt is kept`);
    assert.equal(forkAttempts(n.paths, FORK_OWNER).length, 1, `${when}: no new attempt`);
    assert.equal(getMessage(n.paths.inbox, NEXT)?.state, "accepted", `${when}: the eligible message waits for its owner`);
  };

  start();
  await round();
  await round();
  check("first daemon");
  handle!.stop();
  await codexQueueIdle();
  start();
  await round();
  await round();
  check("after a restart");
});
