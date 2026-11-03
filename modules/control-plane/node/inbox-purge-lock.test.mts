import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { getMessage, getReceipt, INBOX_RETENTION_MS, markDelivered, markReported, storeMessage } from "./inbox.mts";
import { purgeInbox, purgeInboxSteps, drain } from "./inbox-purge.mts";
import { watchInboxReads } from "./inbox-read-fixture.mts";
import { fixture as storageFixture, ID as STORAGE_ID } from "./inbox-storage-fixture.mts";

// Purge judgments and removal stay under the common UUID lock (#627).
const ID = "00000000-0000-4000-8000-0000000000a1";
const T0 = Date.UTC(2026, 9, 1);
const LATER = T0 + INBOX_RETENTION_MS + 60_000;
const lock = (dir: string): string => path.join(dir, `.${ID}.json.lock`);

function inbox(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-purge-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "inbox");
  storeMessage(dir, { messageId: ID, from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "s-a" }, toSession: "s1",
    text: "hello", createdAt: new Date(T0).toISOString() }, T0);
  return dir;
}

// Deliver after the read-only preflight captured accepted, before mutation.
// Its accepted receipt must not confirm the newer delivery (#195).
for (const kind of ["legacy", "bound"] as const) test(`a ${kind} record delivered after the purge listed it accepted stays until a receipt confirms delivered`, t => {
  const f = storageFixture(t), dir = f.paths.inbox, id = STORAGE_ID;
  const { binding: _binding, ...legacy } = f.body; storeMessage(dir, kind === "bound" ? f.body : legacy, T0);
  const file = kind === "bound" ? f.bound : f.flat; markReported(dir, id, "accepted", "accepted", T0 + 1);
  const reads = watchInboxReads(t, selected => selected === file), steps = purgeInboxSteps(dir, LATER);
  while (reads.reads() === 0) assert.equal(steps.next().done, false, "purge must reach the selected record read");
  assert.equal(reads.counts.get(file), 1, "the accepted location was actually read before delivery");
  reads.restore();
  assert.equal(getMessage(dir, id)?.state, "accepted");
  assert.equal(markDelivered(dir, id)?.state, "delivered");
  const delivered = fs.readFileSync(file);
  assert.equal(getReceipt(dir, id)?.reportedState, "accepted");
  assert.equal(drain(steps), 0);
  assert.deepEqual(fs.readFileSync(file), delivered, "purge must preserve the exact unconfirmed delivery bytes");
  assert.equal(getMessage(dir, id)?.state, "delivered");
  assert.equal(getReceipt(dir, id)?.reportedState, "accepted");
});

test("a settled record is removed under its lock, with its sidecars", (t) => {
  const dir = inbox(t);
  markDelivered(dir, ID);
  markReported(dir, ID, "delivered", "delivered", T0 + 1);
  const locked: boolean[] = [];
  const real = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (p: fs.PathLike) => {
    if (String(p).endsWith(`${path.sep}${ID}.json`) && path.dirname(String(p)) === dir) locked.push(fs.existsSync(lock(dir)));
    return real(p);
  });
  assert.equal(purgeInbox(dir, LATER), 1);
  assert.deepEqual(locked, [true], "the record file went while its lock was held");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["receipts"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "receipts")), []);
});

// The record is young (received at LATER), so nothing takes its lock; only the
// leftover rule can remove the old lock file.
test("the purge removes a leftover lock of retention age and keeps a young record untouched", (t) => {
  const dir = inbox(t);
  const young = path.join(dir, `${ID}.json`);
  const record = JSON.parse(fs.readFileSync(young, "utf8")) as { receivedAt: string };
  fs.writeFileSync(young, JSON.stringify({ ...record, receivedAt: new Date(LATER).toISOString() }));
  fs.writeFileSync(lock(dir), `${JSON.stringify({ pid: 1, at: new Date(T0).toISOString() })}\n`);
  fs.utimesSync(lock(dir), new Date(T0), new Date(T0));
  const temp = path.join(dir, ".old.tmp"); fs.writeFileSync(temp, "leftover"); fs.utimesSync(temp, new Date(T0), new Date(T0));
  assert.equal(purgeInbox(dir, LATER), 0);
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]);
  assert.equal(getMessage(dir, ID)?.state, "accepted");
});

