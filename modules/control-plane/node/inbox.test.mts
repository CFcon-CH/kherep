import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { MessageDeliverBody } from "../protocol-messages.mts";
import { getMessage, getMessageProgress, getReceipt, INBOX_RETENTION_MS, listInbox, markDelivered, markOffered, markReported, markRetry, setDeliveryTask, setMessageProgress, storeMessage } from "./inbox.mts";
import { drain, purgeInbox, purgeInboxSteps } from "./inbox-purge.mts";

const ID_A = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b2";
const SENDER = "00000000-0000-4000-8000-0000000000cc";
const NOW = Date.UTC(2026, 5, 1);

function deliver(messageId: string, toSession = "s1", text = "hello"): MessageDeliverBody {
  return { messageId, from: { nodeId: SENDER, session: "s-a" }, toSession, text, createdAt: new Date(NOW - 1000).toISOString() };
}

function tempInbox(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-inbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "inbox");
}

test("stores one private file per message, atomically, with the documented record", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, { ...deliver(ID_A), inReplyTo: ID_B }, NOW);
  assert.deepEqual(fs.readdirSync(dir), [`${ID_A}.json`]); // no temp file left behind
  assert.deepEqual(getMessage(dir, ID_A), {
    messageId: ID_A, from: { nodeId: SENDER, session: "s-a" }, toSession: "s1", text: "hello", inReplyTo: ID_B,
    createdAt: new Date(NOW - 1000).toISOString(), receivedAt: new Date(NOW).toISOString(), state: "accepted", depth: 0,
  });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, `${ID_A}.json`)).mode & 0o777, 0o600);
  }
});

test("a redelivered message keeps the stored file", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A, "s1", "first"), NOW);
  const kept = storeMessage(dir, deliver(ID_A, "s1", "second"), NOW + 5000);
  assert.equal(kept.text, "first");
  assert.equal(getMessage(dir, ID_A)?.receivedAt, new Date(NOW).toISOString());
});

test("stores validated Worker admission depth and keeps it unchanged on redelivery", (t) => {
  const dir = tempInbox(t);
  const loop = { version: 1 as const, threadId: ID_A, depth: 20, generation: 1, ordinal: 24 };
  const first = storeMessage(dir, { ...deliver(ID_A), loop }, NOW, 0);
  assert.equal(first.depth, 20);
  assert.deepEqual(first.loop, loop);
  assert.deepEqual(storeMessage(dir, deliver(ID_A), NOW + 1, 0), first);
});

test("rejects malformed present admission before creating or accepting an inbox record", (t) => {
  const dir = tempInbox(t);
  const bad = { ...deliver(ID_A), loop: null } as unknown as MessageDeliverBody;
  assert.throws(() => storeMessage(dir, bad, NOW), /invalid loop admission/);
  assert.equal(getMessage(dir, ID_A), null);
});

test("lists by session, oldest first, and rejects ids that are not message ids", (t) => {
  const dir = tempInbox(t);
  assert.deepEqual(listInbox(dir), []);
  storeMessage(dir, deliver(ID_B, "s2"), NOW + 1);
  storeMessage(dir, deliver(ID_A, "s1"), NOW);
  assert.deepEqual(listInbox(dir).map((r) => r.messageId), [ID_A, ID_B]);
  assert.deepEqual(listInbox(dir, "s2").map((r) => r.messageId), [ID_B]);
  assert.equal(getMessage(dir, "../node"), null);
});

test("markDelivered records the state and returns the status to send", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A), NOW);
  assert.deepEqual(markDelivered(dir, ID_A), { messageId: ID_A, state: "delivered" });
  assert.equal(getMessage(dir, ID_A)?.state, "delivered");
  assert.deepEqual(markDelivered(dir, ID_A), { messageId: ID_A, state: "delivered" });
  assert.equal(markDelivered(dir, ID_B), null);
});

