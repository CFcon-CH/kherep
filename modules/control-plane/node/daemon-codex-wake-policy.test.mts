import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishLiveness } from "./session-lifecycle.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { wakeAudit } from "./autonomy.mts";
import { NodeClient } from "./client.mts";
import { codexQueueIdle } from "./codex-queue.mts";
import { nodePaths, writeConfig, type NodeConfig } from "./config.mts";
import { startDaemon, SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { getMessageProgress, storeMessage } from "./inbox.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { listTasks, writeTask } from "./task-records.mts";

// Issue #463: the Codex task wake (pollCodexInbound) follows the policy of the
// exchange round, not the one the daemon read at start. Policy A has no
// sessions section, so the wake holds the message as wake-disabled; policy B
// enables sessions with codex, and the next round moves on to the readiness
// gate without a restart. Synthetic home, fake socket, captured timers, a
// probe that never answers: no real Codex, no spawn.

const OWNER = "01a0db74-0000-7000-8000-0000000000c1";
const TASK = "46300001-0000-4000-8000-000000000001";
const MSG = "46300001-0000-4000-8000-0000000000aa";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "public-synthetic-peer" };

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};
const settle = async (): Promise<void> => { await flush(); await codexQueueIdle(); await flush(); };

async function daemon(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-codex-wake-policy-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  writeConfig(paths.config, config);
  const work = path.join(root, "synthetic-work");
  fs.mkdirSync(work);
  // Policy A: the session is on the wake list, no sessions section (no readiness probe at start).
  const writePolicy = (sessions?: Record<string, unknown>): void => {
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: [OWNER] },
      ...(sessions ? { sessions } : {}) }));
  };
  writePolicy();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  writeTask(paths, { taskId: TASK, name: `task-${TASK.slice(0, 8)}`, runtime: "codex", sessionId: OWNER, cwd: work,
    permissionMode: "default", state: "done", startedAt, deadline: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: startedAt });
  const measuredAt = Date.now();
  const evidence = [{ runtime: "codex", sessionId: OWNER,
    holder: { status: "value", value: { present: true, creationIdentity: "synthetic-created-1" }, source: "native-holder", observedAt: measuredAt, complete: true, reasonCode: "observed" },
    loaded: { status: "value", value: true, source: "native-app", observedAt: measuredAt, complete: true, reasonCode: "observed" },
    turn: { status: "value", value: "idle", source: "native-turn", observedAt: measuredAt, complete: true, reasonCode: "observed" },
  }] satisfies import("./session-liveness.mts").SessionEvidence[];
  publishLiveness(paths, evidence, measuredAt);
  writeLocalSessions(paths, [{ runtime: "codex", sessionId: OWNER, state: "idle-loaded" }], measuredAt);
  storeMessage(paths.inbox, { messageId: MSG, from: PEER, toSession: OWNER, text: "synthetic question", createdAt: new Date().toISOString() });
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    refresh: NodeClient.prototype.refreshPolicy, frame: NodeClient.prototype.onFrame, codexHome: process.env.CODEX_HOME };
  process.env.CODEX_HOME = path.join(root, "synthetic-codex-home");
  fs.mkdirSync(process.env.CODEX_HOME);
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 1;
    addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
    send(_data: string) {}
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = ((callback: () => void, ms: number) => { if (!timers.has(ms)) timers.set(ms, callback); return { interval: ms }; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  NodeClient.prototype.refreshPolicy = async () => [];
  NodeClient.prototype.onFrame = async () => [];
  const handle = startDaemon(config, paths, () => {}, async () => [{ runtime: "codex", sessionId: OWNER, state: "unknown" }],
    () => new Promise<ProbeResult>(() => {}), undefined, {}, {}, {
      observe: () => ({ status: "value", value: evidence, observedAt: measuredAt, source: "native-app", complete: true, reasonCode: "observed" }),
    });
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.refreshPolicy = original.refresh;
    NodeClient.prototype.onFrame = original.frame;
    if (original.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original.codexHome;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  listeners.get("open")?.({});
  const generationBefore = JSON.parse(fs.readFileSync(paths.sessions, "utf8")).generation;
  timers.get(SESSIONS_INTERVAL_MS)!();
  await until(() => JSON.parse(fs.readFileSync(paths.sessions, "utf8")).generation !== generationBefore, "current daemon source observation committed");
  const tick = timers.get(EXCHANGE_INTERVAL_MS);
  assert.ok(tick);
  const audit = (): string[] => (fs.existsSync(wakeAudit(paths)) ? fs.readFileSync(wakeAudit(paths), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { sessionId: string; action: string }).filter((line) => line.sessionId === OWNER)
    .map((line) => line.action) : []);
  const unknown = () => {
    publishLiveness(paths, [{ runtime: "codex", sessionId: OWNER }], Date.now());
    writeLocalSessions(paths, [{ runtime: "codex", sessionId: OWNER, state: "unknown" }]);
  };
  return { paths, work, tick, audit, writePolicy, unknown, progress: () => getMessageProgress(paths.inbox, MSG)?.code };
}

test("a sessions edit after start reaches the Codex task wake at the next exchange round", async (t) => {
  const d = await daemon(t);
  d.tick();
  await until(() => d.progress() === "wake-disabled", "the first round held the message: sessions not enabled");
  await settle();
  assert.deepEqual(d.audit(), ["disabled"]);
  d.writePolicy({ enabled: true, workspaceRoots: [d.work], runtimes: ["codex"] });
  d.tick();
  await until(() => d.progress() !== "wake-disabled", "the round used the sessions section as written");
  await settle();
  // The next gate: no readiness verdict for codex yet (the probe never answers), so the message waits; nothing spawned.
  assert.equal(d.progress(), "retry-pending");
  assert.deepEqual(d.audit(), ["disabled"]);
  d.unknown();
  d.tick();
  await until(() => d.progress() === "awaiting-user-turn", "unknown metadata independently vetoes wake before readiness");
  assert.equal(listTasks(d.paths).find((record) => record.taskId === TASK)?.running, undefined, "no resume started");
});
