import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { takeTurn } from "./autonomy.mts";
import { auditLines, arrive, listen, lockFile, SELF, setup, T0 } from "./wake-fixture.mts";

for (const transient of ["spacing", "locked"]) test(`${transient} at rearm deadline keeps polling inside the lifetime margin`, async t => {
  const { paths } = setup(t);
  const budgetLock = lockFile(paths).replace(/\.json$/, ".turns.json.lock");
  if (transient === "spacing") assert.equal(takeTurn(paths, SELF, T0), "ok");
  else { fs.mkdirSync(path.dirname(budgetLock), { recursive: true }); fs.writeFileSync(budgetLock, "synthetic-holder"); }
  let retained = false;
  const result = await listen(paths, { maxWaitMs: 10_000, tick: clock => {
    if (clock > T0 + 10_000) { retained = true; assert.ok(fs.existsSync(lockFile(paths))); }
    if (clock >= T0 + 20_000 && transient === "locked") fs.rmSync(budgetLock, { force: true });
  } });
  assert.equal(result.code, 2);
  assert.equal(retained, true);
  assert.equal(auditLines(paths).at(-1)?.action, "rearm");
  assert.equal(fs.existsSync(lockFile(paths)), false);
});

test("an unavailable budget at the finite lifetime exits with a fixed audit", async t => {
  const { paths } = setup(t, { wake: { enabled: true, sessions: ["review"], budget: { perDay: 1 } } });
  takeTurn(paths, SELF, T0); arrive(paths, 901, T0 + 1);
  let lastPoll = T0;
  const result = await listen(paths, { maxWaitMs: 10_000, tick: clock => { lastPoll = clock; } });
  assert.deepEqual(result, { code: 0 });
  assert.ok(lastPoll < T0 + 70_000, "exits before native hook timeout");
  assert.equal(auditLines(paths).at(-1)?.action, "listener-timeout");
  assert.equal(auditLines(paths).filter(line => line.action === "budget").length, 1);
  assert.equal(fs.existsSync(lockFile(paths)), false);
});

test("transient budget lock contention does not restart an exhausted audit episode", async t => {
  const { paths } = setup(t, { wake: { enabled: true, sessions: ["review"], budget: { perDay: 1 } } });
  takeTurn(paths, SELF, T0); arrive(paths, 902, T0 + 1);
  const budgetLock = lockFile(paths).replace(/\.json$/, ".turns.json.lock");
  let once = false;
  await listen(paths, { maxWaitMs: 10_000, tick: clock => {
    if (!once && clock >= T0 + 6_000) { once = true; fs.writeFileSync(budgetLock, "synthetic-holder"); }
    else if (once) fs.rmSync(budgetLock, { force: true });
  } });
  assert.equal(auditLines(paths).filter(line => line.action === "budget").length, 1);
});

test("an expiring listener never removes a replacement owner's lock", async t => {
  const { paths } = setup(t, { wake: { enabled: true, sessions: ["review"], budget: { perDay: 1 } } });
  takeTurn(paths, SELF, T0);
  let replaced = false;
  const result = await listen(paths, { maxWaitMs: 10_000, tick: clock => {
    if (!replaced && clock >= T0 + 68_000) {
      replaced = true;
      const held = JSON.parse(fs.readFileSync(lockFile(paths), "utf8"));
      fs.writeFileSync(lockFile(paths), JSON.stringify({ ...held, token: "replacement", order: held.order + 1 }));
    }
  } });
  assert.deepEqual(result, { code: 0 });
  assert.equal(JSON.parse(fs.readFileSync(lockFile(paths), "utf8")).token, "replacement");
  assert.equal(auditLines(paths).at(-1)?.action, "superseded");
});
