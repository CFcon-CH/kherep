import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { MessageDeliverBody } from "../protocol-messages.mts";
import {
  getMessage, markAnswered, markClosedAttempt, markDelivered, markOffered, markRefused, markRetry, setDeliveryTask, storeMessage,
} from "./inbox.mts";
import { readdress } from "./_deprecated/session-handover.mts";

// Issue #627: every rewrite of a record body holds the record's lock while it
// renames the new content into place, and leaves no lock behind. The lock path
// is spelled out here, so the test reads the same on a checkout without the
// lock module, where every case fails at "held at rename".
const ID = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b2";
const NOW = Date.UTC(2026, 9, 21);
const TASK = "00000000-0000-4000-8000-0000000000d4";
const lockOf = (dir: string, id: string): string => path.join(dir, `.${id}.json.lock`);

function deliver(messageId: string, toSession = "s1"): MessageDeliverBody {
  return { messageId, from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "s-a" }, toSession, text: "hello", createdAt: new Date(NOW).toISOString() };
}

interface Renames { ofRecord: boolean[] }

// Records, for each rename onto a record file, whether that record's lock existed.
function watched(t: TestContext): { dir: string; renames: Renames } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-record-writers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "inbox");
  const renames: Renames = { ofRecord: [] };
  const real = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    const target = String(to);
    if (target.endsWith(".json") && path.dirname(target) === dir) renames.ofRecord.push(fs.existsSync(lockOf(dir, path.basename(target, ".json"))));
    return real(from, to);
  });
  return { dir, renames };
}

const cases: Record<string, (dir: string) => void> = {
  setDeliveryTask: (dir) => { assert.ok(setDeliveryTask(dir, ID, { taskId: TASK, runtime: "claude" })); },
  markOffered: (dir) => { assert.equal(markOffered(dir, ID, NOW, "wake")?.state, "offered"); },
  markRetry: (dir) => { markOffered(dir, ID, NOW); assert.ok(markRetry(dir, ID)); },
  markDelivered: (dir) => { assert.deepEqual(markDelivered(dir, ID), { messageId: ID, state: "delivered" }); },
  markAnswered: (dir) => { markAnswered(dir, ID); assert.equal(getMessage(dir, ID)?.state, "delivered"); },
  markClosedAttempt: (dir) => { markClosedAttempt(dir, ID, NOW, "s-intercom"); assert.equal(getMessage(dir, ID)?.toSession, "s-intercom"); },
  readdress: (dir) => { assert.deepEqual(readdress(dir, "s1", "s2"), [ID]); assert.equal(getMessage(dir, ID)?.toSession, "s2"); },
  markRefused: (dir) => { assert.ok(markRefused(dir, ID, "target session not running")); },
};

for (const [name, run] of Object.entries(cases)) {
  test(`${name} holds the record lock while it renames and leaves none behind`, (t) => {
    const { dir, renames } = watched(t);
    storeMessage(dir, deliver(ID), NOW);
    renames.ofRecord.length = 0;
    run(dir);
    assert.ok(renames.ofRecord.length >= 1, "the case rewrote the record");
    assert.ok(renames.ofRecord.every(Boolean), `held at rename: ${JSON.stringify(renames.ofRecord)}`);
    assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]);
  });
}

test("storeMessage creates the record under the common root UUID lock", (t) => {
  const { dir, renames } = watched(t);
  storeMessage(dir, deliver(ID), NOW);
  assert.deepEqual(renames.ofRecord, [true]);
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]);
});

test("a rewrite that changes nothing writes nothing and leaves no lock", (t) => {
  const { dir, renames } = watched(t);
  storeMessage(dir, deliver(ID), NOW);
  markDelivered(dir, ID);
  renames.ofRecord.length = 0;
  assert.deepEqual(markDelivered(dir, ID), { messageId: ID, state: "delivered" });
  assert.equal(markRetry(dir, ID), false);
  assert.equal(markRefused(dir, ID, "late"), false);
  markAnswered(dir, ID);
  assert.deepEqual(renames.ofRecord, []);
  assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]);
});

test("readdress moves only the records that still wait for the old session and returns their ids", (t) => {
  const { dir } = watched(t);
  storeMessage(dir, deliver(ID), NOW);
  storeMessage(dir, deliver(ID_B), NOW + 1);
  markDelivered(dir, ID_B);
  assert.deepEqual(readdress(dir, "s1", "s2"), [ID]);
  assert.equal(getMessage(dir, ID)?.closedTo, "s1");
  assert.equal(getMessage(dir, ID_B)?.toSession, "s1");
  assert.deepEqual(readdress(dir, "s1", "s3"), []);
});

test("a rewrite of a message that is not in the inbox takes no lock and reports it missing", (t) => {
  const { dir, renames } = watched(t);
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(markDelivered(dir, ID), null);
  assert.equal(markOffered(dir, ID), null);
  assert.equal(markRefused(dir, ID, "late"), false);
  assert.equal(setDeliveryTask(dir, ID, { taskId: TASK, runtime: "claude" }), false);
  assert.equal(markDelivered(dir, "not-an-id"), null);
  assert.deepEqual(renames.ofRecord, []);
  assert.deepEqual(fs.readdirSync(dir), []);
});
