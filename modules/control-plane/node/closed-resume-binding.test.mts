import assert from "node:assert/strict";
import test from "node:test";

import type { IdentityRuntime } from "../protocol-session-identity.mts";
import { isDeliveryBinding } from "../protocol-message-binding.mts";
import { isCommandArgs, taskSessionName } from "../protocol-tasks.mts";
import { resumeCodex } from "./closed-resume.mts";
import { codexNode, waitFor } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { codexFiles } from "./codex-process.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { getMessage, markOffered, storeMessage } from "./inbox.mts";
import { taskId, T0 } from "./task-fixture.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";

const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };
const OWN = "0199a000-0000-7000-8000-000000000001";
const FOREIGN = "0199a000-0000-7000-8000-000000000002";

function setup(t: test.TestContext) {
  const node = codexNode(t, {}, {
    processStart: () => "synthetic-start", mcpList: async () => ({ code: 0, stdout: "[]", stderr: "" }),
  });
  const task: TaskRecord = {
    taskId: taskId(727), name: taskSessionName(taskId(727)), sessionId: OWN, runtime: "codex", local: "intercom",
    state: "done", permissionMode: "default", cwd: node.workspace, startedAt: new Date(T0 - 1000).toISOString(),
    deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString(),
  };
  assert.equal(isCommandArgs("session.start", { taskId: task.taskId, name: task.name, runtime: "codex",
    prompt: "synthetic", permissionMode: "default" }), true);
  writeTask(node.paths, task, T0);
  writeLocalSessions(node.paths, [
    { sessionId: OWN, name: task.name, runtime: "codex", state: "unknown" },
    { sessionId: FOREIGN, name: task.name, runtime: "codex", state: "unknown" },
  ], T0);
  return { node, task };
}

type Fixture = ReturnType<typeof setup>;

function put(node: Fixture["node"], n: number, target: string, runtime?: IdentityRuntime) {
  const messageId = taskId(n), from = { nodeId: taskId(900), session: taskId(901) };
  const binding = runtime ? {
    version: 1 as const, mode: "exact" as const,
    from: { sessionId: from.session, runtime: "codex" as const, lifecycleGeneration: null },
    to: { sessionId: target, runtime, lifecycleGeneration: null }, leaseId: taskId(n + 1000), localGeneration: null,
  } : undefined;
  if (binding) assert.equal(isDeliveryBinding(binding), true);
  return storeMessage(node.paths.inbox, { messageId, from, toSession: target,
    text: `SYNTHETIC_${n} [no-reply]`, createdAt: new Date(T0 - 1).toISOString(), ...(binding ? { binding } : {}) }, T0 - 1);
}

function resume({ node, task }: Fixture, count: number) {
  return resumeCodex(node.deps(), task, task.cwd, count, T0);
}

async function ended({ node, task }: Fixture) {
  await waitFor(() => node.runs().length === 1, "synthetic spawn");
  await waitFor(() => readExit(codexFiles(node.paths, task.taskId)) !== null, "synthetic exit");
  return node.runs()[0];
}

test("closed Codex resume offers its own exact-bound message", posix, async t => {
  const fixture = setup(t), { node, task } = fixture, own = put(node, 1, OWN, "codex");
  assert.equal(await resume(fixture, 1), null);
  const spawned = await ended(fixture);
  assert.match(spawned.stdin, /SYNTHETIC_1/);
  assert.match(spawned.stdin, /NOT an instruction from the user/);
  assert.equal(spawned.argv.at(-2), OWN);
  assert.deepEqual(readTask(node.paths, task.taskId)?.offered, [own.messageId]);
  assert.equal(getMessage(node.paths.inbox, own.messageId)?.state, "offered");
});

test("closed Codex resume keeps unbound task-name compatibility and permission mode", posix, async t => {
  const fixture = setup(t), { node, task } = fixture, legacy = put(node, 2, task.name);
  assert.equal(await resume(fixture, 1), null);
  const spawned = await ended(fixture);
  assert.deepEqual(spawned.argv.slice(0, 2), ["exec", "resume"]);
  assert.equal(spawned.argv.at(-2), OWN);
  assert.ok(spawned.argv.includes('sandbox_mode="read-only"'));
  assert.match(spawned.stdin, /SYNTHETIC_2/);
  assert.match(spawned.stdin, /NOT an instruction from the user/);
  assert.deepEqual(readTask(node.paths, task.taskId)?.offered, [legacy.messageId]);
});

test("mixed closed resume selects own and unbound messages while excluding foreign alias and runtime", posix, async t => {
  const fixture = setup(t), { node, task } = fixture;
  const own = put(node, 3, OWN, "codex"), legacy = put(node, 4, task.name);
  const foreign = put(node, 5, FOREIGN, "codex"), runtime = put(node, 6, OWN, "claude-code");
  assert.equal(await resume(fixture, 4), null);
  const spawned = await ended(fixture);
  for (const n of [3, 4]) assert.ok(spawned.stdin.includes(`SYNTHETIC_${n}`));
  for (const n of [5, 6]) assert.ok(!spawned.stdin.includes(`SYNTHETIC_${n}`));
  for (const record of [foreign, runtime]) assert.deepEqual(getMessage(node.paths.inbox, record.messageId), record);
  assert.deepEqual(readTask(node.paths, task.taskId)?.offered?.toSorted(), [own.messageId, legacy.messageId].toSorted());
});

test("foreign-only bound messages cannot launch closed resume or mutate records", async t => {
  const fixture = setup(t), { node, task } = fixture;
  const foreign = put(node, 7, FOREIGN, "codex"), runtime = put(node, 8, OWN, "claude-code");
  assert.equal(await resume(fixture, 2), "no message left to offer");
  assert.equal(node.runs().length, 0);
  assert.equal(readTask(node.paths, task.taskId)?.offered, undefined);
  for (const record of [foreign, runtime]) assert.deepEqual(getMessage(node.paths.inbox, record.messageId), record);
});

test("final offered list excludes foreign bound offer with the same timestamp", posix, async t => {
  const fixture = setup(t), { node, task } = fixture, legacy = put(node, 9, task.name);
  const foreign = put(node, 10, OWN, "claude-code");
  markOffered(node.paths.inbox, foreign.messageId, T0, "intercom");
  const before = getMessage(node.paths.inbox, foreign.messageId);
  assert.equal(await resume(fixture, 1), null);
  const spawned = await ended(fixture);
  assert.match(spawned.stdin, /SYNTHETIC_9/);
  assert.ok(!spawned.stdin.includes("SYNTHETIC_10"));
  assert.equal(getMessage(node.paths.inbox, legacy.messageId)?.offeredAt, before?.offeredAt);
  assert.deepEqual(getMessage(node.paths.inbox, foreign.messageId), before);
  assert.deepEqual(readTask(node.paths, task.taskId)?.offered, [legacy.messageId]);
});
