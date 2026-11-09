import assert from "node:assert/strict";
import test from "node:test";

import type { MessageProgress } from "../protocol-messages.mts";
import type { TaskControlQueryResultBody, TaskControlSubmitBody } from "../protocol-task-control.mts";
import { taskSessionName } from "../protocol-tasks.mts";
import { recordSent, writeDirectory, writeOutbox } from "./exchange.mts";
import { runMsg } from "./msg-cli.mts";
import { applyQueryResult, readControlRequest } from "./task-control-store.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";
import { writeRequest } from "./task-records.mts";

// msg stop for a message delivered into an existing session (issue #241): the
// Worker holds no grant for that message and answers source_not_found. When
// the session is one of the sender's own tasks, msg stop stops that task; when
// it is not, it says so instead of the bare source_not_found.

const TARGET = "00000000-0000-4000-8000-0000000000cc";
const MESSAGE = "40000000-0000-4000-8000-000000000001";
const REQUEST = "50000000-0000-4000-8000-000000000001";
const SESSION = "019a0000-0000-7000-8000-0000000000ee";
const RUN = "a".repeat(64);

type Answer = Partial<TaskControlQueryResultBody> | null;
const measured = (extra: Answer): Answer => extra && ({ state: "succeeded", taskId: TASK, targetNodeId: TARGET, action: "status",
  runtime: "codex", taskState: "running", processState: "running", runVersion: RUN, freshness: "cached", stopSupported: true,
  stopConfirmed: false, ...extra });
const notFound: Answer = { state: "denied", freshness: "cached", errorCode: "source_not_found" };

// Plays the Worker: the n-th queued request gets answers[n] (null leaves it pending).
async function stop(node: ReturnType<typeof taskNode>, argv: string[], answers: Answer[]) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = T0;
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
    const ids = out.filter((line) => line.startsWith("request ")).map((line) => line.slice(8));
    const answer = answers[ids.length - 1];
    const requestId = ids.at(-1);
    const prior = requestId ? readControlRequest(node.paths, requestId)?.result : undefined;
    if (!answer || !requestId || (prior && prior.state !== "pending")) return;
    applyQueryResult(node.paths, { name: "task.control.query.result", requestId, operationId: crypto.randomUUID(),
      observedAt: new Date(clock).toISOString(), ...answer } as TaskControlQueryResultBody, clock);
  };
  const code = await runMsg(["stop", ...argv], { paths: node.paths, env: {}, now: () => clock, out: (l) => out.push(l),
    err: (l) => err.push(l), sleep });
  const submits = out.filter((line) => line.startsWith("request ")).map((line) => readControlRequest(node.paths, line.slice(8))!.submit);
  return { code, out, err, submits };
}

// The sender's message went to SESSION on TARGET, which the directory lists
// under `name`; owned makes the sender's dispatched task request own TASK there.
function delivered(node: ReturnType<typeof taskNode>, options: { name: string; owned: boolean }): void {
  const progress: MessageProgress = { phase: "waiting", code: "target-busy", observedAt: new Date(T0).toISOString() };
  writeOutbox(node.paths, { messageId: MESSAGE, fromSession: "owner", to: { nodeId: TARGET, session: SESSION }, text: "work",
    createdAt: new Date(T0).toISOString() });
  recordSent(node.paths, MESSAGE, "accepted", undefined, T0, progress);
  writeDirectory(node.paths, { fetchedAt: new Date(T0).toISOString(), nodes: [{ nodeId: TARGET, name: "node-a", status: "online" }],
    sessions: [{ nodeId: TARGET, sessionId: SESSION, runtime: "codex", state: "running", name: options.name, kind: "codex-task" }] });
  if (options.owned) {
    writeRequest(node.paths, { requestId: REQUEST, title: "t", text: "work", requirements: {}, directive: "d", requestedBy: "owner",
      createdAt: new Date(T0).toISOString(), state: "dispatched", taskId: TASK, nodeId: TARGET });
  }
}

