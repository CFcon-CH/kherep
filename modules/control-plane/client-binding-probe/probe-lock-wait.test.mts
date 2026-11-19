import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIntent } from "./binding.mts";
import { LIVE_OWNER_WAIT_MS, LOCK_ATTEMPTS, probeLockFile } from "./probe-lock.mts";

// Issue #982: a contender waits out the proven live owner of another process on
// the clock (LIVE_OWNER_WAIT_MS), not on the allowance of LOCK_ATTEMPTS opens.
// The order is forced: the holder reports "held" before the contender starts.
// The holder releases only once the contender has made RELEASE_AFTER opens, so
// the tests do not depend on how fast opens or pauses run on the host.

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const INPUT = { sessionId: "raw-session", callId: "raw-call", syntheticNonce: "synthetic_nonce_0123456789" };
const PROBE_LOCK = new URL("./probe-lock.mts", import.meta.url).href;
const RELEASE_AFTER = LOCK_ATTEMPTS + 10;
const WAIT = (ms: number): string => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`;
// Holds until the parent creates the release file, at most `ms` (a safety limit).
const HOLD = (release: string, ms: number): string => `{ const end = Date.now() + ${ms}; while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < end) ${WAIT(2)} }`;

function state(t: test.TestContext): { dir: string; lock: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-probe-wait-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "locks"));
  return { dir, lock: probeLockFile(dir, "create") };
}

// A child that holds the lock itself: its action reports "held" and waits.
const lockHolder = (dir: string, ms: number): string =>
  `import fs from "node:fs"; import { withProbeLock } from ${JSON.stringify(PROBE_LOCK)};
   withProbeLock(${JSON.stringify(dir)}, "create", () => { fs.writeSync(1, "held"); ${HOLD(path.join(dir, "release"), ms)} });`;

// A child that stalls as the reclaimer: it reports "held" and waits right after
// the fsync of its owner record in the ".reclaim" gate, before it reclaims. The
// descriptor leaves the set before the wait, so a reused number never stalls again.
const gateHolder = (dir: string, ms: number): string =>
  `import fs from "node:fs"; import { withProbeLock } from ${JSON.stringify(PROBE_LOCK)};
   const gates = new Set(), open = fs.openSync, fsync = fs.fsyncSync;
   fs.openSync = (file, flags, mode) => { const fd = open(file, flags, mode);
     if (flags === "wx" && String(file).endsWith(".lock.reclaim")) gates.add(fd); return fd; };
   fs.fsyncSync = (fd) => { fsync(fd); if (gates.has(fd)) { gates.delete(fd); fs.writeSync(1, "held"); ${HOLD(path.join(dir, "release"), ms)} } };
   withProbeLock(${JSON.stringify(dir)}, "create", () => {});`;

async function holding(t: test.TestContext, script: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => { child.once("close", (code) => resolve(code)); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    void exited.then((code) => reject(new Error(`holder exited ${code}: ${stderr}`)));
  });
  return { child, exited, err: () => stderr };
}

// Counts exclusive creates ("wx") of files in the locks directory. With
// `release`, creates the release file once `release.name` was opened RELEASE_AFTER times.
function wxOpens(t: test.TestContext, release?: { dir: string; name: string }): string[] {
  const real = fs.openSync, seen: string[] = [];
  let released = false;
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (flags === "wx" && path.basename(path.dirname(String(file))) === "locks") seen.push(path.basename(String(file)));
    if (release && !released && seen.filter((name) => name === release.name).length === RELEASE_AFTER) {
      released = true;
      fs.writeFileSync(path.join(release.dir, "release"), "");
    }
    return real(file, flags, mode);
  });
  return seen;
}

const record = (pid: number): string =>
  `${JSON.stringify({ version: 1, pid, token: "0123456789abcdef0123456789abcdef", at: "2026-10-22T00:00:00.000Z" })}\n`;

test("a contender waits out a live reclaimer that holds the gate past the allowance", async (t) => {
  const { dir, lock } = state(t);
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => dead.once("close", resolve));
  fs.writeFileSync(lock, record(dead.pid!));
  const holder = await holding(t, gateHolder(dir, 30_000));
  const opens = wxOpens(t, { dir, name: "create.lock.reclaim" });
  assert.match(createIntent(dir, INPUT, T0).requestId, /^[0-9a-f-]{36}$/);
  assert.ok(opens.filter((name) => name === "create.lock.reclaim").length > LOCK_ATTEMPTS, "the gate wait is not drawn from the allowance");
  assert.equal(await holder.exited, 0, holder.err());
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

test("a contender waits out a live holder of the lock past the allowance", async (t) => {
  const { dir } = state(t);
  const holder = await holding(t, lockHolder(dir, 30_000));
  const opens = wxOpens(t, { dir, name: "create.lock" });
  assert.match(createIntent(dir, INPUT, T0).requestId, /^[0-9a-f-]{36}$/);
  assert.ok(opens.length > LOCK_ATTEMPTS, "the wait is not drawn from the allowance");
  assert.equal(await holder.exited, 0, holder.err());
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

// A missing clock bound shows up here as a hang of about 60 s, until the holder
// gives up, followed by a failure: the call then succeeds instead of throwing.
test("a live owner that does not release fails closed once the wait is over", async (t) => {
  const { dir, lock } = state(t);
  const holder = await holding(t, lockHolder(dir, 60_000));
  const held = fs.readFileSync(lock, "utf8");
  const opens = wxOpens(t);
  // The first reading sets the end of the wait; every later one lies past it.
  const real = performance.now.bind(performance);
  let readings = 0;
  t.mock.method(performance, "now", () => real() + (readings++ === 0 ? 0 : LIVE_OWNER_WAIT_MS));
  assert.throws(() => createIntent(dir, INPUT, T0), (error: unknown) => error instanceof Error
    && error.message === "storage_error" && (error.cause as NodeJS.ErrnoException).code === "EEXIST");
  assert.equal(opens.length, LOCK_ATTEMPTS, "past the wait the allowance bounds the call");
  assert.equal(fs.readFileSync(lock, "utf8"), held);
  assert.equal(holder.child.exitCode, null);
});
