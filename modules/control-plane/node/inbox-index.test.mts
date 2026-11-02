import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inboxIndex, INDEX_REVALIDATE_MS } from "./inbox-index.mts";
import {
  getMessage, listInbox, markDelivered, markOffered, markReported, refuseUndeliverable, setMessageProgress, unreportedStatuses,
  type InboxRecord,
} from "./inbox.mts";

// Issue #487 (F1): every exchange round re-read the whole inbox several times.
// The daemon's index re-reads only records whose file changed (mtime, size),
// is validated by one readdir and stats per call, and fails closed: a failed
// directory read throws, it is never an empty inbox.

const T0 = Date.parse("2026-10-17T22:00:00.000Z");
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" };
export const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function settledInbox(t: test.TestContext, count: number, state: InboxRecord["state"] = "delivered"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-inbox-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const dir = path.join(root, "inbox");
  fs.mkdirSync(path.join(dir, "receipts"), { recursive: true });
  for (let n = 0; n < count; n++) {
    const record: InboxRecord = { messageId: idOf(n), from: PEER, toSession: `session-${n % 7}`, text: "synthetic peer content",
      createdAt: new Date(T0 + n).toISOString(), receivedAt: new Date(T0 + n).toISOString(), state, depth: 0 };
    fs.writeFileSync(path.join(dir, `${record.messageId}.json`), JSON.stringify(record));
    fs.writeFileSync(path.join(dir, "receipts", `${record.messageId}.json`), JSON.stringify(
      { reportedAt: new Date(T0).toISOString(), reportedState: state === "offered" ? "accepted" : state, workerState: state }));
  }
  return dir;
}

// Counts reads of message records and of their receipt and progress sidecars.
export function countReads(t: test.TestContext, dir: string): { records: () => string[]; sidecars: () => number } {
  const records: string[] = [];
  let sidecars = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const file = String(args[0]);
    if (path.dirname(file) === dir) records.push(path.basename(file));
    else if (path.dirname(path.dirname(file)) === dir) sidecars++;
    return read(...args);
  });
  return { records: () => records, sidecars: () => sidecars };
}

