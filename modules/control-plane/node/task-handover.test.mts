import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { InboxRecord } from "./inbox.mts";
import { handoverTaskMessages } from "./task-handover.mts";
import { handoverInbox, id, scope, FOREIGN, FROM, TO, MID } from "./task-handover-fixture.mts";

test("source preserves legacy movement; only exact-owned intermediate and target identities converge", (t) => {
  const f = handoverInbox(t);
  const foreign = { taskId: FOREIGN, runtime: "claude" as const, sessionId: FROM };
  const wrong = { ...scope, runtime: "codex" as const, sessionId: FROM };
  const malformed = { taskId: scope.taskId } as InboxRecord["delivery"];
  const originals = [
    f.store(20), f.store(21, { state: "offered", offers: 1, offeredAt: new Date(2).toISOString(), offeredBy: "prompt", retry: true, toSession: MID }),
    f.store(22, { delivery: foreign }), f.store(23, { delivery: wrong }), f.store(24, { delivery: undefined }),
    f.store(25, { delivery: malformed }), f.store(26, { toSession: MID, delivery: foreign }),
    f.store(27, { toSession: MID, delivery: wrong }), f.store(28, { toSession: MID, delivery: undefined }),
    f.store(29, { toSession: MID, delivery: malformed }), f.store(30, { toSession: TO, closedTo: "older" }),
    f.store(31, { toSession: TO, state: "delivered" }), f.store(32, { toSession: TO, state: "refused", reason: "kept" }),
    f.store(33, { toSession: MID, state: "delivered" }), f.store(34, { state: "refused", reason: "kept" }),
    f.store(35, { toSession: TO, delivery: foreign }), f.store(36, { closedTo: undefined }),
  ];
  const beforeBytes = originals.map((r) => f.bytes(r.messageId)), writes = f.observeWrites();
  handoverTaskMessages(f.dir, FROM, TO, scope);
  const moves = new Set([20, 21, 22, 23, 24, 25, 36]), corrections = new Set([20, 21, 30, 31, 32, 36]);
  for (const [i, before] of originals.entries()) {
    const n = 20 + i, expected = { ...before,
      ...(moves.has(n) ? { toSession: TO, closedTo: before.closedTo ?? before.toSession } : {}),
      ...(corrections.has(n) ? { delivery: { ...before.delivery!, sessionId: TO } } : {}) };
    assert.deepEqual(f.get(before.messageId), JSON.parse(JSON.stringify(expected)));
    if (!moves.has(n) && !corrections.has(n)) assert.equal(f.bytes(before.messageId), beforeBytes[i]);
  }
  assert.deepEqual(writes.filter((w) => w.before.toSession !== w.after.toSession).map((w) => w.id), [...moves].map(id));
  const settled = originals.map((r) => f.bytes(r.messageId)); writes.length = 0;
  handoverTaskMessages(f.dir, FROM, TO, scope);
  assert.deepEqual(originals.map((r) => f.bytes(r.messageId)), settled); assert.deepEqual(writes, []);
});

test("invalid arguments fail before writes and an identical source/target triggers no sweep", (t) => {
  const f = handoverInbox(t); f.store(20, { toSession: MID }); const before = f.bytes(id(20));
  const writes = f.observeWrites();
  for (const invalid of [null, undefined, {}, { taskId: scope.taskId }, { runtime: "claude" }, { ...scope, taskId: "../bad" }, { ...scope, runtime: "other" }]) {
    assert.throws(() => handoverTaskMessages(f.dir, FROM, TO, invalid as typeof scope));
  }
  for (const invalid of ["", "a\nb", null, undefined]) {
    assert.throws(() => handoverTaskMessages(f.dir, invalid as string, TO, scope));
    assert.throws(() => handoverTaskMessages(f.dir, FROM, invalid as string, scope));
  }
  handoverTaskMessages(f.dir, FROM, FROM, scope);
  assert.equal(f.bytes(id(20)), before); assert.deepEqual(writes, []);
});

test("a malformed stored message ID cannot construct an out-of-inbox path or lock", (t) => {
  const f = handoverInbox(t); const record = f.store(20);
  fs.writeFileSync(f.file(id(20)), JSON.stringify({ ...record, messageId: "../outside" }));
  const before = f.bytes(id(20)), writes = f.observeWrites();
  assert.throws(() => handoverTaskMessages(f.dir, FROM, TO, scope), /mismatch/);
  assert.equal(f.bytes(id(20)), before); assert.deepEqual(writes, []);
  assert.deepEqual(fs.readdirSync(f.dir), [`${id(20)}.json`]);
});
