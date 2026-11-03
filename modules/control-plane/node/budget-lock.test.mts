import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { budgetOwnerProbe, withBudgetMutation } from "./budget-lock.mts";
import { acquireServiceOwnerFile } from "./service-drain.mts";
const gone = () => { throw Object.assign(Error("synthetic absent"), { code: "ESRCH" }); };
function file(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "budget-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "owner.turns.json");
}
const owner = (pid = 100) => ({ version: 1, pid, startedAt: new Date(0).toISOString(), owner: "synthetic-token" });
for (const state of ["live", "reused", "EPERM", "EIO", "ESRCH"]) test(`strict probe ${state}`, () => {
  const probe = budgetOwnerProbe({ signal: () => { if (!["live", "reused"].includes(state)) throw Object.assign(Error(state), { code: state }); } });
  assert.equal(probe.active(owner() as Parameters<typeof probe.active>[0]), state === "ESRCH" ? false : ["live", "reused"].includes(state) ? true : "unknown");
  assert.equal(probe.active(owner(0) as Parameters<typeof probe.active>[0]), "unknown");
});
for (const value of ["", "{", "0", "-4", "100\n", '{"version":9}']) test(`create gap/corrupt lock stays fenced ${JSON.stringify(value)}`, t => {
  const f = file(t); fs.writeFileSync(`${f}.lock`, value);
  assert.throws(() => withBudgetMutation(f, () => assert.fail("must not enter"), { signal: gone }));
  assert.equal(fs.readFileSync(`${f}.lock`, "utf8"), value);
});
for (const format of ["legacy", "owner"]) test(`positively absent ${format} owner reclaimed, live/unknown stay fenced`, t => {
  const f = file(t), lock = `${f}.lock`, bytes = format === "legacy" ? "100" : JSON.stringify(owner());
  fs.writeFileSync(lock, bytes);
  for (const signal of [() => {}, () => { throw Object.assign(Error("unknown"), { code: "EPERM" }); }]) {
    assert.throws(() => withBudgetMutation(f, () => true, { signal }));
    assert.equal(fs.readFileSync(lock, "utf8"), bytes);
  }
  assert.equal(withBudgetMutation(f, () => 42, { signal: gone }), 42);
  assert.equal(fs.existsSync(lock), false);
});
test("exact token and double release preserve a successor", t => {
  const f = file(t), probe = budgetOwnerProbe();
  const release = acquireServiceOwnerFile(`${f}.lock`, "held", probe);
  fs.writeFileSync(`${f}.lock`, JSON.stringify(owner())); release();
  assert.equal(JSON.parse(fs.readFileSync(`${f}.lock`, "utf8")).owner, "synthetic-token");
  fs.unlinkSync(`${f}.lock`);
  const second = acquireServiceOwnerFile(`${f}.lock`, "held", budgetOwnerProbe());
  release(); assert.equal(fs.existsSync(`${f}.lock`), true); second();
});
test("changed owner during repeated absence proof remains fenced", t => {
  const f = file(t), lock = `${f}.lock`; fs.writeFileSync(lock, "100");
  let n = 0;
  assert.throws(() => withBudgetMutation(f, () => true, { signal: () => {
    if (++n === 1) fs.writeFileSync(lock, "101"); gone();
  } }));
  assert.equal(fs.readFileSync(lock, "utf8"), "101");
});
test("dead reclaim nesting is bounded to four acquisitions", t => {
  const f = file(t), lock = `${f}.lock`;
  for (let i = 0; i < 6; i++) fs.writeFileSync(lock + ".reclaim".repeat(i), JSON.stringify(owner()));
  let probes = 0;
  assert.throws(() => withBudgetMutation(f, () => true, { signal: () => { probes++; gone(); } }));
  assert.ok(probes <= 24); assert.equal(fs.readdirSync(path.dirname(f)).length, 6);
});
test("two reclaimers and a successor never authorize overlapping callbacks", t => {
  const f = file(t); fs.writeFileSync(`${f}.lock`, JSON.stringify(owner()));
  let entered = 0;
  withBudgetMutation(f, () => {
    entered++; assert.throws(() => withBudgetMutation(f, () => entered++, { signal: () => {} }));
  }, { signal: gone });
  withBudgetMutation(f, () => { entered++; }, { signal: () => {} });
  assert.equal(entered, 2);
});
test("symlink and asynchronous mutation callbacks refuse", t => {
  const f = file(t), target = `${f}.target`; fs.writeFileSync(target, "100"); fs.symlinkSync(target, `${f}.lock`);
  assert.throws(() => withBudgetMutation(f, () => true, { signal: gone }));
  fs.unlinkSync(`${f}.lock`);
  assert.throws(() => withBudgetMutation(f, () => Promise.resolve(1)));
});
