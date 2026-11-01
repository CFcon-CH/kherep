import assert from "node:assert/strict";
import { publishLiveness } from "./session-lifecycle.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { nodePaths } from "./config.mts";
import { startDaemon, SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { recordingSessions } from "./exchange-sessions.mts";
import { getMessage, readJson, UNDELIVERABLE_AFTER_MS } from "./inbox.mts";
import { fakeSocket, fixture, id, PEER, seconds, until } from "./inbox-start-fixture.mts";

// Issue #589 item 3: the session listing's refusal check (refuseUndeliverable) read every inbox file on the daemon's
// thread, at the first snapshot after connect, every 60 s and at every session.list command. It now reads the records
// the daemon's inbox index gives it (one stat per record once built); without an index it reads the files as before.

const HOUR = 60 * 60_000;
const waiting = (dir: string, m: string, at: number): void => fs.writeFileSync(path.join(dir, `${m}.json`), JSON.stringify({ messageId: m,
  from: { nodeId: PEER, session: "planner" }, toSession: "gone", text: "hello", createdAt: new Date(at).toISOString(),
  receivedAt: new Date(at).toISOString(), state: "accepted", depth: 0 }));

test("U1: recordingSessions refuses from the record source it is given, not from the files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-589-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.inbox, { recursive: true });
  const now = Date.now();
  const [a, b] = [id(1), id(2)];
  waiting(paths.inbox, a, now - UNDELIVERABLE_AFTER_MS - HOUR);
  waiting(paths.inbox, b, now - UNDELIVERABLE_AFTER_MS - HOUR);
  publishLiveness(paths, [{ runtime: "codex", sessionId: "gone", lifecycle: {
    status: "value", value: { state: "deleted", generation: 1 }, observedAt: now,
    source: "native-lifecycle", complete: true, reasonCode: "observed",
  } }], now);
  const logs: string[] = [];
  const list = recordingSessions(paths, async () => [], (line) => logs.push(line), () => now, UNDELIVERABLE_AFTER_MS, () => [getMessage(paths.inbox, a)!]);
  assert.deepEqual(await list(), []);
  assert.equal(getMessage(paths.inbox, a)?.state, "refused");
  assert.equal(getMessage(paths.inbox, b)?.state, "accepted", "not in the records given: not judged");
  assert.deepEqual(logs, ["kherep-node: refused 1 message(s) for sessions that are not running"]);
});

// Review P2-1: the records only nominate candidates; the refusal is judged on the file it rewrites. A copy that still
// names the gone session must not refuse a record its file shows readdressed to a running one.
test("U2: a stale copy does not refuse a record whose file names a running session", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-589-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.inbox, { recursive: true });
  const now = Date.now();
  const m = id(1);
  waiting(paths.inbox, m, now - UNDELIVERABLE_AFTER_MS - HOUR);
  const stale = getMessage(paths.inbox, m)!;
  fs.writeFileSync(path.join(paths.inbox, `${m}.json`), JSON.stringify({ ...stale, toSession: "live", closedTo: "gone" }));
  const list = recordingSessions(paths, async () => [{ sessionId: "live", runtime: "claude", state: "idle" }], () => {}, () => now,
    UNDELIVERABLE_AFTER_MS, () => [stale]);
  await list();
  assert.equal(getMessage(paths.inbox, m)?.state, "accepted", "the file names a running session: not refused");
});

// After the index is built, a session.list command's refusal check stats the records and reads none of their files.
test("T8: the daemon's second session listing reads no inbox record file", async (t) => {
  const node = fixture(t, { inbox: 20, sent: 10 });
  const socket = fakeSocket(t);
  let reads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    const file = String(args[0]);
    if (file.startsWith(node.paths.inbox + path.sep) && file.endsWith(".json") && !file.includes(`${path.sep}receipts${path.sep}`)) reads++;
    return Reflect.apply(read, fs, args);
  });
  const logs: string[] = [];
  const handle = startDaemon(node.config, node.paths, (line) => logs.push(line), async () => []);
  t.after(() => handle.stop());
  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  // The first listing builds the index (one read per record) and the start maintenance reads the inbox once more.
  await until(() => seconds(logs) !== null && readJson<{ updatedAt?: string }>(node.paths.sessions)?.updatedAt !== undefined, logs);
  const first = readJson<{ updatedAt: string }>(node.paths.sessions)!.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5)); // a later updatedAt
  reads = 0;
  socket.feed("command", { commandId: "c1", command: "session.list" }, 1);
  await until(() => readJson<{ updatedAt: string }>(node.paths.sessions)?.updatedAt !== first, logs);
  assert.equal(reads, 0, `the second listing's refusal check read ${reads} inbox record file(s)`);
  handle.stop();
  await handle.done;
});

// Review of #606 P3-2: the 60 s snapshot (daemon.mts, the snapshots interval) checks from the index too. The fixture's
// setInterval does nothing, so this test keeps the callbacks and runs that tick itself. The refusal check is what runs
// between the rename onto sessions.json and the published snapshot frame; the snapshot's later steps read the inbox.
test("T9: the daemon's periodic session snapshot reads no inbox record file in its refusal check", async (t) => {
  const node = fixture(t, { inbox: 20, sent: 10 });
  const socket = fakeSocket(t);
  const intervals: { callback: () => void; ms: number }[] = [];
  globalThis.setInterval = ((callback: () => void, ms: number) => { intervals.push({ callback, ms }); return { interval: ms }; }) as unknown as typeof setInterval;
  let armed = false;
  let open = false;
  let checks = 0;
  let reads = 0;
  const [read, rename] = [fs.readFileSync, fs.renameSync];
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    const file = String(args[0]);
    if (open && file.startsWith(node.paths.inbox + path.sep) && file.endsWith(".json") && !file.includes(`${path.sep}receipts${path.sep}`)) reads++;
    return Reflect.apply(read, fs, args);
  });
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    if (armed && String(args[1]) === node.paths.sessions) open = true;
    return Reflect.apply(rename, fs, args);
  });
  t.mock.method(globalThis.WebSocket.prototype, "send", () => { if (open) checks++; open = false; });
  let n = 0; // a new listing every time, so every snapshot publishes a frame
  const listing = async (): Promise<SessionInfo[]> => [{ sessionId: `s-${n++}`, runtime: "claude", state: "idle" }];
  const logs: string[] = [];
  const handle = startDaemon(node.config, node.paths, (line) => logs.push(line), listing);
  t.after(() => handle.stop());
  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  await until(() => seconds(logs) !== null && readJson<{ updatedAt?: string }>(node.paths.sessions)?.updatedAt !== undefined, logs);
  // The open handler sets ping, snapshots, exchange, directory, in this order; snapshots is the first at its interval.
  const snapshot = intervals.find((entry) => entry.ms === SESSIONS_INTERVAL_MS);
  assert.ok(snapshot, "the snapshot interval was set");
  armed = true;
  await until(() => { snapshot.callback(); return checks > 0; }, logs); // a tick returns early while a listing runs
  assert.equal(reads, 0, `the periodic snapshot's refusal check read ${reads} inbox record file(s)`);
  handle.stop();
  await handle.done;
});
