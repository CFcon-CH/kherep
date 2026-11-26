import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { TaskControlExecuteBody, TaskControlResultBody } from "../protocol-task-control.mts";
import { applyQueryResult, beginOperation, completeOperation, ensureDeliveryRegistrations, pendingControlQueries, pendingControlSubmits,
  pendingRegistrations, pendingResults, queueControlRequest, readControlRequest, readRegistrationAuthority, recordRegistrationReceipt, recoverOperations, receiptResult } from "./task-control-store.mts";
import { listInbox, setDeliveryTask, storeMessage } from "./inbox.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";
import { runVersionOf } from "./task-control-local.mts";
import { readTask, writeTask } from "./task-records.mts";

const OWNER = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "10000000-0000-4000-8000-000000000001";
const OPERATION = "20000000-0000-4000-8000-000000000001";
const execute: TaskControlExecuteBody = {
  name: "task.control.execute", operationId: OPERATION, requestId: REQUEST, taskId: TASK, action: "status",
  ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex",
  origin: { kind: "source-request", sourceRequestId: "30000000-0000-4000-8000-000000000001" }, grantVersion: 1,
};
const result: TaskControlResultBody = {
  name: "task.control.result", operationId: OPERATION, taskId: TASK, state: "succeeded", runtime: "codex",
  taskState: "running", processState: "running", runVersion: "a".repeat(64), observedAt: new Date(T0).toISOString(),
  freshness: "fresh", stopSupported: true, stopConfirmed: false,
};

test("completed operations replay their persisted result until receipt without executing again", (t) => {
  const node = taskNode(t);
  assert.equal(beginOperation(node.paths, execute, T0).kind, "execute");
  completeOperation(node.paths, OPERATION, result, T0 + 1);
  const replay = beginOperation(node.paths, execute, T0 + 2);
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.result, result);
  assert.deepEqual(pendingResults(node.paths), [result]);
  receiptResult(node.paths, OPERATION);
  assert.deepEqual(pendingResults(node.paths), []);
  assert.equal(beginOperation(node.paths, execute, T0 + 3).kind, "replay");
});

test("an interrupted executing operation becomes recovery_required and is never automatically re-executed", (t) => {
  const node = taskNode(t);
  assert.equal(beginOperation(node.paths, execute, T0).kind, "execute");
  recoverOperations(node.paths, T0 + 1);
  const replay = beginOperation(node.paths, execute, T0 + 2);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.result?.state, "unknown");
  assert.equal(replay.result?.errorCode, "recovery_required");
  assert.equal(replay.result?.stopConfirmed, false);
});

test("delivery registration is durable and retries until its receipt", (t) => {
  const node = taskNode(t);
  const messageId = "40000000-0000-4000-8000-000000000001";
  storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
    createdAt: new Date(T0).toISOString() }, T0);
  setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex", sessionId: "target-session" });
  ensureDeliveryRegistrations(node.paths, T0);
  const [registration] = pendingRegistrations(node.paths);
  assert.deepEqual(registration, { name: "task.control.register", registrationId: registration.registrationId,
    taskId: TASK, runtime: "codex", sourceMessageId: messageId, associationVersion: 1 });
  assert.deepEqual(pendingRegistrations(node.paths), [registration], "unreceipted registration replays");
  recordRegistrationReceipt(node.paths, { name: "task.control.registration.receipt", registrationId: registration.registrationId,
    ok: true, taskId: TASK, ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex",
    origin: { kind: "source-message", sourceMessageId: messageId }, associationVersion: 1, grantVersion: 1 }, T0 + 1);
  assert.deepEqual(pendingRegistrations(node.paths), []);
});

test("control request keeps one request id and queries a pending operation", (t) => {
  const node = taskNode(t);
  const submit = { name: "task.control.submit" as const, requestId: REQUEST, action: "status" as const, taskId: TASK };
  queueControlRequest(node.paths, submit, T0);
  assert.deepEqual(pendingControlSubmits(node.paths), [submit]);
  applyQueryResult(node.paths, { name: "task.control.query.result", requestId: REQUEST, operationId: OPERATION,
    state: "pending", taskId: TASK, targetNodeId: TARGET, action: "status", freshness: "unavailable" }, T0 + 1);
  assert.deepEqual(pendingControlSubmits(node.paths), []);
  assert.deepEqual(pendingControlQueries(node.paths), [{ name: "task.control.query", requestId: REQUEST }]);
});


