// Synthetic two-process storage fixture, never part of an installed Hook.
// Holds the record lock of <dir>/<messageId> the way a writer does (issue
// #627) and prints "locked". It then waits for <goFile> to appear, the test's
// signal that its own writer starts now (#914), holds the lock holdMs longer,
// writes the record's state while still holding the lock, releases it and
// exits. Every wait step rewrites the lock with a fresh `at`, so a live holder
// is never broken as stale. Without a go signal within GO_WAIT_MS it releases
// the lock and fails. The lock is created by hand, not through
// inbox-record-lock.mts, so the same fixture runs against a checkout without
// that module.
import fs from "node:fs";
import path from "node:path";

import { getMessage, writeJsonAtomic, type InboxRecord } from "./inbox.mts";

const [dir, messageId, holdMs, state, goFile] = process.argv.slice(2);
const GO_WAIT_MS = 30_000;
const lock = path.join(dir, `.${messageId}.json.lock`);
const wait = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const stamp = (): void => fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
fs.closeSync(fs.openSync(lock, "wx", 0o600));
stamp();
process.stdout.write("locked\n");
const deadline = Date.now() + GO_WAIT_MS;
while (!fs.existsSync(goFile)) {
  if (Date.now() >= deadline) { fs.unlinkSync(lock); throw new Error(`no go signal within ${GO_WAIT_MS} ms`); }
  stamp();
  wait(20);
}
stamp();
wait(Number(holdMs));
stamp();
const record = getMessage(dir, messageId);
if (!record) throw new Error("the record vanished while the fixture held its lock");
writeJsonAtomic(path.join(dir, `${messageId}.json`), { ...record, state: state as InboxRecord["state"] });
fs.unlinkSync(lock);
