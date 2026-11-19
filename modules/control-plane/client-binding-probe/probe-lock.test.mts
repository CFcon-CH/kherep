import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIntent, LOCK_ATTEMPTS, verifyIntent } from "./binding.mts";
import { OWNER_MAX_BYTES, probeLockFile, RECLAIM_DEPTH, withProbeLock } from "./probe-lock.mts";

// Issue #602: a probe lock is recovered automatically only when its owner record
// is complete and its PID is proven absent (operator decision (a), 2026-10-22);
// every other lock stays held, whatever its age.

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const INPUT = { sessionId: "raw-session", callId: "raw-call", syntheticNonce: "synthetic_nonce_0123456789" };
const META = { sessionId: INPUT.sessionId, threadId: "raw-thread", callId: INPUT.callId };
const PROBE_LOCK = new URL("./probe-lock.mts", import.meta.url).href;

function state(t: test.TestContext): { dir: string; lock: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-probe-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "locks"));
  return { dir, lock: probeLockFile(dir, "create") };
}

// The pid of a child that has exited and was awaited: proven absent.
const deadPid = (): number => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"],
  { encoding: "utf8" }).stdout);
const record = (pid: number, token = "0123456789abcdef0123456789abcdef"): string =>
  `${JSON.stringify({ version: 1, pid, token, at: "2026-10-22T00:00:00.000Z" })}\n`;

// Counts exclusive creates ("wx") of files in the locks directory.
function wxOpens(t: test.TestContext): string[] {
  const real = fs.openSync, seen: string[] = [];
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (flags === "wx" && path.basename(path.dirname(String(file))) === "locks") seen.push(path.basename(String(file)));
    return real(file, flags, mode);
  });
  return seen;
}

const blocked = (dir: string): void => assert.throws(() => createIntent(dir, INPUT, T0),
  (error: unknown) => error instanceof Error && error.message === "storage_error"
    && (error.cause as NodeJS.ErrnoException).code === "EEXIST");

function spawnChild(t: test.TestContext, script: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => { child.once("close", (code) => resolve(code)); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, exited, out: () => stdout, err: () => stderr };
}

test("the owner record is complete on disk before the action runs and removed after it", (t) => {
  const { dir, lock } = state(t);
  const bytes = withProbeLock(dir, "create", () => fs.readFileSync(lock, "utf8"));
  assert.ok(bytes.endsWith("\n") && bytes.length <= OWNER_MAX_BYTES);
  const owner = JSON.parse(bytes);
  assert.deepEqual(Object.keys(owner), ["version", "pid", "token", "at"]);
  assert.equal(owner.version, 1);
  assert.equal(owner.pid, process.pid);
  assert.match(owner.token, /^[0-9a-f]{32}$/);
  assert.equal(fs.existsSync(lock), false);
});

test("a legacy empty lock stays held whatever its age", (t) => {
  const { dir, lock } = state(t);
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(lock, old, old);
  const opens = wxOpens(t);
  blocked(dir);
  assert.equal(fs.readFileSync(lock, "utf8"), "");
  assert.equal(opens.length, LOCK_ATTEMPTS);
});

test("an incomplete, malformed or oversized record is never reclaimed, even with a dead pid", (t) => {
  const pid = deadPid();
  const complete = record(pid);
  for (const bytes of [complete.slice(0, -1), `${JSON.stringify({ version: 1, pid, token: "0".repeat(32), at: "x", extra: 1 })}\n`,
    "{\n", `${complete.slice(0, -2)}${" ".repeat(OWNER_MAX_BYTES)}}\n`, `${JSON.stringify({ version: 2, pid, token: "0".repeat(32), at: "x" })}\n`]) {
    const { dir, lock } = state(t);
    fs.writeFileSync(lock, bytes);
    blocked(dir);
    assert.equal(fs.readFileSync(lock, "utf8"), bytes);
  }
});

test("a symlinked lock is never followed or removed", (t) => {
  const { dir, lock } = state(t);
  const target = path.join(dir, "target");
  const bytes = record(deadPid());
  fs.writeFileSync(target, bytes);
  try { fs.symlinkSync(target, lock, "file"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return void t.skip("symlinkSync needs a privilege on this host (EPERM)");
    throw error;
  }
  blocked(dir);
  assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, "utf8"), bytes);
});

test("a live owner stays held however old its lock is", (t) => {
  const { dir, lock } = state(t);
  fs.writeFileSync(lock, record(process.pid));
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(lock, old, old);
  const opens = wxOpens(t);
  blocked(dir);
  assert.equal(opens.length, LOCK_ATTEMPTS, "this process's own pid is not waited out on the clock (#982)");
  assert.equal(fs.readFileSync(lock, "utf8"), record(process.pid));
});

for (const code of ["EPERM", "EINVAL"]) {
  test(`an owner probe failing ${code} is unknown and stays held`, (t) => {
    const { dir, lock } = state(t);
    const pid = deadPid();
    fs.writeFileSync(lock, record(pid));
    const signals: unknown[] = [];
    t.mock.method(process, "kill", (target: number, signal?: string | number) => {
      signals.push(signal);
      throw Object.assign(new Error(`synthetic ${code}`), { code });
    });
    blocked(dir);
    assert.ok(signals.length > 0 && signals.every((signal) => signal === 0), "only signal 0 is sent");
    assert.equal(fs.readFileSync(lock, "utf8"), record(pid));
  });
}

