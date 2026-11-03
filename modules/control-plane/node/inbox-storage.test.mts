import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getMessage, listInbox, markDelivered, messageIds, storeMessage } from "./inbox.mts";
import { fixture, ID } from "./inbox-storage-fixture.mts";
import { withRecordLock, withRecordLockBudget, RecordLockBusy } from "./inbox-record-lock.mts";
import { inboxIndex } from "./inbox-index.mts";

test("bound records are published only in bound-v1 and updates stay there", t => {
  const f = fixture(t); storeMessage(f.paths.inbox, f.body);
  assert.equal(fs.existsSync(f.flat), false); assert.equal(fs.existsSync(f.bound), true);
  assert.equal(getMessage(f.paths.inbox, ID)?.binding?.version, 1);
  markDelivered(f.paths.inbox, ID);
  assert.equal(getMessage(f.paths.inbox, ID)?.state, "delivered");
  assert.equal(fs.existsSync(f.flat), false);
  assert.deepEqual(messageIds(f.paths.inbox), [ID]);
});
test("duplicate, flat bound and bound namespace unbound records fail closed without changing bytes", t => {
  const f = fixture(t); const record = storeMessage(f.paths.inbox, f.body);
  fs.writeFileSync(f.flat, JSON.stringify(record));
  const before = fs.readFileSync(f.flat);
  assert.throws(() => getMessage(f.paths.inbox, ID)); assert.throws(() => listInbox(f.paths.inbox));
  assert.deepEqual(fs.readFileSync(f.flat), before);
  fs.rmSync(f.bound); assert.throws(() => getMessage(f.paths.inbox, ID));
  fs.rmSync(f.flat); const { binding: _binding, ...legacy } = record;
  fs.writeFileSync(f.bound, JSON.stringify(legacy)); assert.throws(() => getMessage(f.paths.inbox, ID));
});
test("invalid bindings and hardlinked or symlinked records never downgrade", t => {
  const f = fixture(t); const record = storeMessage(f.paths.inbox, f.body);
  for (const binding of [null, { ...record.binding, version: 2 }]) {
    fs.writeFileSync(f.bound, JSON.stringify({ ...record, binding }));
    assert.throws(() => getMessage(f.paths.inbox, ID));
  }
  fs.writeFileSync(f.bound, JSON.stringify(record)); fs.linkSync(f.bound, path.join(f.root, "other.json"));
  assert.throws(() => getMessage(f.paths.inbox, ID)); fs.rmSync(path.join(f.root, "other.json"));
  fs.renameSync(f.bound, path.join(f.root, "other.json")); fs.symlinkSync(path.join(f.root, "other.json"), f.bound);
  assert.throws(() => getMessage(f.paths.inbox, ID));
});
test("unknown namespace and cached collision cannot choose a body or resurrect one", t => {
  const f = fixture(t); const record = storeMessage(f.paths.inbox, f.body); const index = inboxIndex(f.paths.inbox);
  assert.equal(index.records().length, 1); fs.rmSync(f.bound); assert.deepEqual(index.records(), []);
  fs.writeFileSync(f.bound, JSON.stringify(record)); index.records(); fs.writeFileSync(f.flat, JSON.stringify(record));
  assert.throws(() => index.records()); fs.rmSync(f.flat); fs.mkdirSync(path.join(f.paths.inbox, "bound-v2"));
  assert.throws(() => listInbox(f.paths.inbox));
});
test("bound creation uses the common root UUID lock", t => {
  const f = fixture(t); fs.mkdirSync(f.paths.inbox, { recursive: true });
  withRecordLock(f.paths.inbox, ID, () => {
    assert.throws(() => withRecordLockBudget(0, () => storeMessage(f.paths.inbox, f.body)), RecordLockBusy);
    assert.equal(fs.existsSync(f.bound), false);
  });
});
test("generic non-inbox UUID enumerators retain flat store behavior", t => {
  const f = fixture(t);
  for (const name of ["sent", "outbox", "tasks", "refusals", "operations", "requests", "registrations", "history"]) {
    const dir = path.join(f.root, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, `${ID}.json`), "{}");
    fs.mkdirSync(path.join(dir, "unrelated")); fs.writeFileSync(path.join(dir, "unrelated", `${ID}.json`), "{}");
    assert.deepEqual(messageIds(dir), [ID]);
  }
});

