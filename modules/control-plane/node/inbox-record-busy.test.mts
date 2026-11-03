import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { MessageDeliverBody } from "../protocol-messages.mts";
import {
  getMessage, INBOX_RETENTION_MS, markAnswered, markClosedAttempt, markDelivered, markOffered, markRefused, markReported, markRetry,
  setDeliveryTask, storeMessage,
} from "./inbox.mts";
import { readdress } from "./_deprecated/session-handover.mts";
import { purgeInbox } from "./inbox-purge.mts";
import { RecordLockBusy, withRecordLockBudget } from "./inbox-record-lock.mts";

// Issue #627: what each writer reports when the record's lock stays held for
// the whole wait, and that the legacy readdress judges a record again under its lock (D6).
const ID = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b2";
const NOW = Date.UTC(2026, 9, 21);
const TASK = "00000000-0000-4000-8000-0000000000d4";
const lockOf = (dir: string, id: string): string => path.join(dir, `.${id}.json.lock`);

function deliver(messageId: string, toSession = "s1"): MessageDeliverBody {
  return { messageId, from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "s-a" }, toSession, text: "hello", createdAt: new Date(NOW).toISOString() };
}

// Records, for each rename onto a record file, whether that record's lock existed.
function watched(t: TestContext): { dir: string; renames: boolean[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-record-busy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "inbox");
  const renames: boolean[] = [];
  const real = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    const target = String(to);
    if (target.endsWith(".json") && path.dirname(target) === dir) renames.push(fs.existsSync(lockOf(dir, path.basename(target, ".json"))));
    return real(from, to);
  });
  return { dir, renames };
}

// The lock stays held for the whole wait (a foreign fresh lock, and a spent
// budget so no test waits). What a writer then reports is its contract with
// its callers: a "not written" result where the next event, round or read
// repeats the write (a repeated offer at worst), a thrown RecordLockBusy where
// only the caller's round can repeat it as a whole.
const busy = (error: unknown): boolean => error instanceof RecordLockBusy && (error as RecordLockBusy).messageId === ID;
const held = (dir: string): void => { fs.writeFileSync(lockOf(dir, ID), `${JSON.stringify({ pid: 1, at: new Date().toISOString() })}\n`); };
function spent<T>(body: () => T): T { return withRecordLockBudget(0, body); }

test("a busy record is not written by markOffered, markDelivered, markRetry, markAnswered and markRefused, and they say so", (t) => {
  const { dir, renames } = watched(t);
  storeMessage(dir, deliver(ID), NOW);
  markOffered(dir, ID, NOW);
  held(dir);
  spent(() => {
    assert.equal(markOffered(dir, ID, NOW + 1, "wake"), null);
    assert.equal(markDelivered(dir, ID), null);
    assert.equal(markRetry(dir, ID), false);
    assert.equal(markRefused(dir, ID, "late"), false);
    markAnswered(dir, ID);
  });
  const record = getMessage(dir, ID);
  assert.deepEqual([record?.state, record?.offers, record?.retry], ["offered", 1, undefined], "the record is as the holder left it");
  assert.deepEqual(renames, [true, true], "creation and update hold the common UUID lock; nothing while the record was held");
  assert.ok(fs.existsSync(lockOf(dir, ID)), "the holder's lock is untouched");
});

test("a busy record is an error for setDeliveryTask, markClosedAttempt and the legacy readdress, whose rounds run again", (t) => {
  const { dir } = watched(t);
  storeMessage(dir, deliver(ID), NOW);
  held(dir);
  spent(() => {
    assert.throws(() => setDeliveryTask(dir, ID, { taskId: TASK, runtime: "claude" }), busy);
    assert.throws(() => markClosedAttempt(dir, ID, NOW, "s-intercom"), busy);
    assert.throws(() => readdress(dir, "s1", "s2"), busy);
  });
  const record = getMessage(dir, ID);
  assert.deepEqual([record?.toSession, record?.delivery, record?.closedAttempt], ["s1", undefined, undefined]);
});

// The purge is a daemon round: a busy record is neither refused nor removed and
// waits for the next pass, whatever its state.
test("a record whose lock stays busy is neither refused nor removed by the purge", (t) => {
  const { dir } = watched(t);
  storeMessage(dir, deliver(ID), NOW);
  const later = NOW + INBOX_RETENTION_MS + 60_000;
  held(dir);
  assert.equal(withRecordLockBudget(0, () => purgeInbox(dir, later)), 0);
  assert.equal(getMessage(dir, ID)?.state, "accepted");
  fs.unlinkSync(lockOf(dir, ID));
  markDelivered(dir, ID);
  markReported(dir, ID, "delivered", "delivered", NOW + 1);
  held(dir);
  assert.equal(withRecordLockBudget(0, () => purgeInbox(dir, later)), 0);
  assert.equal(getMessage(dir, ID)?.state, "delivered");
  assert.ok(fs.existsSync(lockOf(dir, ID)), "the holder's lock is untouched");
});

// Design decision D6: the listing is a snapshot; the record is judged again
// under its lock. Here another writer delivers the record between the listing
// and the lock (the lock's creation is the seam), so it is neither moved nor
// returned; a record the listing missed is not moved either.
test("readdress judges each record again under its lock: one delivered since the listing stays and is not returned", (t) => {
  const { dir } = watched(t);
  storeMessage(dir, deliver(ID), NOW);
  storeMessage(dir, deliver(ID_B), NOW + 1);
  const real = fs.openSync;
  let delivered = false;
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (file === lockOf(dir, ID) && !delivered) { delivered = true; markDelivered(dir, ID); }
    return real(file, flags, mode);
  });
  assert.deepEqual(readdress(dir, "s1", "s2"), [ID_B]);
  assert.deepEqual([getMessage(dir, ID)?.state, getMessage(dir, ID)?.toSession, getMessage(dir, ID)?.closedTo], ["delivered", "s1", undefined]);
  assert.deepEqual([getMessage(dir, ID_B)?.toSession, getMessage(dir, ID_B)?.closedTo], ["s2", "s1"]);
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`, `${ID_B}.json`]);
});

// markOffered is judged under the lock too: a record settled since the caller
// listed it is not offered again, and the caller does not show it.
test("markOffered leaves a record settled since the listing as it is and returns null", (t) => {
  const { dir } = watched(t);
  storeMessage(dir, deliver(ID), NOW);
  markDelivered(dir, ID);
  assert.equal(markOffered(dir, ID, NOW + 1, "wake"), null);
  storeMessage(dir, deliver(ID_B), NOW);
  markRefused(dir, ID_B, "gone");
  assert.equal(markOffered(dir, ID_B, NOW + 1), null);
  assert.deepEqual([getMessage(dir, ID)?.state, getMessage(dir, ID)?.offers], ["delivered", undefined]);
  assert.deepEqual([getMessage(dir, ID_B)?.state, getMessage(dir, ID_B)?.offers], ["refused", undefined]);
});
