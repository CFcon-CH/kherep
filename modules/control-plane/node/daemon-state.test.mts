import assert from "node:assert/strict";
import { FakeClock } from "./connection-test-fixture.mts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listenerDir } from "./autonomy.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import {
  carriedOver, daemonStateFile, pidAlive, readDaemonState, recordDaemonState, withVerdict, type DaemonState,
} from "./daemon-state.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Issue #215: the daemon leaves its pid at start and the time of its last
// authenticated connection, the evidence `kherep-node doctor` reads.
test("the daemon records its pid at start, each authenticated connection and each lost connection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-state-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid",
    nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic-node", publicKey: identity.publicKey,
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() };
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  const original = { socket: globalThis.WebSocket, interval: globalThis.setInterval, frame: NodeClient.prototype.onFrame,
    refresh: NodeClient.prototype.refreshPolicy };
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    static OPEN = 1;
    readyState = 1;
    addEventListener(name: string, callback: (event: { data?: string; code?: number }) => void) { listeners.set(name, callback); }
    send(_data: string) {}
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  } });
  globalThis.setInterval = (() => ({})) as unknown as typeof setInterval;
  NodeClient.prototype.refreshPolicy = async () => [];
  NodeClient.prototype.onFrame = async function (this: NodeClient) { this.authenticated = true; return []; };
  // Issue #222: each completed readiness probe is recorded with its fixed cause, never the probe's output.
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    sessions: { enabled: true, workspaceRoots: [root], runtimes: ["claude", "codex"] } }));
  // Issue #225: the start also removes the lock of a listener whose process has exited.
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  const stale = path.join(listenerDir(paths), "s-gone.json");
  fs.mkdirSync(listenerDir(paths));
  fs.writeFileSync(stale, JSON.stringify({ token: "t", pid: gone, startedAt: Date.now(), event: "Stop" }));
  const clock = new FakeClock();
  const handle = startDaemon(config, paths, () => {}, undefined, async (runtime) => (runtime === "claude"
    ? { ok: true } : { ok: false, cause: "sign-in", detail: "SYNTHETIC_PROBE_OUTPUT" }), undefined, {}, {}, undefined, clock);
  t.after(() => {
    handle.stop();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original.socket });
    globalThis.setInterval = original.interval;
    NodeClient.prototype.onFrame = original.frame;
    NodeClient.prototype.refreshPolicy = original.refresh;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(fs.existsSync(stale), false);
  const started = readDaemonState(paths);
  assert.equal(started?.pid, process.pid);
  assert.ok(started && !Number.isNaN(Date.parse(started.startedAt)));
  assert.ok(started.source);
  assert.equal(started?.connectedAt, undefined);
  assert.match(started?.source.commit ?? "", /^[0-9a-f]{40,64}$/);
  assert.match(started?.source.digest ?? "", /^[0-9a-f]{64}$/);

  await flush();
  const probed = readDaemonState(paths)?.readiness;
  assert.deepEqual([probed?.claude?.ready, probed?.codex?.ready, probed?.codex?.cause], [true, false, "sign-in"]);
  for (const record of [probed?.claude, probed?.codex]) assert.ok(record && !Number.isNaN(Date.parse(record.probedAt)));
  assert.equal(fs.readFileSync(daemonStateFile(paths), "utf8").includes("SYNTHETIC_PROBE_OUTPUT"), false);

  listeners.get("message")?.({ data: "synthetic-auth-ok" });
  await flush();
  await flush();
  const connected = readDaemonState(paths);
  assert.equal(connected?.startedAt, started?.startedAt);
  assert.ok(connected?.connectedAt && !Number.isNaN(Date.parse(connected.connectedAt)));
  assert.deepEqual(connected?.readiness, probed, "a connection keeps the readiness record");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(daemonStateFile(paths), "utf8"))).sort(),
    ["connectedAt", "pid", "readiness", "source", "startedAt"]);

  listeners.get("close")?.({ code: 1012 });
  const lost = readDaemonState(paths);
  assert.equal(lost?.connectedAt, connected?.connectedAt);
  assert.ok(lost?.disconnectedAt && !Number.isNaN(Date.parse(lost.disconnectedAt)));

  listeners.get("message")?.({ data: "stale-auth-must-be-ignored" });
  await flush();
  assert.equal(readDaemonState(paths)?.disconnectedAt, lost?.disconnectedAt);
  clock.advance(1_000); // a real replacement generation, using the existing backoff
  listeners.get("message")?.({ data: "synthetic-auth-ok-again" });
  await flush();
  await flush();
  const again = readDaemonState(paths);
  assert.equal(again?.disconnectedAt, undefined, "the next authentication clears the lost connection");
  assert.deepEqual(again?.readiness, probed);
});

