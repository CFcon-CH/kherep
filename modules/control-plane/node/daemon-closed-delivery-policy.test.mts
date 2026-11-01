import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OPERATOR_NODE_ID } from "../protocol-messages.mts";
import { wakeAudit } from "./autonomy.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { SESSIONS_INTERVAL_MS, startDaemon } from "./daemon.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { storeMessage } from "./inbox.mts";
import { knownSessionsFile } from "./known-sessions.mts";
import { loadPolicy } from "./policy.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { CLAUDE_RUNTIME } from "./sessions.mts";

// Issue #463: closed-session delivery (messaging.resumeClosed) follows a fresh
// policy read at each session check, not the policy the daemon read at start.
// The real client with a synthetic authentication, the production snapshot
// path with an empty session listing, a probe that never answers. The message
// comes from the operator, so a delivery attempt is refused before any start.

const CLOSED = "01a0db74-0000-7000-8000-0000000000d1";
const MSG = "46300003-0000-4000-8000-000000000001";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-closed-delivery-policy-"));
  const paths = nodePaths(root), identity = generateIdentity();
  fs.mkdirSync(paths.dir, { recursive: true });
  writePrivateKey(paths.privateKey, identity);
  const work = path.join(root, "synthetic-work");
  fs.mkdirSync(work);
  const writePolicy = (resumeClosed: boolean): void => {
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: false },
      messaging: { accept: [{ session: "*", from: ["*"] }], ...(resumeClosed ? { resumeClosed: true } : {}) },
      sessions: { enabled: true, workspaceRoots: [work], delegate: { accept: true } } }));
  };
  writePolicy(false);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid",
    nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic-node",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  // #706: old miss/min-age eligibility plus injected exact positive closure metadata.
  const now = Date.now();
  fs.writeFileSync(knownSessionsFile(paths), JSON.stringify({ sessions: [{ sessionId: CLOSED, runtime: CLAUDE_RUNTIME, cwd: work,
    lastSeen: new Date(now - 200_000).toISOString(), misses: 3, missedSince: new Date(now - 120_000).toISOString(),
    missedAt: new Date(now - 10_000).toISOString() }] }));
  storeMessage(paths.inbox, { messageId: MSG, from: { nodeId: OPERATOR_NODE_ID, session: "operator" }, toSession: CLOSED,
    text: "synthetic operator message", createdAt: new Date(now - 5_000).toISOString() }, now - 5_000);
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval,
    clear: globalThis.clearInterval, frame: NodeClient.prototype.onFrame };
  const timers = new Map<number, (() => void)[]>();
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  let marks = 0;
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true,
    value: class {
      static OPEN = 1; static CONNECTING = 0;
      readyState = 1;
      addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
      send(_frame: string) {}
      close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
    } });
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    timers.set(ms, [...timers.get(ms) ?? [], callback]); return { interval: ms };
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  // Stub authentication and a marker frame only; policy reads, snapshots and closed delivery use the
  // production daemon path. The marker runs on the daemon's lane after the step queued before it.
  NodeClient.prototype.onFrame = async function (raw) {
    if (raw === "synthetic-marker") { marks++; return []; }
    if (raw !== "synthetic-auth-ok") return original.frame.call(this, raw);
    this.authenticated = true;
    return this.refreshPolicy(loadPolicy(paths.policy));
  };
  const handle = startDaemon(config, paths, () => {}, async () => [], () => new Promise<ProbeResult>(() => {}), undefined, {}, {}, {
    observe: async () => ({ status: "value", complete: true, source: "native-app", reasonCode: "observed", observedAt: now,
      value: [{ runtime: CLAUDE_RUNTIME, sessionId: CLOSED,
        app: { status: "value", value: "absent", complete: true, source: "native-app", reasonCode: "observed", observedAt: now },
        holder: { status: "value", value: { present: false }, complete: true, source: "native-holder", reasonCode: "observed", observedAt: now },
      }],
    }),
  });
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    globalThis.clearInterval = original.clear;
    NodeClient.prototype.onFrame = original.frame;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const listedAt = (): string | undefined => (fs.existsSync(paths.sessions)
    ? (JSON.parse(fs.readFileSync(paths.sessions, "utf8")) as { updatedAt?: string }).updatedAt : undefined);
  // The lane step that recorded a listing finished: sessions.json changed, then a marker queued behind the step ran.
  const settled = async (before: string | undefined): Promise<void> => {
    await until(() => listedAt() !== before, "the listing was recorded");
    const marked = marks;
    listeners.get("message")?.({ data: "synthetic-marker" });
    await until(() => marks > marked, "the lane reached the marker");
    await flush();
  };
  listeners.get("open")?.({});
  const initial = listedAt();
  listeners.get("message")?.({ data: "synthetic-auth-ok" });
  await settled(initial);
  const snapshotTick = timers.get(SESSIONS_INTERVAL_MS)?.[0];
  assert.ok(snapshotTick);
  // One complete session check: its listing was recorded and the rest of its step (closed delivery) ran.
  const check = async (): Promise<void> => {
    const before = listedAt();
    snapshotTick();
    await settled(before);
  };
  const closedLines = (): { outcome: string; reason?: string; messageIds: string[] }[] => (fs.existsSync(wakeAudit(paths))
    ? fs.readFileSync(wakeAudit(paths), "utf8").trim().split("\n").map((line) => JSON.parse(line) as
      { action: string; outcome: string; reason?: string; messageIds: string[] }).filter((line) => line.action === "closed-session")
      .map(({ outcome, reason, messageIds }) => ({ outcome, reason, messageIds })) : []);
  return { check, writePolicy, closedLines };
}

test("messaging.resumeClosed set after start reaches closed-session delivery at the next session check", async (t) => {
  const f = await fixture(t);
  await f.check();
  assert.deepEqual(f.closedLines(), [], "resumeClosed off: no delivery attempt");
  f.writePolicy(true);
  await f.check();
  await until(() => f.closedLines().length > 0, "the delivery attempt was audited");
  assert.deepEqual(f.closedLines(), [{ outcome: "refused", reason: "an operator message goes to no intercom session", messageIds: [MSG] }],
    "one attempt under the policy as written");
});