test("recovery persists stop intent only when the interrupted operation still names the exact local run", (t) => {
  const exact = taskNode(t);
  const task = writeTask(exact.paths, {
    taskId: TASK, runtime: "codex", name: "task-run", cwd: exact.workspace, permissionMode: "auto", state: "running",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), pid: 1234, pidStart: "start",
  });
  const expectedRunVersion = runVersionOf(task)!;
  const stop = { ...execute, action: "stop" as const, expectedRunVersion };
  beginOperation(exact.paths, stop, T0);
  recoverOperations(exact.paths, T0 + 1);
  assert.ok(readTask(exact.paths, TASK)?.operatorStoppedAt);
  assert.equal(readTask(exact.paths, TASK)?.taskControlRecoveryRunVersion, expectedRunVersion);

  const stale = taskNode(t);
  writeTask(stale.paths, { ...task, pidStart: "replacement" });
  beginOperation(stale.paths, stop, T0);
  recoverOperations(stale.paths, T0 + 1);
  assert.equal(readTask(stale.paths, TASK)?.operatorStoppedAt, undefined);
});


test("retryable registration denial waits before retrying the same association", (t) => {
  const node = taskNode(t);
  const messageId = "40000000-0000-4000-8000-000000000011";
  storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
    createdAt: new Date(T0).toISOString() }, T0);
  setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0);
  const registration = pendingRegistrations(node.paths, T0)[0];
  recordRegistrationReceipt(node.paths, { name: "task.control.registration.receipt", registrationId: registration.registrationId,
    ok: false, errorCode: "capability_required" }, T0);
  assert.deepEqual(pendingRegistrations(node.paths, T0 + 1), []);
  assert.deepEqual(pendingRegistrations(node.paths, T0 + 30_000), [registration]);
});

test("delivery fallback advances association version and same authority accepts multiple source messages", (t) => {
  const node = taskNode(t);
  const secondTask = "00000000-0000-4000-8000-0000000000dd";
  const first = "40000000-0000-4000-8000-000000000021";
  const second = "40000000-0000-4000-8000-000000000022";
  for (const messageId of [first, second]) {
    storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
      createdAt: new Date(T0).toISOString() }, T0);
    setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
  }
  ensureDeliveryRegistrations(node.paths, T0);
  for (const registration of pendingRegistrations(node.paths, T0)) {
    recordRegistrationReceipt(node.paths, { name: "task.control.registration.receipt",
      registrationId: registration.registrationId, ok: true, taskId: TASK, ownerNodeId: OWNER, targetNodeId: TARGET,
      runtime: "codex", origin: { kind: "source-message", sourceMessageId: registration.sourceMessageId },
      associationVersion: 1, grantVersion: registration.sourceMessageId === first ? 1 : 2 }, T0 + 1);
  }
  assert.deepEqual(Object.keys(readRegistrationAuthority(node.paths, TASK)!.sources).sort(), [first, second]);

  setDeliveryTask(node.paths.inbox, first, { taskId: secondTask, runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0 + 2);
  const fallback = pendingRegistrations(node.paths, T0 + 2)[0];
  assert.equal(fallback.taskId, secondTask);
  assert.equal(fallback.associationVersion, 2);
});


test("query journal preserves terminal identity against stale pending and mismatched replies", (t) => {
  const node = taskNode(t);
  const submit = { name: "task.control.submit" as const, requestId: REQUEST, action: "status" as const, taskId: TASK };
  queueControlRequest(node.paths, submit, T0);
  const pending = { name: "task.control.query.result" as const, requestId: REQUEST, operationId: OPERATION,
    state: "pending" as const, taskId: TASK, targetNodeId: TARGET, action: "status" as const, freshness: "unavailable" as const };
  applyQueryResult(node.paths, pending, T0 + 1);
  const completed = { name: "task.control.query.result" as const, requestId: REQUEST, operationId: OPERATION,
    state: "succeeded" as const, taskId: TASK, targetNodeId: TARGET, action: "status" as const, runtime: "codex" as const,
    taskState: "running" as const, processState: "running" as const, runVersion: "a".repeat(64),
    observedAt: new Date(T0 + 2).toISOString(), freshness: "cached" as const, stopSupported: true, stopConfirmed: false };
  applyQueryResult(node.paths, completed, T0 + 2);
  applyQueryResult(node.paths, pending, T0 + 3);
  assert.deepEqual(readControlRequest(node.paths, REQUEST)?.result, completed);

  applyQueryResult(node.paths, { ...completed, operationId: crypto.randomUUID(), taskId: crypto.randomUUID() }, T0 + 4);
  assert.deepEqual(readControlRequest(node.paths, REQUEST)?.result, completed);

  const revoked = { name: "task.control.query.result" as const, requestId: REQUEST, state: "denied" as const,
    freshness: "unavailable" as const, errorCode: "grant_revoked" as const };
  applyQueryResult(node.paths, revoked, T0 + 5);
  assert.deepEqual(readControlRequest(node.paths, REQUEST)?.result, revoked);
});