test("pidAlive accepts only a running process id", () => {
  assert.equal(pidAlive(process.pid), true);
  for (const value of [0, -1, 1.5, "1", null]) assert.equal(pidAlive(value), false);
});

// Issue #420: what a starting daemon takes over from the previous daemon.json.
test("a start carries fresh ready verdicts over, but no Claude verdict while an interrupted probe is on record", () => {
  const now = Date.parse("2026-10-15T12:00:00.000Z");
  const fresh = { ready: true, probedAt: "2026-10-15T11:55:00.000Z" };
  const previous: DaemonState = { pid: 1, startedAt: "2026-10-15T11:00:00.000Z", connectedAt: "2026-10-15T11:00:01.000Z",
    readiness: { claude: fresh, codex: { ready: true, probedAt: "2026-10-15T11:40:00.000Z" } } };
  assert.deepEqual(carriedOver(previous, null, now), { readiness: { claude: fresh } }, "the aged codex verdict is probed again");
  assert.deepEqual(carriedOver(null, null, now), {});
  const noticed = { runtime: "claude" as const, pid: 7, at: "2026-10-15T11:59:00.000Z", noticedAt: "2026-10-15T12:00:00.000Z" };
  assert.deepEqual(carriedOver(previous, noticed, now), { interruptedProbe: noticed }, "the interrupted probe forces a probe");
  assert.deepEqual(carriedOver({ ...previous, interruptedProbe: noticed }, null, now), { interruptedProbe: noticed },
    "kept until the next ready verdict, across restarts");
});

test("a ready Claude verdict clears the interrupted probe; a not-ready one keeps it", () => {
  const interruptedProbe = { runtime: "claude" as const, pid: 7, at: "2026-10-15T11:59:00.000Z", noticedAt: "2026-10-15T12:00:00.000Z" };
  const state: DaemonState = { pid: 1, startedAt: "2026-10-15T12:00:00.000Z", interruptedProbe };
  const at = Date.parse("2026-10-15T12:00:30.000Z");
  assert.deepEqual(withVerdict(state, "claude", { ready: false, at, cause: "sign-in" }).interruptedProbe, interruptedProbe);
  assert.deepEqual(withVerdict(state, "codex", { ready: true, at }).interruptedProbe, interruptedProbe);
  const cleared = withVerdict(state, "claude", { ready: true, at });
  assert.equal(JSON.parse(JSON.stringify(cleared)).interruptedProbe, undefined);
});

// Issue #540: on Windows a reader that briefly holds daemon.json open no
// longer costs the record; the retried rename writes it without a log line.
test("win32: a transient EPERM on the daemon.json rename still records the state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  const rename = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (calls++ === 0) throw Object.assign(new Error("synthetic hold"), { code: "EPERM" });
    return rename(from, to);
  });
  const lines: string[] = [];
  const state: DaemonState = { pid: process.pid, startedAt: new Date(0).toISOString() };
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    recordDaemonState(paths, state, (line) => lines.push(line));
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  assert.deepEqual(lines, []);
  assert.deepEqual(readDaemonState(paths), state);
});
