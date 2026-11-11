import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimBusyHint, publishBusyHint, type BusyHintAdmission } from "./codex-busy-ticket.mts";

// Issue #877: a busy-hint lock left behind by a dead owner, or an empty one
// older than the bound, is replaced atomically; a held lock is never removed.
// The age rule uses the real wall clock, the admissions use NOW in 2027.

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const POLICY = "a".repeat(64), NOW = 1_800_000_000_000;

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-busy-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const admission: BusyHintAdmission = { owner: OWNER, generation: crypto.randomUUID(), admittedAt: NOW,
    expiresAt: NOW + 60_000, policyFingerprint: POLICY,
    messages: [{ messageId: crypto.randomUUID(), toSession: OWNER }] };
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  const file = path.join(directory, `${OWNER}.busy-hint.json`);
  return { directory, admission, file, lock: `${file}.lock` };
}

const newer = (admission: BusyHintAdmission): BusyHintAdmission =>
  ({ ...admission, generation: crypto.randomUUID(), admittedAt: NOW + 1 });
const record = (pid: number, startedAt: number) =>
  JSON.stringify({ version: 1, pid, startedAt, token: crypto.randomUUID() });
const age = (file: string, ms: number) => {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(file, then, then);
};
// A pid whose process has ended and been reaped.
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;

test("an orphaned empty lock older than the bound is recovered", (t) => {
  const { directory, admission, file, lock } = fixture(t);
  fs.writeFileSync(lock, "");
  age(lock, 120_000);
  const next = newer(admission);
  assert.equal(publishBusyHint(directory, next, NOW + 2), "published");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).generation, next.generation);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)], "no lock, gate or tombstone stays");
});

test("a lock of a dead recorded owner is recovered at once", (t) => {
  const { directory, file, lock } = fixture(t);
  fs.writeFileSync(lock, record(deadPid(), 1));
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => 1), { status: "hint", count: 1 });
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test("a lock of this pid with another start time is recovered", (t) => {
  const { directory, admission, file, lock } = fixture(t);
  fs.writeFileSync(lock, record(process.pid, 1));
  assert.equal(publishBusyHint(directory, newer(admission), NOW + 2), "published");
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test("a lock whose release failed is recovered by the next call", (t) => {
  const { directory, file, lock } = fixture(t);
  const mock = t.mock.method(fs, "unlinkSync", () => { throw Object.assign(new Error("synthetic EPERM"), { code: "EPERM" }); });
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => 1), { status: "failed" });
  assert.equal(fs.existsSync(lock), true);
  mock.mock.restore();
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => assert.fail("claimed generation")), { status: "empty" });
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test("a holder whose lock was replaced before its record was written does not run the body", (t) => {
  const { directory, admission, file, lock } = fixture(t);
  const before = fs.readFileSync(file, "utf8"), other = record(process.ppid, 1);
  const realWrite = fs.writeFileSync, realRename = fs.renameSync;
  let replaced = false;
  t.mock.method(fs, "writeFileSync", (target: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
    if (typeof target === "number" && !replaced) {
      replaced = true;
      realRename(lock, `${lock}.moved`);
      realWrite(lock, other);
    }
    return realWrite(target, data, options);
  });
  assert.equal(publishBusyHint(directory, newer(admission), NOW + 2), "busy");
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the body did not run");
  assert.equal(fs.readFileSync(lock, "utf8"), other, "the other owner's lock stays");
});

test("a live owner's lock stays busy however old", (t) => {
  const { directory, admission, file, lock } = fixture(t);
  const before = fs.readFileSync(file, "utf8"), held = record(process.ppid, 1);
  fs.writeFileSync(lock, held);
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal(publishBusyHint(directory, newer(admission), NOW + 2), "busy");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => assert.fail("held lock")), { status: "busy" });
  assert.equal(fs.readFileSync(lock, "utf8"), held);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("a fresh empty lock stays busy", (t) => {
  const { directory, admission, lock } = fixture(t);
  fs.writeFileSync(lock, "");
  assert.equal(publishBusyHint(directory, newer(admission), NOW + 2), "busy");
  assert.equal(fs.readFileSync(lock, "utf8"), "");
});

test("a re-entrant call for the same owner stays busy", (t) => {
  const { directory, admission, file } = fixture(t);
  const inner: unknown[] = [];
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => {
    inner.push(publishBusyHint(directory, newer(admission), NOW + 2));
    inner.push(claimBusyHint(directory, OWNER, POLICY, NOW, () => assert.fail("re-entrant claim")));
    return 1;
  }), { status: "hint", count: 1 });
  assert.deepEqual(inner, ["busy", { status: "busy" }]);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test("a transient code on the reclaim gate stays busy and removes nothing", (t) => {
  const { directory, admission, lock } = fixture(t);
  fs.writeFileSync(lock, "");
  age(lock, 120_000);
  const real = fs.openSync, gate = `${lock}.reclaim.lock`;
  t.mock.method(fs, "openSync", (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (String(target) === gate) throw Object.assign(new Error("synthetic EPERM"), { code: "EPERM", syscall: "open" });
    return real(target, flags, mode);
  });
  assert.equal(publishBusyHint(directory, newer(admission), NOW + 2), "busy");
  assert.equal(fs.readFileSync(lock, "utf8"), "");
  assert.equal(fs.existsSync(gate), false);
});