test("a delayed successful receipt for the old association preserves its immutable task authority", (t) => {
  const node = taskNode(t);
  const messageId = "40000000-0000-4000-8000-000000000031";
  const secondTask = "00000000-0000-4000-8000-0000000000ee";
  storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
    createdAt: new Date(T0).toISOString() }, T0);
  setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0);
  const first = pendingRegistrations(node.paths, T0)[0];

  setDeliveryTask(node.paths.inbox, messageId, { taskId: secondTask, runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0 + 1);
  recordRegistrationReceipt(node.paths, { name: "task.control.registration.receipt", registrationId: first.registrationId,
    ok: true, taskId: TASK, ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex",
    origin: { kind: "source-message", sourceMessageId: messageId }, associationVersion: 1, grantVersion: 1 }, T0 + 2);

  assert.equal(readRegistrationAuthority(node.paths, TASK)?.sources[messageId]?.grantVersion, 1);
  assert.equal(pendingRegistrations(node.paths, T0 + 2)[0].taskId, secondTask);
});


test("an older delayed receipt cannot revert a newer authority for the same task and source", (t) => {
  const node = taskNode(t);
  const messageId = "40000000-0000-4000-8000-000000000041";
  const secondTask = "00000000-0000-4000-8000-0000000000ef";
  storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
    createdAt: new Date(T0).toISOString() }, T0);
  setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0);
  const first = pendingRegistrations(node.paths, T0)[0];
  setDeliveryTask(node.paths.inbox, messageId, { taskId: secondTask, runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0 + 1);
  setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
  ensureDeliveryRegistrations(node.paths, T0 + 2);
  const third = pendingRegistrations(node.paths, T0 + 2)[0];
  recordRegistrationReceipt(node.paths, { name: "task.control.registration.receipt", registrationId: third.registrationId,
    ok: true, taskId: TASK, ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex",
    origin: { kind: "source-message", sourceMessageId: messageId }, associationVersion: 3, grantVersion: 3 }, T0 + 3);
  recordRegistrationReceipt(node.paths, { name: "task.control.registration.receipt", registrationId: first.registrationId,
    ok: true, taskId: TASK, ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex",
    origin: { kind: "source-message", sourceMessageId: messageId }, associationVersion: 1, grantVersion: 1 }, T0 + 4);
  assert.deepEqual(readRegistrationAuthority(node.paths, TASK)?.sources[messageId],
    { associationVersion: 3, grantVersion: 3 });
});

// Issue #1012: the exchange round passes its inbox snapshot instead of a fresh list and read.
test("1012: registrations from a records snapshot match the ones from the inbox read, a record without delivery registers nothing", (t) => {
  const registered = (records: boolean): { file: string; record: Record<string, unknown> }[] => {
    const node = taskNode(t);
    for (const [n, delivery] of [[1, true], [2, false], [3, true]] as const) {
      const messageId = `40000000-0000-4000-8000-00000000003${n}`;
      storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
        createdAt: new Date(T0).toISOString() }, T0);
      if (delivery) setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
    }
    ensureDeliveryRegistrations(node.paths, T0, records ? listInbox(node.paths.inbox) : undefined);
    const dir = path.join(node.paths.taskControl, "registrations");
    return fs.readdirSync(dir).sort().map((file) => {
      const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      return { file, record: { ...record, body: { ...record.body, registrationId: "ignored" } } };
    });
  };
  const fromRead = registered(false);
  assert.deepEqual(fromRead.map((entry) => entry.file),
    ["40000000-0000-4000-8000-000000000031.json", "40000000-0000-4000-8000-000000000033.json"]);
  assert.deepEqual(registered(true), fromRead);
  const node = taskNode(t);
  ensureDeliveryRegistrations(node.paths, T0, []);
  assert.deepEqual(pendingRegistrations(node.paths, T0), [], "an empty snapshot registers nothing");
});
