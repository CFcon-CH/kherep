import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { intakeLane, laneTimer, lockRounds } from "./frame-lanes.mts";
import type { NodeClient } from "./client.mts";
import type { FrameArrival } from "./intake-diagnostics.mts";
import {
  RECORD_LOCK_POLL_MS, RECORD_LOCK_WAIT_MS, withRecordLock, type RecordLockBusy,
} from "./inbox-record-lock.mts";

// Issue #487 (D1): a lane item records how long it waited behind the lane, not
// only how long it ran, so a stall names its own cause. Fake clock, no timers.

function clock() {
  let at = 0;
  return { now: () => at, set: (ms: number) => { at = ms; } };
}

test("an item that waited over the threshold logs its wait and run time, without the run-time line", async () => {
  const c = clock();
  const lines: string[] = [];
  const timed = laneTimer((line) => lines.push(line), 5_000, c.now);
  c.set(6_000);
  await timed("chain", "exchange-round", () => { c.set(6_500); }, 0);
  assert.deepEqual(lines, ["kherep-node: lane chain item exchange-round waited 6.0 s, took 0.5 s"]);
  assert.ok(lines.every((line) => !/item \S+ took/.test(line)), "the existing run-time line stays reserved for slow runs");
});

test("an item that ran over the threshold keeps the existing line unchanged", async () => {
  const c = clock();
  const lines: string[] = [];
  const timed = laneTimer((line) => lines.push(line), 5_000, c.now);
  await timed("chain", "snapshot", () => { c.set(6_000); }, 0);
  assert.deepEqual(lines, ["kherep-node: lane chain item snapshot took 6.0 s"]);
});

test("an item slow in both extends the existing line compatibly", async () => {
  const c = clock();
  const lines: string[] = [];
  const timed = laneTimer((line) => lines.push(line), 5_000, c.now);
  c.set(7_000);
  await timed("intake", () => "intake:deliver", () => { c.set(13_000); }, 1_000);
  assert.deepEqual(lines, ["kherep-node: lane intake item intake:deliver took 6.0 s, waited 6.0 s"]);
});

test("without an enqueue time, or under the threshold, nothing about the wait is logged", async () => {
  const c = clock();
  const lines: string[] = [];
  const timed = laneTimer((line) => lines.push(line), 5_000, c.now);
  c.set(9_000);
  await timed("chain", "directory", () => {});
  await timed("chain", "directory", () => {}, 4_500);
  assert.deepEqual(lines, []);
});

test("a failing item still logs its wait and rethrows", async () => {
  const c = clock();
  const lines: string[] = [];
  const timed = laneTimer((line) => lines.push(line), 5_000, c.now);
  c.set(8_000);
  await assert.rejects(timed("chain", "frame:event", () => { throw new Error("synthetic failure"); }, 0), /synthetic failure/);
  assert.deepEqual(lines, ["kherep-node: lane chain item frame:event waited 8.0 s, took 0.0 s"]);
});

// Issue #627: every lane item of the daemon starts a round of record lock
// waits; a record held for the whole allowance is left to the next item.
test("each lane item has the round's record lock allowance again", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-lane-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = "00000000-0000-4000-8000-0000000000a1";
  fs.writeFileSync(path.join(dir, `.${id}.json.lock`), `${JSON.stringify({ pid: 1, at: new Date(0).toISOString() })}\n`);
  let at = 0;
  const sleeps: number[] = [];
  const held = (): void => { assert.throws(() => withRecordLock(dir, id, () => {}, { now: () => at, sleep: (ms) => { sleeps.push(ms); at += ms; } })); };
  const timed = lockRounds(laneTimer(() => {}, 5_000, () => 0), 100);
  await timed("chain", "exchange-round", () => { held(); held(); });
  assert.equal(sleeps.length, 100 / RECORD_LOCK_POLL_MS, "the second lock of the item did not wait");
  await timed("intake", "intake:deliver", held);
  assert.equal(sleeps.length, 2 * 100 / RECORD_LOCK_POLL_MS);
});

// The chain and intake lanes run their items concurrently: each item has an
// allowance of its own, and code outside any lane item has none left over
// from one (it waits the per-acquisition wait).
test("concurrent lane items each have their own allowance; none is left outside a lane item", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-lane-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = "00000000-0000-4000-8000-0000000000a2";
  fs.writeFileSync(path.join(dir, `.${id}.json.lock`), `${JSON.stringify({ pid: 1, at: new Date(0).toISOString() })}\n`);
  let at = 0;
  const waited: number[] = [];
  const held = (): void => {
    try {
      withRecordLock(dir, id, () => {}, { now: () => at, sleep: (ms) => { at += ms; } });
    } catch (error) {
      waited.push((error as RecordLockBusy).waitedMs);
    }
  };
  const timed = lockRounds(laneTimer(() => {}, 5_000, () => 0), 100);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const chain = timed("chain", "exchange-round", async () => { await gate; held(); });
  const intake = timed("intake", "intake:deliver", () => { held(); open(); });
  await Promise.all([chain, intake]);
  assert.deepEqual(waited, [100, 100], "the intake item did not spend the chain item's allowance");
  held();
  assert.equal(waited.at(-1), RECORD_LOCK_WAIT_MS);
});

// Issue #1012: the intake lane hands the frame's arrival to onFrame, which logs a late resolve with it.
test("1012: the intake lane passes the arrival to onFrame as third argument", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-intake-lane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: [string, boolean, FrameArrival | undefined][] = [];
  const client = { refreshPolicy: async () => [], onFrame: async (data: string, live: boolean, arrival?: FrameArrival) => {
    calls.push([data, live, arrival]); return [];
  } } as unknown as NodeClient;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const lane = intakeLane({ client, policyFile: path.join(root, "policy.json"), inbox: path.join(root, "inbox"), log: () => {},
    timed: async (_lane, _kind, run) => { try { await run(); } finally { done(); } } });
  const arrival: FrameArrival = { monoMs: 1, wallMs: 2, kind: 6, overdueMs: 3, tickLagMs: 4, tickAgeMs: 5 };
  lane("synthetic-frame", 0, { live: () => true, send: () => true, publishRegistration: () => true }, arrival);
  await finished;
  assert.deepEqual(calls, [["synthetic-frame", true, arrival]]);
});