const strip = (run: { submits: TaskControlSubmitBody[] }) => run.submits.map(({ requestId: _, ...rest }) => rest);

test("msg stop for a message delivered into the sender's own task stops that task's measured run", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  delivered(node, { name: taskSessionName(TASK), owned: true });
  const run = await stop(node, [MESSAGE], [notFound, measured({}),
    measured({ action: "stop", taskState: "stopped", processState: "closed", stopConfirmed: true })]);
  assert.equal(run.code, 0, run.err.join("\n"));
  assert.deepEqual(strip(run), [
    { name: "task.control.submit", action: "status", sourceMessageId: MESSAGE },
    { name: "task.control.submit", action: "status", taskId: TASK },
    { name: "task.control.submit", action: "stop", taskId: TASK, expectedRunVersion: RUN },
  ]);
  assert.ok(run.out.includes(`message ${MESSAGE} was delivered into the existing session node-a/${SESSION} of your own task ${TASK}; `
    + "stopping that task (later messages to it wait until an explicit continue of that task)"), run.out.join("\n"));
  assert.equal(run.out.at(-1), `stopped: task ${TASK}; its process and child processes ended at the target (task stopped)`);
});

test("msg stop for a message delivered into the sender's own task that no longer runs sends no stop", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  delivered(node, { name: taskSessionName(TASK), owned: true });
  const run = await stop(node, [MESSAGE], [notFound, measured({ taskState: "done", processState: "closed", stopSupported: false })]);
  assert.equal(run.code, 1);
  assert.deepEqual(run.submits.map((s) => s.action), ["status", "status"]);
  assert.ok(run.out.some((line) => line.includes(`of your own task ${TASK}`)));
  assert.equal(run.err.at(-1), `kherep-node msg: not stopped: task ${TASK} has no running process (task done, process closed); no stop was sent`);
});

test("msg stop for a message delivered into a session that is no task of the sender answers specifically", async (t) => {
  for (const options of [{ name: taskSessionName(TASK), owned: false }, { name: "codex-019a0000", owned: true }]) {
    const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
    delivered(node, options);
    const run = await stop(node, [MESSAGE], [notFound]);
    assert.equal(run.code, 1);
    assert.deepEqual(run.submits.map((s) => s.action), ["status"]);
    assert.equal(run.err.at(-1), `kherep-node msg: not stopped: message ${MESSAGE} was delivered into the existing session `
      + `node-a/${SESSION} (progress target-busy), which matches no task you own; it cannot be stopped by message id`);
  }
});

test("msg stop keeps other denials and the owned task reference unchanged", async (t) => {
  const node = taskNode(t, { ownTaskControl: true, runtimes: ["codex"] });
  delivered(node, { name: taskSessionName(TASK), owned: true });
  const other = await stop(node, [MESSAGE], [{ state: "denied", freshness: "cached", errorCode: "source_operator_owned" }]);
  assert.equal(other.code, 1);
  assert.deepEqual(other.submits.map((s) => s.action), ["status"]);
  assert.equal(other.err.at(-1), "kherep-node msg: not stopped: fresh status does not identify a stoppable run (denied, source_operator_owned)");
  // source_not_found for an owned request id is not a message delivery: unchanged.
  const request = await stop(node, [REQUEST], [notFound]);
  assert.deepEqual(request.submits.map((s) => s.action), ["status"]);
  assert.equal(request.err.at(-1), "kherep-node msg: not stopped: fresh status does not identify a stoppable run (denied, source_not_found)");
  const byTask = await stop(node, [TASK], [measured({}),
    measured({ action: "stop", taskState: "stopped", processState: "closed", stopConfirmed: true })]);
  assert.equal(byTask.code, 0, byTask.err.join("\n"));
  assert.ok(!byTask.out.some((line) => line.includes("was delivered into")));
});