test("bound purge keeps common lock, refusal-first, touchedSince and sidecar removal ordering", async t => {
  const { fixture, ID: boundId } = await import("./inbox-storage-fixture.mts");
  const { purgeInboxSteps, drain } = await import("./inbox-purge.mts");
  const { setMessageProgress, progressFileOf, proxiedFileOf, receiptFileOf } = await import("./inbox.mts");
  const f = fixture(t); storeMessage(f.paths.inbox, f.body, T0);
  setMessageProgress(f.paths.inbox, boundId, "waiting", "target-busy", T0 + 1);
  fs.mkdirSync(path.dirname(proxiedFileOf(f.paths.inbox, boundId)), { recursive: true });
  fs.writeFileSync(proxiedFileOf(f.paths.inbox, boundId), "{}");
  assert.equal(purgeInbox(f.paths.inbox, LATER), 0);
  assert.equal(getMessage(f.paths.inbox, boundId)?.state, "refused");
  markReported(f.paths.inbox, boundId, "refused", "refused", T0 + 2);
  const touched = fs.statSync(f.bound).mtimeMs;
  assert.equal(drain(purgeInboxSteps(f.paths.inbox, LATER, INBOX_RETENTION_MS, touched)), 0);
  const held: boolean[] = [], unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (String(file) === f.bound) held.push(fs.existsSync(path.join(f.paths.inbox, `.${boundId}.json.lock`)));
    return unlink(file);
  });
  assert.equal(purgeInbox(f.paths.inbox, LATER), 1); assert.deepEqual(held, [true]);
  assert.equal(fs.existsSync(f.flat), false);
  for (const file of [receiptFileOf(f.paths.inbox, boundId), progressFileOf(f.paths.inbox, boundId), proxiedFileOf(f.paths.inbox, boundId)]) assert.equal(fs.existsSync(file), false);
});

test("bound purge rejects duplicate or malformed namespace state before removing either copy", async t => {
  const { fixture, ID: boundId } = await import("./inbox-storage-fixture.mts"); const f = fixture(t);
  const record = storeMessage(f.paths.inbox, f.body, T0); fs.writeFileSync(f.flat, JSON.stringify(record));
  const bytes = fs.readFileSync(f.bound); assert.throws(() => purgeInbox(f.paths.inbox, LATER));
  assert.deepEqual(fs.readFileSync(f.bound), bytes); assert.equal(fs.existsSync(f.flat), true);
  fs.rmSync(f.flat); fs.writeFileSync(f.bound, JSON.stringify({ ...record, binding: null }));
  assert.throws(() => purgeInbox(f.paths.inbox, LATER)); assert.equal(fs.existsSync(f.bound), true);
  assert.equal(boundId, record.messageId);
});

test("a held common root lock makes bound purge leave the body and sidecars untouched", async t => {
  const { fixture, ID: boundId } = await import("./inbox-storage-fixture.mts");
  const { withRecordLock, withRecordLockBudget } = await import("./inbox-record-lock.mts");
  const { receiptFileOf } = await import("./inbox.mts");
  const f = fixture(t); storeMessage(f.paths.inbox, f.body, T0); const before = fs.readFileSync(f.bound);
  markReported(f.paths.inbox, boundId, "accepted", "accepted", T0 + 1);
  withRecordLock(f.paths.inbox, boundId, () => {
    assert.equal(withRecordLockBudget(0, () => purgeInbox(f.paths.inbox, LATER)), 0);
    assert.deepEqual(fs.readFileSync(f.bound), before); assert.equal(fs.existsSync(receiptFileOf(f.paths.inbox, boundId)), true);
  });
});

for (const kind of ["legacy", "bound", "mixed"] as const) test(`Purge-correction: ${kind} first yield and every young-record step have bounded work`, async t => {
  const { fixture: storageFixture } = await import("./inbox-storage-fixture.mts"); const f = storageFixture(t);
  for (let n = 0; n < 20; n++) {
    const { binding: _binding, ...legacy } = f.body;
    storeMessage(f.paths.inbox, { ...(kind === "bound" || kind === "mixed" && n % 2 ? f.body : legacy), messageId: crypto.randomUUID() });
  }
  if (kind !== "legacy") for (let n = 0; n < 20; n++) fs.writeFileSync(path.join(f.paths.inbox, "bound-v1", `.synthetic-${n}.tmp`), "temporary");
  for (let n = 0; n < 20; n++) for (const suffix of ["tmp", "lock"]) fs.writeFileSync(path.join(f.paths.inbox, `.synthetic-${n}.${suffix}`), "temporary");
  let opens = 0, listings = 0, tempStats = 0;
  const open = fs.openSync, list = fs.readdirSync, stat = fs.lstatSync;
  t.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file).startsWith(f.paths.inbox + path.sep) && String(file).endsWith(".json")) opens++;
    return Reflect.apply(open, fs, [file, ...args]);
  }) as typeof fs.openSync);
  t.mock.method(fs, "readdirSync", ((dir: fs.PathLike, ...args: unknown[]) => { listings++; return Reflect.apply(list, fs, [dir, ...args]); }) as typeof fs.readdirSync);
  t.mock.method(fs, "lstatSync", ((file: fs.PathLike, ...args: unknown[]) => {
    if (path.basename(String(file)).startsWith(".synthetic-")) tempStats++;
    return Reflect.apply(stat, fs, [file, ...args]);
  }) as typeof fs.lstatSync);
  const steps = purgeInboxSteps(f.paths.inbox); let previous = [0, 0, 0], count = 0;
  for (;;) {
    const step = steps.next(), current = [opens, listings, tempStats];
    if (count++ === 0) assert.deepEqual(current, [0, 0, 0], "first yield precedes filesystem work");
    assert.ok(current[0] - previous[0] <= 1, "no whole body population hidden in a later step");
    assert.ok(current[1] - previous[1] <= 1, "at most one structural readdir per step");
    assert.ok(current[2] - previous[2] <= 1, "bound temp names validate one per step");
    assert.equal(list(f.paths.inbox).some(name => name.endsWith(".json.lock")), false, "no UUID lock survives a yield");
    previous = current;
    if (step.done) { assert.equal(step.value, 0); break; }
  }
  assert.ok(count > 40); assert.ok(opens >= 40, "preflight and mutation both re-read the young records");
});