test("a dead owner's complete record is reclaimed once through the gate", (t) => {
  const { dir, lock } = state(t);
  const stale = record(deadPid());
  fs.writeFileSync(lock, stale);
  const real = fs.unlinkSync, removed: string[] = [];
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (String(file) === lock) removed.push(fs.readFileSync(lock, "utf8"));
    return real(file);
  });
  assert.match(createIntent(dir, INPUT, T0).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(removed.filter((bytes) => bytes === stale).length, 1, "the stale record is removed once");
  assert.equal(removed.length, 2, "and the new owner's own record at release");
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

test("the lock of a killed holder is recovered", async (t) => {
  const { dir, lock } = state(t);
  const holder = spawnChild(t, `import fs from "node:fs"; import { withProbeLock } from ${JSON.stringify(PROBE_LOCK)};
    withProbeLock(${JSON.stringify(dir)}, "create", () => { fs.writeSync(1, "held");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); });`);
  await new Promise<void>((resolve, reject) => {
    holder.child.stdout.once("data", () => resolve());
    void holder.exited.then((code) => reject(new Error(`holder exited ${code}: ${holder.err()}`)));
  });
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, holder.child.pid);
  holder.child.kill();
  await holder.exited;
  assert.match(createIntent(dir, INPUT, T0).requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

test("a per-request lock of a dead owner is recovered for the exact verify", (t) => {
  const { dir } = state(t);
  const { requestId } = createIntent(dir, INPUT, T0);
  fs.writeFileSync(probeLockFile(dir, requestId), record(deadPid()));
  const checked = verifyIntent(dir, { requestId, syntheticNonce: INPUT.syntheticNonce }, META, T0 + 1);
  assert.equal(checked.ok, true);
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

test("a record replaced before the gate rereads it is never removed", (t) => {
  const { dir, lock } = state(t);
  fs.writeFileSync(lock, record(deadPid()));
  const replacement = record(process.pid, "fedcba9876543210fedcba9876543210");
  const real = fs.openSync, realUnlink = fs.unlinkSync;
  let replaced = false;
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (!replaced && flags === "wx" && String(file) === `${lock}.reclaim`) {
      replaced = true;
      fs.writeFileSync(lock, replacement);
    }
    return real(file, flags, mode);
  });
  const removed: string[] = [];
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (String(file) === lock) removed.push(fs.readFileSync(lock, "utf8"));
    return realUnlink(file);
  });
  assert.throws(() => createIntent(dir, INPUT, T0), /storage_error/);
  assert.equal(replaced, true);
  assert.deepEqual(removed, []);
  assert.equal(fs.readFileSync(lock, "utf8"), replacement);
});

test("a reclaimer that died holding the gate is recovered one level deeper", (t) => {
  const { dir, lock } = state(t);
  fs.writeFileSync(lock, record(deadPid()));
  fs.writeFileSync(`${lock}.reclaim`, record(deadPid()));
  assert.match(createIntent(dir, INPUT, T0).requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

test(`reclaim stops at ${RECLAIM_DEPTH} gate levels and leaves every file`, (t) => {
  const { dir, lock } = state(t);
  const files = Array.from({ length: RECLAIM_DEPTH + 1 }, (_, level) => `${lock}${".reclaim".repeat(level)}`);
  for (const file of files) fs.writeFileSync(file, record(deadPid()));
  const before = files.map((file) => fs.readFileSync(file, "utf8"));
  assert.throws(() => createIntent(dir, INPUT, T0), /storage_error/);
  assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
});

test("two contenders for one dead lock hold it one after the other", async (t) => {
  const { dir, lock } = state(t);
  fs.writeFileSync(lock, record(deadPid()));
  const log = path.join(dir, "log");
  const startAt = Date.now() + 1_500;
  const script = `import fs from "node:fs"; import { withProbeLock } from ${JSON.stringify(PROBE_LOCK)};
    while (Date.now() < ${startAt});
    withProbeLock(${JSON.stringify(dir)}, "create", () => {
      fs.appendFileSync(${JSON.stringify(log)}, "enter " + process.pid + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      fs.appendFileSync(${JSON.stringify(log)}, "exit " + process.pid + "\\n");
    });`;
  const children = [spawnChild(t, script), spawnChild(t, script)];
  const codes = await Promise.all(children.map((child) => child.exited));
  assert.deepEqual(codes, [0, 0], children.map((child) => child.err()).join("\n"));
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" "));
  assert.equal(lines.length, 4);
  for (let n = 0; n < 4; n += 2) assert.deepEqual([lines[n][0], lines[n + 1][0], lines[n][1]], ["enter", "exit", lines[n + 1][1]]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
  assert.match(createIntent(dir, INPUT, T0).requestId, /^[0-9a-f-]{36}$/);
});
