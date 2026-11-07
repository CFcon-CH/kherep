import assert from "node:assert/strict";
import { publishLiveness } from "./session-lifecycle.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { listenerDir } from "./autonomy.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { startDaemon, SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { recordingSessions } from "./exchange-sessions.mts";
import { getMessage, readJson, UNDELIVERABLE_AFTER_MS, type InboxRecord } from "./inbox.mts";
import { knownSessionsFile, readKnownSessions } from "./known-sessions.mts";
import { MessageReferenceResolver } from "./message-reference.mts";
import { labelsFile, policyScope, readBindingView } from "./session-labels.mts";
import { livenessFile, readLivenessSnapshot } from "./session-lifecycle.mts";
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

// Issue #706, the carry bound. The seed has the shape measured on a live node: every ledger row carries the same observedAt
// (judgeSession moves an unknown row to the round's time), so only lastSeen says which row was listed last. The newest
// rows have the highest indexes, the opposite of key order, so neither observedAt nor the tie-break alone picks them.
const CARRY_LIMIT = 128;
const MINUTE = 60_000, DAY = 24 * 60 * MINUTE, NOW = Date.UTC(2026, 10, 7);
const LISTED: SessionInfo[] = [1, 2, 3].map(i => ({ sessionId: `live-${i}`, runtime: "codex", state: "idle" }));
type Extra = { sessionId: string; runtime?: string; name?: string };
function seedNode(t: test.TestContext, count: number, options: { extras?: Extra[]; ledger?: number; capped?: boolean; epoch?: string } = {}): { paths: NodePaths; ids: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-706-carry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const ids = Array.from({ length: count }, (_, i) => `old-${String(i).padStart(4, "0")}`);
  const extras = options.extras ?? [];
  const rows = [...extras.map(e => ({ runtime: "codex", ...e, state: "unknown" })), ...ids.map(sessionId => ({ sessionId, runtime: "codex", state: "unknown" }))];
  fs.writeFileSync(paths.sessions, JSON.stringify({ ...(options.epoch ? { labelBindingEpoch: options.epoch } : {}), generation: 7, sessions: rows, unseen: [], updatedAt: new Date(NOW - MINUTE).toISOString() }));
  fs.writeFileSync(livenessFile(paths), JSON.stringify({ version: 1, generation: 7, tombstones: [], ...(options.capped ? { capped: true } : {}),
    sessions: rows.slice(0, options.ledger ?? rows.length).map(r => ({ runtime: r.runtime, sessionId: r.sessionId, state: "unknown", observedAt: NOW - MINUTE, reasonCode: "stale" })) }));
  fs.writeFileSync(knownSessionsFile(paths), JSON.stringify({ sessions: [
    ...extras.map(e => ({ runtime: "codex", ...e, lastSeen: new Date(NOW - 5 * DAY).toISOString() })),
    ...ids.map((sessionId, i) => ({ sessionId, runtime: "codex", lastSeen: new Date(NOW - (count - i) * MINUTE).toISOString() })),
  ] }));
  return { paths, ids };
}
const round = (paths: NodePaths, at = NOW, records: () => InboxRecord[] = () => [], log: (line: string) => void = () => {}, listed = LISTED): Promise<SessionInfo[]> =>
  recordingSessions(paths, async () => listed.map(r => ({ ...r })), log, () => at, UNDELIVERABLE_AFTER_MS, records)();
const written = (paths: NodePaths) => readJson<{ sessions: { sessionId: string }[]; unseen: unknown[]; generation: number; updatedAt: string }>(paths.sessions)!;
const writtenIds = (paths: NodePaths): string[] => written(paths).sessions.map(s => s.sessionId);
const resolved = (paths: NodePaths, ref: string): string => new MessageReferenceResolver(paths, () => NOW).resolve({ version: 1, requestId: id(1), messageId: id(2),
  purpose: "admit", selections: [{ role: "to", ref }], expiresAt: NOW + 1000 }, "policy").results[0].code;
const BOUND_ID = "11111111-1111-4111-8111-111111111111", EPOCH = "22222222-2222-4222-8222-222222222222";
const writeBinding = (paths: NodePaths): void => fs.writeFileSync(labelsFile(paths), JSON.stringify({ schemaVersion: 1, scope: policyScope(paths), epoch: EPOCH, version: 1,
  bindings: [{ token: "planner", runtime: "claude-code", sessionId: BOUND_ID, firstName: "planner", boundAt: NOW - 5 * DAY, sourceGeneration: 1, provenance: "policy-co-list" }],
  identityVetoes: [], knownTokens: ["planner"], local: [], observedAt: NOW - 5 * DAY, complete: true, ambiguousNames: [], localGeneration: 1, identityGeneration: 1 }));

test("recordingSessions carries at most CARRY_LIMIT unlisted rows, newest first", async t => {
  const { paths, ids } = seedNode(t, 300);
  await round(paths);
  assert.deepEqual(writtenIds(paths), [...LISTED.map(r => r.sessionId), ...ids.slice(-CARRY_LIMIT)], "the rows listed last, in the file's order");
  assert.equal(readLivenessSnapshot(paths)!.sessions.length, 3 + CARRY_LIMIT, "the ledger forgets the dropped rows");
});
test("a tie on lastSeen breaks on the session key, and a row no entry names ranks oldest", async t => {
  const { paths, ids } = seedNode(t, 200);
  const at = new Date(NOW - MINUTE).toISOString();
  const known = readKnownSessions(paths).map(s => ({ ...s, lastSeen: at })).filter(s => s.sessionId !== ids[0]);
  fs.writeFileSync(knownSessionsFile(paths), JSON.stringify({ sessions: known.reverse() }));
  await round(paths);
  assert.deepEqual(writtenIds(paths).slice(3), ids.slice(1, CARRY_LIMIT + 1));
});
test("recordingSessions always carries listener, inbox and label-bound rows", async t => {
  const extras = [{ sessionId: "by-listener" }, { sessionId: "by-mode-file" }, { sessionId: "inbox-by-id" }, { sessionId: "inbox-by-name", name: "reviewer" },
    { sessionId: BOUND_ID, runtime: "claude-code", name: "planner" }];
  const { paths, ids } = seedNode(t, 300, { extras, epoch: EPOCH });
  writeBinding(paths);
  fs.mkdirSync(listenerDir(paths));
  fs.writeFileSync(path.join(listenerDir(paths), "by-listener.json"), "{}");
  fs.writeFileSync(path.join(listenerDir(paths), "by-mode-file.mode.json"), "{}");
  await round(paths, NOW, () => [{ toSession: "inbox-by-id" }, { toSession: "reviewer" }] as InboxRecord[]);
  assert.deepEqual(writtenIds(paths), [...LISTED.map(r => r.sessionId), ...extras.map(e => e.sessionId), ...ids.slice(-(CARRY_LIMIT - extras.length))]);
});
test("protected rows beyond CARRY_LIMIT are all carried, and nothing else", async t => {
  const { paths, ids } = seedNode(t, 300);
  fs.mkdirSync(listenerDir(paths));
  for (const name of ids.slice(0, 140)) fs.writeFileSync(path.join(listenerDir(paths), `${name}.json`), "{}");
  await round(paths);
  assert.deepEqual(writtenIds(paths).slice(3), ids.slice(0, 140));
});
test("a wake-list bound session idle for days keeps its row and its binding", async t => {
  const { paths } = seedNode(t, 300, { extras: [{ sessionId: BOUND_ID, runtime: "claude-code", name: "planner" }], epoch: EPOCH });
  writeBinding(paths);
  for (const at of [NOW, NOW + MINUTE]) await round(paths, at);
  assert.ok(writtenIds(paths).includes(BOUND_ID));
  assert.equal(resolved(paths, "planner"), "BOUND");
  assert.equal(readBindingView(paths).bindings[0]?.sessionId, BOUND_ID);
});
test("a node under CARRY_LIMIT writes the same sessions.json as before", async t => {
  for (const count of [0, 5, CARRY_LIMIT]) {
    const { paths, ids } = seedNode(t, count);
    const reads = t.mock.method(fs, "readdirSync");
    await round(paths, NOW, () => { throw new Error("the protected rows are not read under the limit"); });
    assert.equal(reads.mock.calls.filter(c => String(c.arguments[0]) === listenerDir(paths)).length, 0);
    reads.mock.restore();
    const file = written(paths);
    assert.deepEqual({ ...file, updatedAt: "" }, { generation: 8, sessions: [...LISTED.map(r => r.sessionId), ...ids].map(sessionId => ({ sessionId, runtime: "codex", state: "unknown" })), unseen: [], updatedAt: "" });
  }
});
test("a row twice in sessions.json is carried once", async t => {
  const { paths } = seedNode(t, 0, { extras: [{ sessionId: "twin" }] });
  const file = readJson<{ sessions: object[] }>(paths.sessions)!;
  fs.writeFileSync(paths.sessions, JSON.stringify({ ...file, sessions: [...file.sessions, ...file.sessions] }));
  await round(paths);
  assert.deepEqual(writtenIds(paths), [...LISTED.map(r => r.sessionId), "twin"]);
  assert.notEqual(readLivenessSnapshot(paths)!.sessions.find(s => s.sessionId === "twin")?.reasonCode, "identity");
});
test("a failed read of a protected set or of lastSeen carries every row", async t => {
  const faults: Record<string, (paths: NodePaths) => void> = {
    listeners: paths => fs.writeFileSync(listenerDir(paths), "not a directory"),
    labels: paths => fs.writeFileSync(labelsFile(paths), "{"),
    "lost labels": paths => { const v = readJson<object>(paths.sessions); fs.writeFileSync(paths.sessions, JSON.stringify({ ...v, labelBindingEpoch: EPOCH })); },
    "corrupt known": paths => fs.writeFileSync(knownSessionsFile(paths), "{"),
    "malformed known": paths => fs.writeFileSync(knownSessionsFile(paths), JSON.stringify({ sessions: "x" })),
    "absent known": paths => fs.rmSync(knownSessionsFile(paths)),
    "garbage lastSeen": paths => fs.writeFileSync(knownSessionsFile(paths), JSON.stringify({ sessions: [{ sessionId: "old-0000", runtime: "codex", lastSeen: "garbage" }] })),
  };
  const check = async (sub: test.TestContext, fault: (paths: NodePaths) => void, records?: () => InboxRecord[]) => {
    const { paths, ids } = seedNode(sub, 200);
    fault(paths);
    const logs: string[] = [];
    await round(paths, NOW, records, line => logs.push(line));
    assert.deepEqual(writtenIds(paths), [...LISTED.map(r => r.sessionId), ...ids]);
    assert.equal(logs.filter(line => line.includes("carry bound")).length, 1, "the fault is visible");
    assert.deepEqual(written(paths).unseen, [], "a fail-safe carry does not mark the listing partial");
    assert.equal(resolved(paths, "live-1"), "BOUND");
    await round(paths, NOW + MINUTE, records, line => logs.push(line));
    assert.equal(logs.filter(line => line.includes("carry bound")).length, 1, "and is logged once while it lasts");
  };
  for (const [name, fault] of Object.entries(faults)) await t.test(name, sub => check(sub, fault));
  await t.test("inbox records", sub => check(sub, () => {}, () => { throw new Error("index unavailable"); }));
});
test("dropping carried rows leaves the listing complete, so a resolve is not INVALID", async t => {
  const { paths, ids } = seedNode(t, 300);
  await round(paths);
  assert.deepEqual(written(paths).unseen, []);
  assert.equal(readLivenessSnapshot(paths)!.capped, undefined);
  assert.equal(resolved(paths, "live-1"), "BOUND");
  assert.equal(resolved(paths, ids.at(-1)!), "BOUND", "a carried row");
  assert.equal(resolved(paths, ids[0]), "MISSING", "a dropped row is missing, nothing else");
});
test("two rounds with the same inputs write the same sessions.json apart from generation and updatedAt", async t => {
  const { paths } = seedNode(t, 300);
  const body = () => { const { generation: _g, updatedAt: _u, ...rest } = written(paths); return JSON.stringify(rest); };
  await round(paths);
  const first = body(), generation = written(paths).generation;
  await round(paths, NOW + MINUTE);
  assert.equal(body(), first);
  assert.equal(written(paths).generation, generation + 1);
});
test("the first round after an upgrade clears capped and a listed id resolves BOUND", async t => {
  for (const [count, ledger, capped] of [[400, 400, false], [512, 512, true], [600, 512, true]] as const) await t.test(`${count} rows, ledger ${ledger}${capped ? ", capped" : ""}`, async sub => {
    const { paths, ids } = seedNode(sub, count, { ledger, capped });
    if (capped) assert.equal(resolved(paths, ids[0]), "INVALID", "the cliff this fix removes");
    await round(paths);
    assert.equal(readLivenessSnapshot(paths)!.capped, undefined);
    assert.deepEqual(written(paths).unseen, []);
    assert.equal(writtenIds(paths).length, 3 + CARRY_LIMIT);
    for (const row of LISTED) assert.equal(resolved(paths, row.sessionId), "BOUND");
  });
});
test("the bound holds while sessions keep appearing, on lastSeen the listing itself wrote", async t => {
  const { paths, ids } = seedNode(t, CARRY_LIMIT);
  const born: string[] = [];
  for (let i = 0; i < 5; i++) {
    born.push(`fresh-${i}`);
    await round(paths, NOW + i * 5 * MINUTE, undefined, undefined, [{ sessionId: `fresh-${i}`, runtime: "codex", state: "idle" }]);
    assert.equal(writtenIds(paths).length, 1 + CARRY_LIMIT);
  }
  assert.deepEqual(new Set(writtenIds(paths)), new Set([...born, ...ids.slice(-(CARRY_LIMIT - 4))]), "the oldest rows left, every session of the last rounds stayed");
});