for (const fault of ["malformed", "null-binding", "unknown-binding", "bound-flat", "unbound-bound", "duplicate", "namespace", "record-symlink", "hardlink", "parent-symlink", "root-tmp-symlink", "root-tmp-hardlink", "root-tmp-directory", "root-lock-symlink", "root-lock-hardlink", "root-lock-directory", "bound-tmp-symlink", "bound-tmp-hardlink", "bound-lock"] as const) {
  test(`Purge-correction: late ${fault} preflight fault leaves earlier settled bodies, sidecars and temps unchanged`, async t => {
    const { fixture: storageFixture } = await import("./inbox-storage-fixture.mts"); const f = storageFixture(t);
    for (let n = 1; n <= 2; n++) {
      const { binding: _binding, ...legacy } = f.body;
      const messageId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      storeMessage(f.paths.inbox, { ...(n === 1 ? legacy : f.body), messageId }, T0);
      markDelivered(f.paths.inbox, messageId); markReported(f.paths.inbox, messageId, "delivered", "delivered", T0 + 1);
    }
    const badId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const bad = storeMessage(f.paths.inbox, { ...f.body, messageId: badId }, T0);
    const bound = path.join(f.paths.inbox, "bound-v1", `${badId}.json`), flat = path.join(f.paths.inbox, `${badId}.json`);
    const temp = path.join(f.paths.inbox, ".old.tmp"); fs.writeFileSync(temp, "temporary"); fs.utimesSync(temp, new Date(T0), new Date(T0));
    if (fault === "malformed") fs.writeFileSync(bound, "{");
    if (fault === "null-binding") fs.writeFileSync(bound, JSON.stringify({ ...bad, binding: null }));
    if (fault === "unknown-binding") fs.writeFileSync(bound, JSON.stringify({ ...bad, binding: { ...bad.binding, version: 2 } }));
    if (fault === "bound-flat") fs.renameSync(bound, flat);
    if (fault === "unbound-bound") { const { binding: _binding, ...legacy } = bad; fs.writeFileSync(bound, JSON.stringify(legacy)); }
    if (fault === "duplicate") fs.copyFileSync(bound, flat);
    if (fault === "namespace") fs.mkdirSync(path.join(f.paths.inbox, "bound-v9"));
    if (fault === "record-symlink") { const target = path.join(f.root, "moved.json"); fs.renameSync(bound, target); fs.symlinkSync(target, bound); }
    if (fault === "hardlink") fs.linkSync(bound, path.join(f.root, "linked.json"));
    if (fault === "parent-symlink") { const target = path.join(f.root, "moved"); fs.renameSync(path.dirname(bound), target); fs.symlinkSync(target, path.dirname(bound), "dir"); }
    if (fault.startsWith("root-") || fault.startsWith("bound-tmp") || fault === "bound-lock") {
      const target = path.join(f.root, "unrelated"); fs.writeFileSync(target, "unrelated target");
      const entry = path.join(f.paths.inbox, ...(fault.startsWith("bound-") ? ["bound-v1"] : []), fault.includes("lock") ? ".bad.lock" : ".bad.tmp");
      if (fault.endsWith("symlink")) fs.symlinkSync(target, entry);
      else if (fault.endsWith("hardlink")) fs.linkSync(target, entry);
      else fs.mkdirSync(entry);
    }
    const snapshot = (): Record<string, string> => {
      const result: Record<string, string> = {};
      const visit = (dir: string): void => {
        for (const name of fs.readdirSync(dir).sort()) {
          const file = path.join(dir, name), stat = fs.lstatSync(file), relative = path.relative(f.root, file);
          if (stat.isSymbolicLink()) result[relative] = "link:" + fs.readlinkSync(file);
          else if (stat.isDirectory()) { result[relative] = "directory"; visit(file); }
          else result[relative] = `${stat.nlink}:` + fs.readFileSync(file).toString("base64");
        }
      };
      visit(f.root); return result;
    };
    const before = snapshot();
    const list = fs.readdirSync;
    t.mock.method(fs, "readdirSync", ((dir: fs.PathLike, ...args: unknown[]) => {
      const result = Reflect.apply(list, fs, [dir, ...args]);
      return Array.isArray(result) && result.every(v => typeof v === "string") ? result.sort() : result;
    }) as typeof fs.readdirSync);
    assert.throws(() => purgeInbox(f.paths.inbox, LATER));
    assert.deepEqual(snapshot(), before, "no early refusal, deletion, sidecar removal or temporary cleanup");
  });
}

