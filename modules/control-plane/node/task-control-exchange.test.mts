import assert from "node:assert/strict";
import test from "node:test";

import type { TaskControlEventBody, TaskControlExecuteBody, TaskControlResultBody } from "../protocol-task-control.mts";
import { listInbox, setDeliveryTask, storeMessage } from "./inbox.mts";
import { handleTaskControlExecute, pollTaskControl } from "./task-control-exchange.mts";
import { applyQueryResult, beginOperation, completeOperation, pendingResults, queueControlRequest, receiptResult } from "./task-control-store.mts";
import { runVersionOf } from "./task-control-run.mts";
import { readTask, writeTask } from "./task-records.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";

const OWNER = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "10000000-0000-4000-8000-000000000001";
const OPERATION = "20000000-0000-4000-8000-000000000001";
const execute: TaskControlExecuteBody = { name: "task.control.execute", operationId: OPERATION, requestId: REQUEST, taskId: TASK,
  action: "status", ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "codex",
  origin: { kind: "source-request", sourceRequestId: "30000000-0000-4000-8000-000000000001" }, grantVersion: 1 };
const result: TaskControlResultBody = { name: "task.control.result", operationId: OPERATION, taskId: TASK, state: "succeeded",
  runtime: "codex", taskState: "running", processState: "running", runVersion: "a".repeat(64), observedAt: new Date(T0).toISOString(),
  freshness: "fresh", stopSupported: true, stopConfirmed: false };

test("the journal is executing before the effect and a completed replay never runs it twice", async (t) => {
  const node = taskNode(t);
  let effects = 0;
  const run = async () => { effects += 1; return result; };
  await handleTaskControlExecute(node.paths, execute, run, T0);
  await handleTaskControlExecute(node.paths, execute, run, T0 + 1);
  assert.equal(effects, 1);
});

test("an executor rejection becomes one replayable recovery result without a second effect", async (t) => {
  const node = taskNode(t);
  const task = writeTask(node.paths, {
    taskId: TASK, runtime: "codex", name: "task-run", cwd: node.workspace, permissionMode: "auto", state: "running",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), pid: 1234, pidStart: "start",
  });
  const stop = { ...execute, action: "stop" as const, expectedRunVersion: runVersionOf(task)! };
  let effects = 0;
  const run = async (): Promise<TaskControlResultBody> => {
    effects += 1;
    throw new Error("PRIVATE_EXECUTOR_FAILURE");
  };

  await handleTaskControlExecute(node.paths, stop, run, T0);
  await handleTaskControlExecute(node.paths, stop, run, T0 + 1);
  assert.equal(effects, 1);
  assert.ok(readTask(node.paths, TASK)?.operatorStoppedAt);
  const [recovery] = pendingResults(node.paths);
  assert.deepEqual(recovery, {
    name: "task.control.result", operationId: OPERATION, taskId: TASK, state: "unknown", runtime: "codex",
    taskState: "unknown", processState: "unknown", observedAt: new Date(T0).toISOString(), freshness: "fresh",
    stopSupported: false, stopConfirmed: false, errorCode: "recovery_required",
  });
  assert.equal(JSON.stringify(recovery).includes("PRIVATE_EXECUTOR_FAILURE"), false);

  const sent: TaskControlEventBody[] = [];
  const sender = { sendTaskControl: (body: TaskControlEventBody) => { sent.push(body); return ["frame"]; } };
  pollTaskControl(sender, node.paths, new Set(), () => true, T0 + 2);
  pollTaskControl(sender, node.paths, new Set(), () => true, T0 + 3);
  assert.deepEqual(sent.filter((body) => body.name === "task.control.result"), [recovery, recovery]);
  receiptResult(node.paths, OPERATION, T0 + 4);
  assert.deepEqual(pendingResults(node.paths), []);
});

test("the exchange retries registrations, submits and results, then queries pending requests", (t) => {
  const node = taskNode(t);
  const messageId = "40000000-0000-4000-8000-000000000001";
  storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
    createdAt: new Date(T0).toISOString() }, T0);
  setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
  const submit = { name: "task.control.submit" as const, requestId: REQUEST, action: "status" as const, taskId: TASK };
  queueControlRequest(node.paths, submit, T0);
  beginOperation(node.paths, execute, T0);
  completeOperation(node.paths, OPERATION, result, T0);
  const sent: TaskControlEventBody[] = [];
  const sender = { sendTaskControl: (body: TaskControlEventBody) => { sent.push(body); return ["frame"]; } };
  pollTaskControl(sender, node.paths, new Set(), () => true, T0);
  assert.deepEqual(sent.map((body) => body.name).sort(), ["task.control.register", "task.control.result", "task.control.submit"]);
  applyQueryResult(node.paths, { name: "task.control.query.result", requestId: REQUEST, operationId: OPERATION,
    state: "pending", taskId: TASK, targetNodeId: TARGET, action: "status", freshness: "unavailable" }, T0 + 1);
  sent.length = 0;
  pollTaskControl(sender, node.paths, new Set(), () => true, T0 + 1);
  assert.ok(sent.some((body) => body.name === "task.control.query"));
});


