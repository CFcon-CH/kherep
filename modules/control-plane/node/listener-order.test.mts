import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, listenerScope, rememberMode } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { sweepListeners, TOMB_RECOVER_AFTER_MS } from "./listener-sweep.mts";
import { arrive, auditLines, listen, lockFile, SELF, setup, T0 } from "./wake-fixture.mts";

// Issue #225, second review: listeners are ordered by the order they armed in,
// never by the wall clock, which can step back (a time sync after resume).

const LIVE = 4242;
const alive = (pid: unknown): boolean => pid === LIVE;
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const tombs = (paths: NodePaths) => fs.readdirSync(listenerDir(paths)).filter((name) => name.endsWith(".tomb"));
const at = (token: string, startedAt: number, order: number) => ({ token, pid: LIVE, startedAt, order, event: "Stop" });

function arm(paths: NodePaths, lock: ReturnType<typeof at>): void {
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  writeJsonAtomic(listenerScope(paths, SELF), { token: lock.token, listed: true, order: lock.order });
  writeJsonAtomic(lockFile(paths), lock);
}

test("a listener armed after a backward clock step still supersedes the older one", async (t) => {
  const { paths } = setup(t, {wake:{enabled:true,sessions:[SELF]}});
  let polls = 0;
  const older = listen(paths, { token: "older", start: T0 });
  // The clock stepped back 5 s before the next arming.
  const newer = listen(paths, { token: "newer", start: T0 - 5000, tick: (clock) => { if (++polls === 2) arrive(paths, 1, clock); } });
  assert.deepEqual(await older, { code: 0 });
  assert.equal((await newer).code, 2);
  assert.deepEqual(auditLines(paths).map((l) => l.action).sort(), ["superseded", "wake"]);
});

test("two armings in the same millisecond: the later one keeps the session", async (t) => {
  const { paths } = setup(t);
  let polls = 0;
  const first = listen(paths, { token: "first" });
  const second = listen(paths, { token: "second", tick: (clock) => { if (++polls === 2) arrive(paths, 1, clock); } });
  assert.deepEqual(await first, { code: 0 });
  assert.equal((await second).code, 2);
});

test("restore and recovery keep the later arming, whatever its wall-clock start", (t) => {
  // P armed after N, but with a smaller wall-clock time; then the same millisecond.
  for (const [p, n] of [[at("t-p", T0 - 5000, T0 + 2), at("t-n", T0, T0 + 1)], [at("t-p", T0, T0 + 1), at("t-n", T0, T0)]]) {
    const { paths } = setup(t);
    arm(paths, { ...at("t-dead", T0 - 9000, T0 - 9000), pid: 1001 });
    let written = 0;
    const result = sweepListeners(paths, { pidAlive: alive, now: T0 + 5000,
      beforeTake: (file) => { if (file === lockFile(paths)) arm(paths, p); },
      afterTake: (file) => { if (file === lockFile(paths) && !fs.existsSync(file) && !written++) writeJsonAtomic(file, n); } });
    assert.deepEqual(result, { removed: 0, kept: 1, failed: [] });
    assert.equal(read(lockFile(paths)).token, "t-p");
    assert.deepEqual(tombs(paths), []);

    const recovered = setup(t).paths;
    arm(recovered, n);
    fs.writeFileSync(path.join(listenerDir(recovered), `.${SELF}.json.${T0}-${crypto.randomUUID()}.tomb`), JSON.stringify(p));
    sweepListeners(recovered, { pidAlive: alive, now: T0 + TOMB_RECOVER_AFTER_MS + 1 });
    assert.equal(read(lockFile(recovered)).token, "t-p");
    assert.deepEqual(tombs(recovered), []);
  }
});

test("a dead lock in a tomb never displaces a live one, whatever its order", (t) => {
  const { paths } = setup(t);
  arm(paths, at("t-live", T0, T0));
  fs.writeFileSync(path.join(listenerDir(paths), `.${SELF}.json.${T0}-${crypto.randomUUID()}.tomb`),
    JSON.stringify({ ...at("t-dead", T0 + 9000, T0 + 9000), pid: 1001 }));
  sweepListeners(paths, { pidAlive: alive, now: T0 + TOMB_RECOVER_AFTER_MS + 1 });
  assert.equal(read(lockFile(paths)).token, "t-live");
  assert.deepEqual(tombs(paths), []);
});

test("a SessionStart listener whose check overlapped a newer arming stands down, though a sweep held that lock aside", async (t) => {
  const { paths } = setup(t);
  rememberMode(paths, SELF, "default");
  const launch = async () => {
    // The prompt's listener armed with a smaller wall-clock time, and the sweep holds its lock aside.
    arm(paths, at("prompt", T0 - 5000, T0 + 1));
    fs.renameSync(lockFile(paths), path.join(listenerDir(paths), `.${SELF}.json.${T0}-${crypto.randomUUID()}.tomb`));
    return "ok" as const;
  };
  const result = await listen(paths, { event: "SessionStart", source: "resume", mode: null, launch, tick: () => assert.fail("no poll") });
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["superseded"]);
  assert.equal(read(listenerScope(paths, SELF)).token, "prompt");
});

test("a read error while marking the SessionStart arming never makes it stand down; corrupt content is no entry", async (t) => {
  const { paths } = setup(t);
  rememberMode(paths, SELF, "default");
  writeJsonAtomic(listenerScope(paths, SELF), { token: "x", listed: true, order: T0 - 1000 });
  // The lock cannot be read when the listener marks it (a directory stands in for a scanner's hold).
  fs.mkdirSync(lockFile(paths));
  const launch = async () => {
    fs.rmSync(lockFile(paths), { recursive: true });
    writeJsonAtomic(lockFile(paths), at("x", T0 - 1000, T0 - 1000));
    return "ok" as const;
  };
  let polls = 0;
  const result = await listen(paths, { event: "SessionStart", source: "resume", mode: null, launch,
    tick: (clock) => { if (++polls === 2) arrive(paths, 1, clock); } });
  assert.equal(result.code, 2);
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["wake"]);

  const corrupt = setup(t).paths;
  fs.mkdirSync(listenerDir(corrupt), { recursive: true });
  fs.writeFileSync(lockFile(corrupt), "{");
  polls = 0;
  assert.equal((await listen(corrupt, { tick: (clock) => { if (++polls === 2) arrive(corrupt, 1, clock); } })).code, 2);
});