for (const change of ["vanish-preflight", "vanish-cleanup", "symlink", "hardlink", "replace", "refresh", "parent-replace", "parent-symlink", "bound-parent-replace", "bound-parent-symlink", "parent-appear"] as const) {
  test(`Temp preflight: between-step ${change}`, t => {
    const dir = inbox(t); markDelivered(dir, ID); markReported(dir, ID, "delivered", "delivered", T0 + 1);
    const file = path.join(dir, ".synthetic.tmp"), target = path.join(path.dirname(dir), "unrelated");
    fs.writeFileSync(file, "old leftover"); fs.utimesSync(file, new Date(T0), new Date(T0)); fs.writeFileSync(target, "target bytes");
    if (change.startsWith("bound-parent")) fs.mkdirSync(path.join(dir, "bound-v1"));
    const before = fs.readFileSync(path.join(dir, `${ID}.json`));
    let checked = 0, listed = 0;
    const stat = fs.lstatSync, list = fs.readdirSync;
    t.mock.method(fs, "lstatSync", ((p: fs.PathLike, ...args: unknown[]) => {
      if (String(p) === file) checked++; return Reflect.apply(stat, fs, [p, ...args]);
    }) as typeof fs.lstatSync);
    t.mock.method(fs, "readdirSync", ((p: fs.PathLike, ...args: unknown[]) => {
      if (String(p) === dir) listed++; return Reflect.apply(list, fs, [p, ...args]);
    }) as typeof fs.readdirSync);
    const steps = purgeInboxSteps(dir, LATER);
    while (change === "vanish-preflight" ? listed < 2 : checked < 1) assert.equal(steps.next().done, false);
    if (change.startsWith("vanish")) fs.unlinkSync(file);
    if (change === "symlink" || change === "hardlink") {
      fs.unlinkSync(file); if (change === "symlink") fs.symlinkSync(target, file); else fs.linkSync(target, file);
    }
    if (change === "replace") { fs.renameSync(file, file + ".saved"); fs.writeFileSync(file, "replacement"); fs.utimesSync(file, new Date(T0), new Date(T0)); }
    if (change === "refresh") fs.utimesSync(file, new Date(LATER), new Date(LATER));
    if (change === "parent-appear") { fs.mkdirSync(path.join(dir, "bound-v1")); assert.throws(() => drain(steps), /directory/); assert.deepEqual(fs.readFileSync(path.join(dir, `${ID}.json`)), before); return; }
    if (change.includes("parent-")) {
      const parent = change.startsWith("bound-") ? path.join(dir, "bound-v1") : dir, moved = parent + "-moved";
      fs.renameSync(parent, moved);
      if (change.endsWith("symlink")) fs.symlinkSync(moved, parent, "dir"); else fs.mkdirSync(parent);
      const preserved = change.startsWith("bound-") ? dir : moved;
      assert.throws(() => drain(steps), /directory/); assert.deepEqual(fs.readFileSync(path.join(preserved, `${ID}.json`)), before);
      assert.equal(fs.readFileSync(path.join(preserved, ".synthetic.tmp"), "utf8"), "old leftover"); return;
    }
    if (change === "symlink" || change === "hardlink") {
      assert.throws(() => drain(steps), /temporary/); assert.ok(fs.lstatSync(file));
    } else {
      assert.equal(drain(steps), 1);
      assert.equal(fs.existsSync(file), !change.startsWith("vanish"));
      if (change === "replace") assert.equal(fs.readFileSync(file, "utf8"), "replacement");
    }
    assert.equal(fs.readFileSync(target, "utf8"), "target bytes");
  });
}