test("a second round over 3000 settled records reads no record or receipt; one rewrite re-reads exactly that record", async (t) => {
  const dir = settledInbox(t, 3000);
  const index = inboxIndex(dir);
  assert.equal(index.unreported(T0).length, 0);
  const reads = countReads(t, dir);
  assert.equal(index.unreported(T0).length, 0);
  assert.equal(index.records().length, 3000);
  assert.ok(reads.records().length + reads.sidecars() <= 10, `second round read ${reads.records().length} records`);
  // A hook rewrites one record (an operator replay of the delivered state).
  const changed = idOf(1234);
  const file = path.join(dir, `${changed}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...getMessage(dir, changed), offers: 2 }));
  fs.utimesSync(file, new Date(T0 + 60_000), new Date(T0 + 60_000));
  const before = reads.records().length;
  assert.equal(index.records().find((r) => r.messageId === changed)?.offers, 2);
  assert.deepEqual(reads.records().slice(before), [`${changed}.json`]);
});

test("a hook-written state change is picked up and reported; a receipt through the exchange settles it", (t) => {
  const dir = settledInbox(t, 20, "accepted");
  const index = inboxIndex(dir, { now: () => T0 });
  assert.deepEqual(index.unreported(T0), []);
  markOffered(dir, idOf(3), T0); // the delivery hook, outside the daemon
  markDelivered(dir, idOf(3));
  assert.deepEqual(index.unreported(T0).map((r) => [r.messageId, r.state]), [[idOf(3), "delivered"]]);
  markReported(dir, idOf(3), "delivered", "delivered", T0);
  assert.deepEqual(index.unreported(T0), []);
});

test("progress the daemon wrote in the same round is seen without a record change", (t) => {
  const dir = settledInbox(t, 5, "accepted");
  const index = inboxIndex(dir);
  assert.deepEqual(index.unreported(T0), []);
  setMessageProgress(dir, idOf(2), "waiting", "target-busy", T0);
  assert.deepEqual(index.unreported(T0).map((r) => [r.messageId, r.progress?.code]), [[idOf(2), "target-busy"]]);
});

test("records and unreported statuses equal the direct file reads on a mixed inbox", (t) => {
  const dir = settledInbox(t, 40);
  for (const n of [4, 9, 31]) fs.rmSync(path.join(dir, "receipts", `${idOf(n)}.json`));
  markOffered(dir, idOf(12), T0);
  setMessageProgress(dir, idOf(12), "waiting", "awaiting-turn-confirmation", T0);
  fs.writeFileSync(path.join(dir, `${idOf(7)}.json`), JSON.stringify({ ...getMessage(dir, idOf(7)), receivedAt: new Date(T0 - 1).toISOString() }));
  const index = inboxIndex(dir);
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(index.records(), listInbox(dir), "same records, same order");
    assert.deepEqual(index.unreported(T0 + 1), unreportedStatuses(dir, T0 + 1));
  }
});

test("a deleted record disappears and a new one appears", (t) => {
  const dir = settledInbox(t, 4);
  const index = inboxIndex(dir);
  assert.equal(index.records().length, 4);
  fs.rmSync(path.join(dir, `${idOf(1)}.json`));
  fs.copyFileSync(path.join(dir, `${idOf(2)}.json`), path.join(dir, `${idOf(9)}.json`));
  fs.writeFileSync(path.join(dir, `${idOf(9)}.json`), JSON.stringify({ ...getMessage(dir, idOf(2)), messageId: idOf(9) }));
  assert.deepEqual(index.records().map((r) => r.messageId).sort(), [idOf(0), idOf(2), idOf(3), idOf(9)]);
});

test("a stat error on one file re-reads that file and never fails the round", (t) => {
  const dir = settledInbox(t, 6);
  const index = inboxIndex(dir);
  index.records();
  const target = path.join(dir, `${idOf(4)}.json`);
  const stat = fs.statSync;
  t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    if (args[0] === target) throw Object.assign(new Error("synthetic stat failure"), { code: "EIO" });
    return stat(...args);
  });
  const reads = countReads(t, dir);
  assert.equal(index.records().length, 6);
  assert.deepEqual(reads.records(), [`${idOf(4)}.json`]);
});

test("a failed directory read throws and is never an empty inbox", (t) => {
  const dir = settledInbox(t, 3);
  const index = inboxIndex(dir);
  assert.equal(index.records().length, 3);
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === dir) throw Object.assign(new Error("synthetic readdir failure"), { code: "EACCES" });
    return readdir(...args);
  });
  assert.throws(() => index.records(), /synthetic readdir failure/);
  assert.throws(() => index.unreported(T0), /synthetic readdir failure/);
});

test("an unparseable record throws as listInbox does", (t) => {
  const dir = settledInbox(t, 3);
  const index = inboxIndex(dir);
  index.records();
  fs.writeFileSync(path.join(dir, `${idOf(1)}.json`), "{ not json");
  assert.throws(() => listInbox(dir));
  assert.throws(() => index.records());
});

test("a full revalidation re-reads every record and receipt after the interval", (t) => {
  const dir = settledInbox(t, 10);
  let at = T0;
  const index = inboxIndex(dir, { now: () => at });
  index.unreported(at);
  const reads = countReads(t, dir);
  at += INDEX_REVALIDATE_MS - 1;
  index.unreported(at);
  assert.equal(reads.records().length + reads.sidecars(), 0);
  at += 1;
  index.unreported(at);
  assert.equal(reads.records().length, 10);
  assert.equal(reads.sidecars(), 10, "cached receipts are dropped as well");
});

test("returned records are copies: a caller cannot change the cache", (t) => {
  const dir = settledInbox(t, 2);
  const index = inboxIndex(dir);
  (index.records()[0] as { state: string }).state = "accepted";
  assert.equal(index.records()[0]!.state, "delivered");
});

test("external readers keep reading the files directly", (t) => {
  const dir = settledInbox(t, 8, "accepted");
  inboxIndex(dir).records();
  const reads = countReads(t, dir);
  assert.equal(listInbox(dir).length, 8);
  assert.equal(reads.records().length, 8, "listInbox (hooks, CLI) is unchanged");
  assert.equal(refuseUndeliverable(dir, [], T0 + 2 * 60 * 60_000).length, 0, "absence alone cannot refuse");
  assert.equal(refuseUndeliverable(dir, [], T0 + 2 * 60 * 60_000, undefined, undefined,
    () => false, () => true).length, 8, "fresh positive closed evidence permits the existing file-level refusal");
  assert.ok(reads.records().length >= 16);
});
