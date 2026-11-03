import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { budgetMarker, debitGroup, MAX_GROUP_DEBITS, parseBudget, recoverBudget, spendTurn, type BudgetRecord, type GroupDebitKey } from "./budget-store.mts";
import { withBudgetMutation } from "./budget-lock.mts";
const T = 1767225600000, limits = { perHour: 2, perDay: 3, spacingMs: 1000 };
const key = (): GroupDebitKey => ({ groupId: crypto.randomUUID(), groupFingerprint: "a".repeat(64), reservationId: crypto.randomUUID() });
function file(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "budget-store-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "listeners")); return path.join(root, "listeners", "owner.turns.json");
}
const read = (f: string): BudgetRecord => JSON.parse(fs.readFileSync(f, "utf8"));
test("legacy duplicate timestamps preserved, exact windows and spacing unchanged", t => {
  const f = file(t); fs.writeFileSync(f, JSON.stringify({ turns: [T, T] }));
  assert.equal(spendTurn(f, T + 1000, limits), "exhausted"); assert.deepEqual(read(f).turns, [T, T]);
  assert.equal(spendTurn(f, T + 3_600_000, limits), "ok"); assert.deepEqual(read(f).turns, [T, T, T + 3_600_000]);
  assert.equal(spendTurn(f, T + 3_601_000, limits), "exhausted");
  assert.equal(spendTurn(f, T + 86_400_000, limits), "ok");
  assert.equal(spendTurn(f, T + 86_400_999, limits), "spacing");
});
test("legacy and group contend for same last slot, legacy preserves ledger forever", t => {
  const f = file(t), k = key(), budget = { perHour: 1, perDay: 1, spacingMs: 0 };
  const first = debitGroup(f, k, T, budget); assert.equal(first.status, "debited");
  assert.equal(spendTurn(f, T + 1, budget), "exhausted");
  assert.deepEqual(debitGroup(f, k, T + 1, budget), { ...first, status: "already-debited" });
  assert.equal(spendTurn(f, T + 86_400_000, budget), "ok"); assert.equal(read(f).groupDebits.length, 1);
  assert.equal(debitGroup(f, k, T + 172_800_000, budget).status, "already-debited");
  assert.equal(debitGroup(f, { ...k, reservationId: crypto.randomUUID() }, T, budget).status, "conflict");
  assert.equal(debitGroup(f, { ...k, groupFingerprint: "b".repeat(64) }, T, budget).status, "conflict");
  const g = file(t); assert.equal(spendTurn(g, T, budget), "ok"); assert.equal(debitGroup(g, key(), T, budget).status, "exhausted");
});
for (const failure of ["write", "flush", "rename", "readback"]) test(`I/O failure at ${failure} refuses; stable group retry never duplicates`, t => {
  const f = file(t), k = key(); assert.equal(spendTurn(f, T - 10000, limits), "ok");
  const write = fs.writeFileSync, flush = fs.fsyncSync, rename = fs.renameSync, readFile = fs.readFileSync, open = fs.openSync;
  const fds = new Map<number, string>(); let renamed = false, failed = false;
  t.mock.method(fs, "openSync", ((...args: Parameters<typeof open>) => {
    const fd = Reflect.apply(open, fs, args); fds.set(fd, String(args[0])); return fd;
  }) as typeof open);
  if (failure === "write") t.mock.method(fs, "writeFileSync", ((...args: Parameters<typeof write>) => {
    if (typeof args[0] === "number" && fds.get(args[0])?.endsWith(".tmp")) { failed = true; throw Error("injected temp write"); }
    return Reflect.apply(write, fs, args);
  }) as typeof write);
  if (failure === "flush") t.mock.method(fs, "fsyncSync", ((fd: number) => {
    if (fds.get(fd)?.endsWith(".tmp")) { failed = true; throw Error("injected temp flush"); } flush(fd);
  }) as typeof flush);
  t.mock.method(fs, "renameSync", ((a, b) => { if (failure === "rename") throw Error("injected rename"); rename(a, b); renamed = true; }) as typeof rename);
  if (failure === "readback") t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof readFile>) => {
    if (renamed && args[0] === f) throw Error("injected readback"); return Reflect.apply(readFile, fs, args);
  }) as typeof readFile);
  assert.equal(debitGroup(f, k, T, limits).status, "locked");
  if (["write", "flush"].includes(failure)) assert.equal(failed, true, "fault reached the actual budget temp, after ownership was acquired");
  t.mock.restoreAll();
  assert.equal(debitGroup(f, k, T, limits).status, renamed ? "already-debited" : "debited");
  assert.equal(read(f).turns.filter(x => x === T).length, 1);
});
test("lost answer recovers exact debit without writing again", t => {
  const f = file(t), k = key(); const first = debitGroup(f, k, T, limits); const bytes = fs.readFileSync(f, "utf8");
  assert.deepEqual(debitGroup(f, k, T + 1, { perHour: 0, perDay: 0, spacingMs: 0 }), { ...first, status: "already-debited" });
  assert.equal(fs.readFileSync(f, "utf8"), bytes);
});
test("marker crash, missing/legacy/mismatched canonical never reset", t => {
  for (const replacement of [null, '{"turns":[]}', '{', JSON.stringify({ version: 9 })]) {
    const f = file(t); assert.equal(spendTurn(f, T, limits), "ok");
    replacement === null ? fs.unlinkSync(f) : fs.writeFileSync(f, replacement);
    assert.equal(spendTurn(f, T + 86_400_000, limits), "locked");
  }
  const f = file(t); fs.writeFileSync(budgetMarker(f), JSON.stringify({ version: 1, budgetId: crypto.randomUUID() }));
  assert.equal(debitGroup(f, key(), T, limits).status, "locked"); assert.equal(fs.existsSync(f), false);
});
test("full bounded ledger refuses new groups but retains legacy semantics and exact existing debit", t => {
  const f = file(t), k = key(); debitGroup(f, k, T, limits); const record = read(f);
  record.groupDebits = Array.from({ length: MAX_GROUP_DEBITS }, (_, i) => ({ ...(i === 0 ? k : key()), chargedAt: T }));
  fs.writeFileSync(f, JSON.stringify(record));
  assert.equal(debitGroup(f, key(), T + 1000, limits).status, "full");
  assert.equal(debitGroup(f, k, T, limits).status, "already-debited");
  assert.equal(spendTurn(f, T + 1000, limits), "ok"); assert.equal(read(f).groupDebits.length, MAX_GROUP_DEBITS);
});
test("unknown records refuse instead of becoming empty", t => {
  for (const bytes of ['{}', '[]', '{"turns":[null]}', '{"turns":[-1]}', '{"turns":[],"extra":1}', 'x'.repeat(1_048_577)]) {
    const f = file(t); fs.writeFileSync(f, bytes); assert.equal(spendTurn(f, T, limits), "locked"); assert.equal(fs.existsSync(budgetMarker(f)), false);
  }
  assert.throws(() => parseBudget('{"version":2,"turns":[]}'));
});
test("matching recovery may restore, conflicting tombstones fence missing budget and all spends", t => {
  const f = file(t), tomb = `${path.dirname(f)}/.${path.basename(f)}.1-${crypto.randomUUID()}.tomb`;
  fs.writeFileSync(tomb, '{"turns":[]}'); assert.equal(spendTurn(f, T, limits), "locked");
  withBudgetMutation(f, () => recoverBudget(f)); assert.equal(spendTurn(f, T, limits), "ok");
  fs.writeFileSync(tomb, '{"turns":[]}');
  assert.throws(() => withBudgetMutation(f, () => recoverBudget(f)));
  assert.equal(debitGroup(f, key(), T, limits).status, "locked");
});
test("Windows replacement retries remain bounded and do not double debit", t => {
  const f = file(t), k = key(), rename = fs.renameSync; let attempts = 0;
  t.mock.method(fs, "renameSync", ((a, b) => { if (++attempts < 3) throw Object.assign(Error("pending"), { code: "EPERM" }); rename(a, b); }) as typeof rename);
  assert.equal(debitGroup(f, k, T, limits, { platform: "win32", sleep: () => {} }).status, "debited");
  assert.equal(attempts, 3); assert.equal(read(f).turns.length, 1);
});

test("crash after durable initialization marker fences the unchanged legacy snapshot", t => {
  const f = file(t); fs.writeFileSync(f, '{"turns":[1,1]}');
  const rename = fs.renameSync; t.mock.method(fs, "renameSync", (() => { throw Error("crash before first commit"); }) as typeof rename);
  assert.equal(spendTurn(f, T, limits), "locked"); t.mock.restoreAll();
  assert.equal(fs.existsSync(budgetMarker(f)), true); assert.equal(fs.readFileSync(f, "utf8"), '{"turns":[1,1]}');
  assert.equal(spendTurn(f, T, limits), "locked");
});