test("a delayed receipt uses a sidecar and never rewrites newer hook progress", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A), NOW);
  markOffered(dir, ID_A, NOW + 1);
  const offered = getMessage(dir, ID_A);
  markReported(dir, ID_A, "accepted", "accepted", NOW + 2);
  assert.deepEqual(getMessage(dir, ID_A), offered, "the daemon receipt does not rewrite the message record");
  assert.deepEqual(getReceipt(dir, ID_A), { reportedAt: new Date(NOW + 2).toISOString(),
    reportedState: "accepted", workerState: "accepted" });

  markDelivered(dir, ID_A);
  markReported(dir, ID_A, "accepted", "accepted", NOW + 3);
  assert.equal(getMessage(dir, ID_A)?.state, "delivered", "a stale accepted receipt cannot revert delivery");
  assert.equal(getReceipt(dir, ID_A)?.reportedAt, new Date(NOW + 2).toISOString());
  markReported(dir, ID_A, "delivered", "replied", NOW + 4);
  assert.deepEqual(getReceipt(dir, ID_A), { reportedAt: new Date(NOW + 4).toISOString(),
    reportedState: "delivered", workerState: "replied" });
});

test("progress metadata stays in a sidecar, deduplicates, and never rewrites hook state", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A), NOW);
  const first = setMessageProgress(dir, ID_A, "waking", "wake-pending", NOW);
  assert.equal(first?.observedAt, new Date(NOW).toISOString());
  assert.deepEqual(setMessageProgress(dir, ID_A, "waking", "wake-pending", NOW - 1000), first,
    "unchanged progress does not mint a new observation");
  const second = setMessageProgress(dir, ID_A, "waiting", "wake-unconfirmed", NOW);
  assert.equal(Date.parse(second!.observedAt), NOW + 1, "same-tick transitions are strictly monotonic");
  const third = setMessageProgress(dir, ID_A, "waiting", "target-busy", NOW - 1000);
  assert.equal(Date.parse(third!.observedAt), NOW + 2, "a backward local clock stays monotonic");
  const retry = setMessageProgress(dir, ID_A, "waiting", "retry-pending", NOW - 1000, NOW - 1000);
  assert.equal(retry?.retryAt, retry?.observedAt, "retry time never precedes a monotonic observation");
  assert.equal("progress" in getMessage(dir, ID_A)!, false, "the private body record contains no progress metadata");

  const staleSnapshot = getMessage(dir, ID_A);
  markDelivered(dir, ID_A);
  assert.equal(setMessageProgress(dir, ID_A, "failed", "wake-failed", NOW + 3), null);
  assert.equal(staleSnapshot?.state, "accepted");
  assert.equal(getMessage(dir, ID_A)?.state, "delivered", "a stale progress producer cannot restore accepted");
  assert.deepEqual(getMessageProgress(dir, ID_A), retry, "terminal state precedence does not require rewriting the sidecar");
});
test("purges records older than seven days and stale temp files", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A), NOW - INBOX_RETENTION_MS - 1);
  storeMessage(dir, deliver(ID_B), NOW - INBOX_RETENTION_MS + 60_000);
  // A confirmed final record goes; a waiting one is refused first (exchange-recovery.test.mts).
  markDelivered(dir, ID_A);
  markReported(dir, ID_A, "delivered", "delivered", NOW - INBOX_RETENTION_MS - 1);
  const temp = path.join(dir, `.${ID_B}.json.x.tmp`);
  fs.writeFileSync(temp, "{");
  const old = new Date(NOW - INBOX_RETENTION_MS - 60_000);
  fs.utimesSync(temp, old, old);
  assert.equal(purgeInbox(dir, NOW), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${ID_B}.json`, "receipts"]);
  assert.equal(getReceipt(dir, ID_A), null);
  assert.equal(purgeInbox(path.join(dir, "missing"), NOW), 0);
});

// Issue #581: a second purge (an orphaned daemon, issue #582) may remove an entry after this purge listed it.
test("a purge skips an entry removed after its listing and finishes the rest", (t) => {
  const dir = tempInbox(t);
  for (const id of [ID_A, ID_B]) {
    storeMessage(dir, deliver(id), NOW - INBOX_RETENTION_MS - 1);
    markDelivered(dir, id);
    markReported(dir, id, "delivered", "delivered", NOW - INBOX_RETENTION_MS - 1);
  }
  const steps = purgeInboxSteps(dir, NOW);
  steps.next();
  fs.rmSync(path.join(dir, `${ID_A}.json`));
  assert.equal(drain(steps), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["receipts"]);
});

test("delivery task identity is separate from the grant and survives offers, retries, receipts and confirmation", (t) => {
  const dir = tempInbox(t);
  const grantTaskId = "00000000-0000-4000-8000-000000000009";
  const deliveryTaskId = "00000000-0000-4000-8000-000000000010";
  storeMessage(dir, { ...deliver(ID_A), taskId: grantTaskId }, NOW);
  assert.equal(setDeliveryTask(dir, ID_A, { taskId: deliveryTaskId, runtime: "codex" }), true);
  assert.deepEqual(getMessage(dir, ID_A)?.delivery, { taskId: deliveryTaskId, runtime: "codex" });
  assert.equal(getMessage(dir, ID_A)?.taskId, grantTaskId);

  markOffered(dir, ID_A, NOW + 1);
  markRetry(dir, ID_A);
  markReported(dir, ID_A, "accepted", "accepted", NOW + 2);
  assert.deepEqual(getMessage(dir, ID_A)?.delivery, { taskId: deliveryTaskId, runtime: "codex" });
  setDeliveryTask(dir, ID_A, { taskId: deliveryTaskId, runtime: "codex", sessionId: "019a0000-0000-7000-8000-000000000001" });
  markDelivered(dir, ID_A);
  assert.deepEqual(getMessage(dir, ID_A)?.delivery,
    { taskId: deliveryTaskId, runtime: "codex", sessionId: "019a0000-0000-7000-8000-000000000001" });
  assert.equal(getMessage(dir, ID_A)?.taskId, grantTaskId);
});

test("delivery task identity validates ids and runtime before writing", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A), NOW);
  assert.throws(() => setDeliveryTask(dir, ID_A, { taskId: "../task", runtime: "codex" }), /invalid delivery task identity/);
  assert.throws(() => setDeliveryTask(dir, ID_A, { taskId: ID_B, runtime: "gemini" as "codex" }), /invalid delivery task identity/);
  assert.equal(setDeliveryTask(dir, ID_B, { taskId: ID_A, runtime: "claude" }), false);
  assert.equal(getMessage(dir, ID_A)?.delivery, undefined);
});

test("offeredBy names the path of the last offer and survives confirmation; legacy records keep their shape", (t) => {
  const dir = tempInbox(t);
  storeMessage(dir, deliver(ID_A), NOW);
  assert.equal(markOffered(dir, ID_A, NOW + 1, "prompt")?.offeredBy, "prompt");
  markOffered(dir, ID_A, NOW + 2, "wake");
  assert.deepEqual([getMessage(dir, ID_A)?.offeredBy, getMessage(dir, ID_A)?.offers, getMessage(dir, ID_A)?.offeredAt],
    ["wake", 2, new Date(NOW + 2).toISOString()]);
  markDelivered(dir, ID_A);
  assert.deepEqual([getMessage(dir, ID_A)?.state, getMessage(dir, ID_A)?.offeredBy], ["delivered", "wake"]);

  storeMessage(dir, deliver(ID_B), NOW);
  markOffered(dir, ID_B, NOW + 1);
  assert.equal(Object.hasOwn(getMessage(dir, ID_B)!, "offeredBy"), false, "a call without the label writes no key");
  // A record written before issue #417 has no offeredBy and still reads.
  const legacy = "00000000-0000-4000-8000-0000000000c3";
  fs.writeFileSync(path.join(dir, `${legacy}.json`), JSON.stringify({ ...deliver(legacy), receivedAt: new Date(NOW).toISOString(),
    state: "offered", offers: 1, offeredAt: new Date(NOW).toISOString() }));
  assert.deepEqual([getMessage(dir, legacy)?.state, getMessage(dir, legacy)?.offeredBy], ["offered", undefined]);
  assert.ok(listInbox(dir).some((r) => r.messageId === legacy));
});