// Issue #1012: the round's records produce the same register frame as the call that reads the inbox itself.
test("1012: pollTaskControl with the round's records sends the same register frame as without", (t) => {
  const sentBy = (records: boolean): TaskControlEventBody[] => {
    const node = taskNode(t);
    const messageId = "40000000-0000-4000-8000-000000000041";
    storeMessage(node.paths.inbox, { messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
      createdAt: new Date(T0).toISOString() }, T0);
    setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
    const sent: TaskControlEventBody[] = [];
    pollTaskControl({ sendTaskControl: (body) => { sent.push(body); return ["frame"]; } }, node.paths, new Set(), () => true, T0, true,
      records ? listInbox(node.paths.inbox) : undefined);
    return sent.map((body) => ({ ...body, registrationId: "ignored" }) as TaskControlEventBody);
  };
  const withoutRecords = sentBy(false);
  assert.deepEqual(withoutRecords.map((body) => body.name), ["task.control.register"]);
  assert.deepEqual(sentBy(true), withoutRecords);
});

test("current policy gate prevents task-control traffic until enabled", (t) => {
  const node = taskNode(t);
  queueControlRequest(node.paths, { name: "task.control.submit", requestId: REQUEST, action: "status", taskId: TASK }, T0);
  const sent: TaskControlEventBody[] = [];
  const sender = { sendTaskControl: (body: TaskControlEventBody) => { sent.push(body); return ["frame"]; } };
  pollTaskControl(sender, node.paths, new Set(), () => true, T0, false);
  assert.deepEqual(sent, []);
  pollTaskControl(sender, node.paths, new Set(), () => true, T0, true);
  assert.deepEqual((sent as TaskControlEventBody[]).map((body) => body.name), ["task.control.submit"]);
});

test("bounded exchange rounds advance every lane across reconnects", (t) => {
  const node = taskNode(t);
  const count = 33;
  for (let index = 0; index < count; index++) {
    const suffix = String(index + 1).padStart(12, "0");
    const requestId = `10000000-0000-4000-8000-${suffix}`;
    const operationId = `20000000-0000-4000-8000-${suffix}`;
    const queryRequestId = `30000000-0000-4000-8000-${suffix}`;
    const messageId = `40000000-0000-4000-8000-${suffix}`;
    storeMessage(node.paths.inbox, {
      messageId, from: { nodeId: OWNER, session: "owner" }, toSession: "target", text: "private",
      createdAt: new Date(T0 + index).toISOString(),
    }, T0 + index);
    setDeliveryTask(node.paths.inbox, messageId, { taskId: TASK, runtime: "codex" });
    queueControlRequest(node.paths, {
      name: "task.control.submit", requestId, action: "status", taskId: TASK,
    }, T0 + index);
    queueControlRequest(node.paths, {
      name: "task.control.submit", requestId: queryRequestId, action: "status", taskId: TASK,
    }, T0 + index);
    applyQueryResult(node.paths, {
      name: "task.control.query.result", requestId: queryRequestId, operationId,
      state: "pending", taskId: TASK, targetNodeId: TARGET, action: "status", freshness: "unavailable",
    }, T0 + index);
    const operation = { ...execute, operationId, requestId };
    beginOperation(node.paths, operation, T0 + index);
    completeOperation(node.paths, operationId, { ...result, operationId }, T0 + index);
  }

  const rounds: TaskControlEventBody[][] = [];
  for (let round = 0; round < 2; round++) {
    const sent: TaskControlEventBody[] = [];
    pollTaskControl({ sendTaskControl: (body) => { sent.push(body); return ["frame"]; } },
      node.paths, new Set(), () => true, T0 + round);
    rounds.push(sent);
    for (const name of ["task.control.register", "task.control.submit", "task.control.result", "task.control.query"] as const) {
      assert.equal(sent.filter((body) => body.name === name).length, 32);
    }
  }

  const identity = (body: TaskControlEventBody): string => {
    if (body.name === "task.control.register") return body.registrationId;
    if (body.name === "task.control.result") return body.operationId;
    if (body.name === "task.control.submit" || body.name === "task.control.query") return body.requestId;
    return body.name;
  };
  for (const name of ["task.control.register", "task.control.submit", "task.control.result", "task.control.query"] as const) {
    const delivered = new Set(rounds.flatMap((round) => round.filter((body) => body.name === name).map(identity)));
    assert.equal(delivered.size, count, `${name} must advance beyond the first batch after reconnect`);
  }
});
