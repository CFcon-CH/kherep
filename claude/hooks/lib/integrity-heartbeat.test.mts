#!/usr/bin/env node
// Unit test for integrity-heartbeat.mts (issue #507, parts 2 and 3). The heartbeat:
// written atomically or not at all, with a 30-minute boundary on its age; Claude's
// runs are serialized by the hook runtime (hook-runtime-*.test.mts). The run lock
// of the Codex integrity hook (part 3): an EXCLUSIVE SQLite transaction held by
// real processes (lock-holder.fixture.mts), so the Windows hooks shard measures
// the release on exit too. Every case runs in its own mkdtemp home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import * as heartbeat from "./integrity-heartbeat.mts";
import { HEARTBEAT_WINDOW_MS, heartbeatAge, heartbeatFile, writeHeartbeat, type RunLock } from "./integrity-heartbeat.mts";
import { holdLock as hold, killHolders, tryLock } from "./lock-holder.fixture.mts";

// Through the namespace, so a lib without the lock fails each lock case on its own.
const { runLockFile, takeRunLock } = heartbeat;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-heartbeat-")));
after(async () => {
  await killHolders();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
let seq = 0;
const home = (): string => path.join(TMP, `case-${++seq}`, ".claude");
const cacheDir = (h: string): string => path.join(h, ".cache", "hook-integrity");
const leftovers = (h: string): string[] => fs.readdirSync(cacheDir(h)).filter((name) => name.endsWith(".tmp"));
const back = (file: string, ms: number): void => {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(file, then, then);
};
const MIN = 60_000;

test("the window is the designed 30 minutes", () => {
  assert.equal(HEARTBEAT_WINDOW_MS, 30 * MIN);
});

test("writeHeartbeat goes through a temporary file in the same directory and leaves none", () => {
  const h = home();
  const start = Date.now();
  let seen = "";
  const why = writeHeartbeat(h, { trigger: "session-start", runtime: "claude", files: 7 }, {
    beforeRename: (tmp) => {
      seen = tmp;
      assert.ok(fs.existsSync(tmp), "the temporary file exists before the rename");
      assert.equal(path.dirname(tmp), path.dirname(heartbeatFile(h)));
    },
  });
  assert.equal(why, "");
  assert.ok(seen && !fs.existsSync(seen), "the temporary file is gone after the rename");
  const beat = JSON.parse(fs.readFileSync(heartbeatFile(h), "utf8"));
  assert.equal(beat.trigger, "session-start");
  assert.equal(beat.runtime, "claude");
  assert.equal(beat.files, 7);
  assert.equal(beat.pid, process.pid);
  assert.ok(Date.parse(beat.ts) >= start - 1000 && Date.parse(beat.ts) <= Date.now() + 1000, beat.ts);
  assert.deepEqual(leftovers(h), []);
});

test("a failing write keeps the previous heartbeat byte for byte", { skip: process.platform === "win32" }, () => {
  const h = home();
  assert.equal(writeHeartbeat(h, { trigger: "session-start", runtime: "claude", files: 1 }), "");
  const before = fs.readFileSync(heartbeatFile(h));
  fs.chmodSync(cacheDir(h), 0o500);
  try {
    const why = writeHeartbeat(h, { trigger: "guard-dispatch", runtime: "claude", files: 2 });
    assert.match(why, /heartbeat write failed/);
  } finally {
    fs.chmodSync(cacheDir(h), 0o700);
  }
  assert.deepEqual(fs.readFileSync(heartbeatFile(h)), before);
  assert.deepEqual(leftovers(h), []);
});

test("heartbeatAge: missing is null, 29 minutes is inside the window, 31 is outside", () => {
  const h = home();
  assert.equal(heartbeatAge(h), null);
  writeHeartbeat(h, { trigger: "session-start", runtime: "claude", files: 1 });
  back(heartbeatFile(h), 29 * MIN);
  assert.ok(heartbeatAge(h)! < HEARTBEAT_WINDOW_MS);
  back(heartbeatFile(h), 31 * MIN);
  assert.ok(heartbeatAge(h)! > HEARTBEAT_WINDOW_MS);
});

// --- run.lock (issue #507, part 3) ---
const BUSY = "another integrity run holds run.lock (busy, holder UNKNOWN)";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tryOnce = tryLock;

// The lock in this process, retried for up to ms: the OS releases a dead holder's lock.
async function takeWithin(h: string, ms: number): Promise<RunLock | string> {
  const until = Date.now() + ms;
  let lock = takeRunLock(h);
  while (typeof lock === "string" && Date.now() < until) { await sleep(20); lock = takeRunLock(h); }
  return lock;
}

const pidOfBeat = (h: string): number => (JSON.parse(fs.readFileSync(heartbeatFile(h), "utf8")) as { pid: number }).pid;

test("T4.1 one holder: bounded busy attempts while the holder stays; only the database and its journal exist", { timeout: 30_000 }, async () => {
  const h = home();
  const a = await hold(h);
  try {
    const statements: string[] = [], pauses: number[] = [], opened: DatabaseSync[] = [], closed: DatabaseSync[] = [];
    class Spy extends DatabaseSync {
      constructor(file: string) { super(file); opened.push(this); }
      exec(sql: string): void { statements.push(sql); super.exec(sql); }
      prepare(sql: string): ReturnType<DatabaseSync["prepare"]> { statements.push(sql); return super.prepare(sql); }
      close(): void { closed.push(this); super.close(); }
    }
    const begin = Date.now();
    const b = takeRunLock(h, { sqlite: () => ({ ...process.getBuiltinModule("node:sqlite"), DatabaseSync: Spy }),
      pause: (ms) => {
        pauses.push(ms);
        assert.ok(pauses.length <= 3, "no wait for holder release after three pauses");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      } });
    const bMs = Date.now() - begin;
    const c = tryOnce(h);
    assert.equal(b, BUSY, `B took ${bMs} ms while the holder stayed`);
    assert.equal(c.result, BUSY, `C took ${c.ms} ms while the holder stayed`);
    assert.deepEqual(statements, Array.from({ length: 4 }, () => ["PRAGMA busy_timeout = 0", "PRAGMA journal_mode"]).flat());
    assert.equal(pauses.length, 3, "four attempts, with no pause after the last");
    assert.ok(pauses.every((ms) => ms >= 2 && ms <= 11), pauses.join(", "));
    assert.ok(pauses.reduce((sum, ms) => sum + ms, 0) <= 33, "at most 33 ms of requested pauses");
    assert.equal(opened.length, 1, "one connection for every attempt");
    assert.deepEqual(closed, [opened[0]], "that connection closed exactly once");
    assert.equal(opened[0]!.isOpen, false);
    assert.doesNotThrow(() => process.kill(a.pid, 0), "both contenders returned before the holder was released");
    assert.equal(runLockFile(h), path.join(cacheDir(h), "run.lock.sqlite"));
    assert.deepEqual(fs.readdirSync(cacheDir(h)).sort((left, right) => left.localeCompare(right)), ["run.lock.sqlite", "run.lock.sqlite-journal"]);
  } finally {
    await a.release();
  }
});

test("T4.2 the holder's death releases the lock; nothing is taken over, moved or deleted", { timeout: 30_000 }, async () => {
  const h = home();
  const a = await hold(h);
  assert.equal(takeRunLock(h), BUSY);
  const ino = fs.statSync(runLockFile(h)).ino;
  await a.kill();
  const begin = Date.now();
  const b = await takeWithin(h, 1000);
  assert.equal(typeof b, "object", `still ${String(b)} ${Date.now() - begin} ms after the holder was killed`);
  assert.equal(fs.statSync(runLockFile(h)).ino, ino, "the same database file, not a replacement");
  assert.equal((b as RunLock).release(), "");
});

test("T4.3 a pause before A publishes its heartbeat: B and C are busy, the heartbeat is A's, then C's", { timeout: 30_000 }, async () => {
  const h = home();
  const a = takeRunLock(h) as RunLock;
  assert.equal(typeof a, "object", String(a));
  let during: string[] = [];
  const why = writeHeartbeat(h, { trigger: "A", runtime: "codex", files: 1 }, {
    beforeRename: () => { during = [tryOnce(h).result, tryOnce(h).result]; },
  });
  assert.equal(why, "");
  assert.deepEqual(during, [BUSY, BUSY], "B and C are busy while A is about to publish");
  assert.equal(pidOfBeat(h), process.pid, "the heartbeat is A's");
  assert.equal(a.holding(), true);
  assert.equal(a.release(), "");
  assert.equal(a.holding(), false);
  const c = await hold(h, true);
  try {
    assert.equal(pidOfBeat(h), c.pid, "the heartbeat is the current owner's");
    assert.equal(a.release(), "", "A's late second release does nothing");
    assert.equal(tryOnce(h).result, BUSY, "C still holds: D is busy");
  } finally {
    await c.release();
  }
});

test("T4.4 a pause between A's possession check and its release: B busy, C owns after A, A's late release is a no-op", { timeout: 30_000 }, async () => {
  const h = home();
  const a = takeRunLock(h) as RunLock;
  assert.equal(a.holding(), true);
  assert.equal(tryOnce(h).result, BUSY, "B");
  assert.equal(a.release(), "");
  const c = await hold(h);
  try {
    assert.equal(a.release(), "");
    assert.equal(tryOnce(h).result, BUSY, "C still holds: D is busy");
  } finally {
    await c.release();
  }
});

test("T4.5 a seam that supplies no node:sqlite is unavailable, never the builtin, and creates nothing", () => {
  const h = home();
  const unavailable = "run.lock unavailable (node:sqlite is not available in this Node)";
  assert.equal(takeRunLock(h, { sqlite: () => undefined }), unavailable);
  assert.equal(takeRunLock(h, { sqlite: () => { throw new Error("no sqlite"); } }), unavailable);
  assert.equal(fs.existsSync(cacheDir(h)), false, "nothing was created");
});

test("T4.6 a foreign database is refused and left byte for byte", () => {
  const wal = home();
  fs.mkdirSync(cacheDir(wal), { recursive: true });
  const db = new DatabaseSync(runLockFile(wal));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE foreign_table (x)");
  db.close();
  const before = fs.readFileSync(runLockFile(wal));
  assert.equal(takeRunLock(wal), "run.lock database is not usable (journal_mode wal)");
  assert.deepEqual(fs.readFileSync(runLockFile(wal)), before);
  const junk = home();
  fs.mkdirSync(cacheDir(junk), { recursive: true });
  fs.writeFileSync(runLockFile(junk), "not a database, ".repeat(64));
  const text = fs.readFileSync(runLockFile(junk));
  assert.equal(takeRunLock(junk), "run.lock unavailable (ERR_SQLITE_ERROR)");
  assert.deepEqual(fs.readFileSync(runLockFile(junk)), text);
});

test("T4.7 a holder killed mid-transaction leaves a hot journal; the next owner rolls it back, nothing was written", { timeout: 30_000 }, async () => {
  const h = home();
  const a = await hold(h);
  await a.kill();
  const journal = `${runLockFile(h)}-journal`;
  assert.ok(fs.existsSync(journal) && fs.statSync(journal).size > 0, "a hot journal is left");
  const b = await takeWithin(h, 1000);
  assert.equal(typeof b, "object", String(b));
  assert.equal((b as RunLock).release(), "");
  assert.ok(!fs.existsSync(journal) || fs.statSync(journal).size === 0, "the journal is gone or empty");
  const db = new DatabaseSync(runLockFile(h));
  const objects = (db.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as { n: number }).n;
  db.close();
  assert.equal(objects, 0, "the database has no tables");
});

// Amendment A1: the contender's busy error comes from PRAGMA journal_mode, before BEGIN.
test("T4.8 busy at PRAGMA journal_mode: busy text, BEGIN never reached, that very connection closed, no throw", { timeout: 30_000 }, async () => {
  const h = home();
  const a = await hold(h);
  try {
    const real = process.getBuiltinModule("node:sqlite");
    const opened: DatabaseSync[] = [];
    const closed: DatabaseSync[] = [];
    const statements: string[] = [];
    // A spy on the one connection takeRunLock opens: what it ran and whether it was closed.
    class Spy extends real.DatabaseSync {
      constructor(file: string) { super(file); opened.push(this); }
      exec(sql: string): void { statements.push(sql); super.exec(sql); }
      prepare(sql: string): ReturnType<DatabaseSync["prepare"]> { statements.push(sql); return super.prepare(sql); }
      close(): void { closed.push(this); super.close(); }
    }
    let reached = false;
    const result = takeRunLock(h, { sqlite: () => ({ ...real, DatabaseSync: Spy }), beforeBegin: () => { reached = true; } });
    assert.equal(result, BUSY);
    assert.equal(reached, false, "beforeBegin was not reached");
    assert.equal(statements.at(-1), "PRAGMA journal_mode", "the failing statement");
    assert.equal(opened.length, 1);
    assert.deepEqual(closed, [opened[0]], "the failing connection itself was closed");
    assert.equal(opened[0]!.isOpen, false);
    const again = new real.DatabaseSync(runLockFile(h));
    again.close();
  } finally {
    await a.release();
  }
});
