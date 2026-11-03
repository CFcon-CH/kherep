import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { reserveTargetOwner } from "./codex-native-pending.mts";
import { submitTargetQueueGroup } from "./codex-queue-producer.mts";
import { finishTargetSubmission, prepareTargetDelivery } from "./target-delivery.mts";
import { targetFixture, TARGET_T as T, TARGET_QUEUE as QUEUE, TARGET_LIMITS as LIMITS } from "./target-delivery-fixture.mts";
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
for (const transition of ["debit-before-phase", "debit-phase-answerloss", "group-before-create", "attempt-after-flush", "ready-before-rename"]) test(`recovery at ${transition} keeps exact debit and full group`, async t => {
  const f = targetFixture(t), handle = reserveTargetOwner(f.paths, f.group)!;
  const rename = fs.renameSync, open = fs.openSync, flush = fs.fsyncSync;
  const fds = new Map<number, string>(); let faulted = false;
  t.mock.method(fs, "openSync", ((...args: Parameters<typeof open>) => {
    if (!faulted && transition === "group-before-create" && args[0] === f.groupFile) { faulted = true; throw Error("before group create"); }
    const fd = Reflect.apply(open, fs, args); fds.set(fd, String(args[0])); return fd;
  }) as typeof open);
  t.mock.method(fs, "fsyncSync", ((fd: number) => {
    flush(fd); if (!faulted && transition === "attempt-after-flush" && fds.get(fd) === f.attempt(1)) { faulted = true; throw Error("after attempt flush"); }
  }) as typeof flush);
  t.mock.method(fs, "renameSync", ((a, b) => {
    if (!faulted && b === f.reservation) {
      const phase = read(String(a)).phase;
      if (phase === "debited" && ["debit-before-phase", "debit-phase-answerloss"].includes(transition)
        || phase === "ready" && transition === "ready-before-rename") {
        faulted = true; if (transition === "debit-phase-answerloss") rename(a, b); throw Error(transition);
      }
    }
    rename(a, b);
  }) as typeof rename);
  assert.throws(() => prepareTargetDelivery(f.paths, handle, T, LIMITS)); assert.equal(faulted, true); t.mock.restoreAll();
  assert.equal(read(f.budget).turns.length, 1);
  const saved = prepareTargetDelivery(f.paths, handle, T + 1, LIMITS);
  assert.equal(saved.phase, "ready"); assert.equal(saved.budget!.chargedAt, T); assert.equal(read(f.budget).turns.length, 1);
  let calls = 0; await submitTargetQueueGroup(f.paths, handle, () => T + 2, async () => { calls++; return { queueId: QUEUE }; }); assert.equal(calls, 1);
});
test("partial exclusive-create reservation and attempt stay fences instead of disappearing", async t => {
  for (const place of ["reservation", "attempt"] as const) {
    const f = targetFixture(t), handle = place === "attempt" ? reserveTargetOwner(f.paths, f.group)! : undefined;
    const target = place === "attempt" ? f.attempt(1) : f.reservation, open = fs.openSync, write = fs.writeFileSync;
    const fds = new Map<number, string>(); let faulted = false;
    t.mock.method(fs, "openSync", ((...args: Parameters<typeof open>) => { const fd = Reflect.apply(open, fs, args); fds.set(fd, String(args[0])); return fd; }) as typeof open);
    t.mock.method(fs, "writeFileSync", ((...args: Parameters<typeof write>) => {
      if (typeof args[0] === "number" && fds.get(args[0]) === target) { faulted = true; write(args[0], "{"); throw Error("partial create"); }
      return Reflect.apply(write, fs, args);
    }) as typeof write);
    assert.throws(() => handle ? prepareTargetDelivery(f.paths, handle, T, LIMITS) : reserveTargetOwner(f.paths, f.group));
    assert.equal(faulted, true); t.mock.restoreAll(); assert.equal(fs.readFileSync(target, "utf8"), "{");
    assert.equal(reserveTargetOwner(f.paths, f.group), null);
    if (handle) { let calls = 0; await assert.rejects(submitTargetQueueGroup(f.paths, handle, () => T, async () => { calls++; return {}; })); assert.equal(calls, 0); }
  }
});
test("lost submitting commit answer invokes no transport and cannot retry an ambiguous attempt", async t => {
  const f = targetFixture(t), h = reserveTargetOwner(f.paths, f.group)!; prepareTargetDelivery(f.paths, h, T, LIMITS);
  const rename = fs.renameSync; let faulted = false, calls = 0;
  t.mock.method(fs, "renameSync", ((a, b) => {
    const hit = b === f.reservation && read(String(a)).phase === "submitting"; rename(a, b);
    if (hit) { faulted = true; throw Error("lost submitting commit answer"); }
  }) as typeof rename);
  await assert.rejects(submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; return {}; }));
  t.mock.restoreAll(); assert.equal(faulted, true); assert.equal(read(f.reservation).phase, "submitting");
  await assert.rejects(submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; return {}; })); assert.equal(calls, 0);
});
test("partial queue-ID persistence preserves known ID and permits only exact late completion", async t => {
  const f = targetFixture(t), h = reserveTargetOwner(f.paths, f.group)!; prepareTargetDelivery(f.paths, h, T, LIMITS);
  const rename = fs.renameSync; let faulted = false, calls = 0;
  t.mock.method(fs, "renameSync", ((a, b) => {
    if (!faulted && b === f.attempt(2) && read(String(a)).state === "submitted") { faulted = true; throw Error("second queue receipt write"); } rename(a, b);
  }) as typeof rename);
  await assert.rejects(submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; return { queueId: QUEUE }; }));
  t.mock.restoreAll(); assert.equal(faulted, true); assert.equal(read(f.attempt(1)).queueId, QUEUE); assert.equal(read(f.reservation).phase, "submitting");
  assert.throws(() => finishTargetSubmission(f.paths, h), "unknown response cannot erase known queue ID");
  assert.equal(read(f.attempt(1)).queueId, QUEUE);
  assert.equal(finishTargetSubmission(f.paths, h, QUEUE).phase, "submitted"); assert.equal(calls, 1);
  assert.equal(read(f.budget).turns.length, 1);
});
for (const kind of ["legacy", "partial", "corrupt", "wrong-group", "array-phase"]) test(`old or inconsistent reservation ${kind} never launches`, async t => {
  const f = targetFixture(t), h = reserveTargetOwner(f.paths, f.group)!, value = read(f.reservation);
  if (kind === "legacy") fs.writeFileSync(f.reservation, JSON.stringify({ version: 1, owner: h.owner, messageIds: f.group.members.map(m => m.messageId) }));
  else if (kind === "corrupt") fs.writeFileSync(f.reservation, "{");
  else { if (kind === "partial") delete value.phase; if (kind === "wrong-group") value.group.members.pop(); if (kind === "array-phase") value.phase = ["reserved"]; fs.writeFileSync(f.reservation, JSON.stringify(value)); }
  assert.equal(reserveTargetOwner(f.paths, f.group), null); assert.throws(() => prepareTargetDelivery(f.paths, h, T, LIMITS));
  let calls = 0; await assert.rejects(submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; return {}; })); assert.equal(calls, 0);
});
