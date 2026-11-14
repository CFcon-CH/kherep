import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { getMessage, markDelivered, markRefused, storeMessage } from "./inbox.mts";
import { RECORD_LOCK_WAIT_MS, recordLockFile, setRecordLockWait } from "./inbox-record-lock.mts";

// Issue #627: a writer in another process holds a record while this process
// refuses or delivers it. Deterministic: the fixture takes the lock before it
// prints "locked" and keeps it until the go file appears, which this process
// writes right before its own writer starts (#914). The fixture then holds the
// lock HOLD_MS longer, writes the record's state while still holding it and
// only then releases. On the previous code the write here lands at once,
// between the fixture's read and write, and the first assertion of each test
// fails. The writer here waits up to WRITER_WAIT_MS, far above HOLD_MS, so a
// slow machine does not turn the wait into a busy refusal. Limit: a holder
// stalled above RECORD_LOCK_STALE_MS between two lock stamps is stale by
// definition; its lock is broken and the first assertion fails with the detail.
const ID = "00000000-0000-4000-8000-0000000000a1";
const HOLD_MS = 400;
const LOCKED_WAIT_MS = 60_000;
const WRITER_WAIT_MS = 30_000;
const FIXTURE = path.join(import.meta.dirname, "inbox-lock-hold-fixture.mts");

async function heldRecord(t: TestContext, thenState: "delivered" | "refused") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-refuse-race-"));
  const dir = path.join(root, "inbox");
  const go = path.join(root, "go");
  storeMessage(dir, { messageId: ID, from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "s-a" }, toSession: "s1",
    text: "hello", createdAt: new Date().toISOString() });
  const child: ChildProcess = spawn(process.execPath, [FIXTURE, dir, ID, String(HOLD_MS), thenState, go], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => { child.once("exit", (code) => resolve(code)); });
  setRecordLockWait(WRITER_WAIT_MS);
  t.after(async () => {
    setRecordLockWait(RECORD_LOCK_WAIT_MS);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the holder did not lock within ${LOCKED_WAIT_MS} ms (stdout ${JSON.stringify(out)})`)), LOCKED_WAIT_MS);
    const done = (settle: () => void) => { clearTimeout(timer); settle(); };
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); if (out.includes("locked\n")) done(resolve); });
    child.once("exit", (code) => done(() => reject(new Error(`the holder exited (${code}) before it locked`))));
  });
  assert.ok(fs.existsSync(recordLockFile(dir, ID)), "the fixture holds the record lock");
  // Runs one writer of this process against the held record: the go file starts the holder's hold.
  const contend = <T,>(write: () => T): { result: T; detail: string } => {
    const started = Date.now();
    fs.writeFileSync(go, "");
    const result = write();
    return { result, detail: JSON.stringify({ waitedMs: Date.now() - started, waitLimitMs: WRITER_WAIT_MS, holdMs: HOLD_MS,
      lockHeld: fs.existsSync(recordLockFile(dir, ID)), state: getMessage(dir, ID)?.state, holderExit: child.exitCode }) };
  };
  return { dir, exited, contend };
}

test("a refusal waits for the writer that holds the record and judges the state it left", async (t) => {
  const { dir, exited, contend } = await heldRecord(t, "delivered");
  const { result: refused, detail } = contend(() => markRefused(dir, ID, "target session not running"));
  assert.equal(refused, false, `the record was delivered while it was held: not refused ${detail}`);
  assert.equal(getMessage(dir, ID)?.state, "delivered", detail);
  assert.equal(await exited, 0, detail);
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`], `the lock is gone ${detail}`);
});

test("a delivery confirmed while a refusal holds the record is not lost", async (t) => {
  const { dir, exited, contend } = await heldRecord(t, "refused");
  const { result, detail } = contend(() => markDelivered(dir, ID));
  assert.deepEqual(result, { messageId: ID, state: "delivered" }, detail);
  assert.equal(await exited, 0, detail);
  assert.equal(getMessage(dir, ID)?.state, "delivered", `the hook's delivery was written after the refusal, not under it ${detail}`);
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`], detail);
});