test("selected storage reads inspect only exact UUID candidates without population enumeration", t => {
  const f = fixture(t); storeMessage(f.paths.inbox, f.body);
  fs.writeFileSync(path.join(f.paths.inbox, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"), "POISON");
  const list = fs.readdirSync;
  t.mock.method(fs, "readdirSync", ((dir: fs.PathLike, ...args: unknown[]) => {
    if (String(dir).startsWith(f.paths.inbox)) throw new Error("population enumeration forbidden");
    return Reflect.apply(list, fs, [dir, ...args]);
  }) as typeof fs.readdirSync);
  assert.equal(getMessage(f.paths.inbox, ID)?.text, f.body.text);
});

test("symlinked storage parents and nonregular records fail closed", t => {
  const f = fixture(t); storeMessage(f.paths.inbox, f.body);
  const namespace = path.dirname(f.bound), moved = path.join(f.root, "moved");
  fs.renameSync(namespace, moved); fs.symlinkSync(moved, namespace, "dir");
  assert.throws(() => getMessage(f.paths.inbox, ID));
  assert.throws(() => storeMessage(f.paths.inbox, f.body));
  fs.unlinkSync(namespace); fs.renameSync(moved, namespace); fs.rmSync(f.bound); fs.mkdirSync(f.bound);
  assert.throws(() => getMessage(f.paths.inbox, ID));
  fs.rmdirSync(f.bound); fs.renameSync(f.paths.inbox, moved); fs.symlinkSync(moved, f.paths.inbox, "dir");
  assert.throws(() => getMessage(f.paths.inbox, ID));
});

test("failed atomic rename leaves no published body; published-before-receipt restart is idempotent", t => {
  const f = fixture(t); const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.bound) throw new Error("synthetic pre-rename crash"); return rename(from, to);
  }) as typeof fs.renameSync);
  assert.throws(() => storeMessage(f.paths.inbox, f.body), /pre-rename/);
  assert.equal(getMessage(f.paths.inbox, ID), null); assert.equal(fs.existsSync(f.flat), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.bound)), []);
  t.mock.restoreAll();
  t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
    rename(from, to); if (String(to) === f.bound) throw new Error("synthetic post-rename crash");
  }) as typeof fs.renameSync);
  assert.throws(() => storeMessage(f.paths.inbox, f.body), /post-rename/);
  const bytes = fs.readFileSync(f.bound); t.mock.restoreAll();
  assert.equal(storeMessage(f.paths.inbox, f.body).text, f.body.text);
  assert.deepEqual(fs.readFileSync(f.bound), bytes); assert.equal(fs.existsSync(f.flat), false);
  assert.equal(inboxIndex(f.paths.inbox).records().length, 1);
});

test("cached identity revalidates replacement, hardlink changes and namespace collisions", t => {
  const f = fixture(t); storeMessage(f.paths.inbox, f.body); const index = inboxIndex(f.paths.inbox); index.records();
  const current = getMessage(f.paths.inbox, ID)!, before = fs.statSync(f.bound);
  const replacement = path.join(f.root, "replacement.json"); fs.writeFileSync(replacement, JSON.stringify({ ...current, state: "delivered" }));
  fs.utimesSync(replacement, before.atime, before.mtime); fs.renameSync(replacement, f.bound);
  assert.equal(index.records()[0].state, "delivered");
  fs.linkSync(f.bound, replacement); assert.throws(() => index.records());
  fs.unlinkSync(replacement); assert.equal(index.records()[0].state, "delivered");
});

test("competing processes creating one bound UUID publish exactly one immutable owner/body", async t => {
  const f = fixture(t), moduleUrl = pathToFileURL(path.join(import.meta.dirname, "inbox.mts")).href;
  const code = `import { storeMessage } from ${JSON.stringify(moduleUrl)}; try { storeMessage(process.argv[1], JSON.parse(process.argv[2])); } catch (e) { if (e.message === "message redelivery mismatch") process.exit(2); throw e; }`;
  const run = (text: string) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.paths.inbox, JSON.stringify({ ...f.body, text })],
      { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", b => { error += b; });
    child.on("error", reject); child.on("exit", code => code === 0 || code === 2 ? resolve(code) : reject(new Error(error)));
  });
  assert.deepEqual((await Promise.all([run("Synthetic competing A"), run("Synthetic competing B")])).sort(), [0, 2]);
  assert.ok(["Synthetic competing A", "Synthetic competing B"].includes(getMessage(f.paths.inbox, ID)!.text));
  assert.equal(fs.existsSync(f.flat), false); assert.deepEqual(fs.readdirSync(path.dirname(f.bound)), [`${ID}.json`]);
  assert.equal(fs.existsSync(path.join(f.paths.inbox, `.${ID}.json.lock`)), false);
});

test("Purge-correction: yielded location preflight preserves parent identity across pauses and synchronous validators", async t => {
  const storage = await import("./inbox-storage.mts"); const f = fixture(t);
  storeMessage(f.paths.inbox, f.body); const second = crypto.randomUUID(); storeMessage(f.paths.inbox, { ...f.body, messageId: second });
  assert.deepEqual(storage.inboxRecordIds(f.paths.inbox).sort(), [ID, second].sort());
  assert.equal(storage.inboxRecordLocations(f.paths.inbox).length, 2);
  let reads = 0; const open = fs.openSync;
  t.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file).startsWith(f.paths.inbox + path.sep) && String(file).endsWith(".json")) reads++;
    return Reflect.apply(open, fs, [file, ...args]);
  }) as typeof fs.openSync);
  const steps = storage.inboxRecordLocationSteps(f.paths.inbox);
  assert.equal(steps.next().done, false); assert.equal(reads, 0);
  for (let n = 0; reads === 0 && n < 100; n++) assert.equal(steps.next().done, false);
  assert.equal(reads, 1);
  const namespace = path.dirname(f.bound), moved = path.join(f.root, "moved-namespace");
  fs.renameSync(namespace, moved); fs.mkdirSync(namespace);
  for (const name of fs.readdirSync(moved)) fs.copyFileSync(path.join(moved, name), path.join(namespace, name));
  assert.throws(() => { for (;;) if (steps.next().done) break; }, /directory changed/);
  fs.writeFileSync(f.bound, JSON.stringify({ ...getMessage(f.paths.inbox, ID), binding: null }));
  assert.throws(() => storage.inboxRecordIds(f.paths.inbox));
  assert.throws(() => storage.inboxRecordLocations(f.paths.inbox));
});
