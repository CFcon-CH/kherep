import { describe, expect, it } from "vitest";

import { TASK_CONTROL_CAPABILITY, TASK_CONTROL_REPORT_CAPABILITY } from "../../protocol-task-control.mts";
import { DELEGATE_ACCEPT_CAPABILITY, SESSIONS_CAPABILITY } from "../../protocol-tasks.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

// Issue #965: refusal branches of TaskControlRegistry through the Registry RPC:
// ineligible nodes, unusable grants, and unresolvable or foreign sources.
const controlCaps = [TASK_CONTROL_CAPABILITY, SESSIONS_CAPABILITY, "messaging.v1"];
const codex = [{ name: "codex", kind: "cli" as const }];

async function node(capabilities = controlCaps, runtimes = ["codex"]): Promise<string> {
  const nodeId = await enroll(await newKey(), `tc-${crypto.randomUUID()}`);
  await registry().updateRegistration(nodeId, FACTS, runtimes.map((name) => ({ name, kind: "cli" as const })), capabilities);
  await registry().setStatus(nodeId, "online", Date.now());
  return nodeId;
}

async function message(owner: string, target: string): Promise<string> {
  const messageId = crypto.randomUUID();
  const sent = await registry().sendMessage({ messageId, from: { nodeId: owner, session: "owner" },
    to: { nodeId: target, session: "local-task" }, text: "synthetic task text" }, "test");
  expect(sent.ok).toBe(true);
  return messageId;
}

const register = (taskId: string, sourceMessageId: string, runtime: "codex" | "claude" = "codex") => ({
  name: "task.control.register" as const, registrationId: crypto.randomUUID(), taskId, runtime, associationVersion: 1, sourceMessageId,
});
const status = (source: { taskId?: string; sourceMessageId?: string; sourceRequestId?: string }, requestId = crypto.randomUUID()) => ({
  name: "task.control.submit" as const, requestId, action: "status" as const, ...source,
});
const denied = (errorCode: string) => ({ reply: expect.objectContaining({ state: "denied", errorCode }) });

async function granted(ownerCaps = controlCaps) {
  const owner = await node(ownerCaps), target = await node(), taskId = crypto.randomUUID();
  const sourceMessageId = await message(owner, target);
  expect(await registry().registerTaskControl(target, register(taskId, sourceMessageId))).toMatchObject({ ok: true });
  return { owner, target, taskId, sourceMessageId };
}

async function complete(target: string, taskId: string, operationId: string): Promise<void> {
  expect((await registry().recordTaskControlResult(target, { name: "task.control.result", operationId, taskId, state: "succeeded",
    runtime: "codex", taskState: "running", processState: "running", runVersion: "a".repeat(64),
    observedAt: new Date().toISOString(), freshness: "fresh", stopSupported: false, stopConfirmed: false })).ok).toBe(true);
}

describe("task-control registration refusals", () => {
  it("refuses an unknown or ineligible target, an ineligible owner and an unsupported runtime", async () => {
    const owner = await node(), target = await node(), plain = await node([SESSIONS_CAPABILITY, "messaging.v1"]);
    const sourceMessageId = await message(owner, target);
    expect(await registry().registerTaskControl(crypto.randomUUID(), register(crypto.randomUUID(), sourceMessageId)))
      .toMatchObject({ ok: false, errorCode: "capability_required" });
    expect(await registry().registerTaskControl(target, register(crypto.randomUUID(), sourceMessageId, "claude")))
      .toMatchObject({ ok: false, errorCode: "unsupported_runtime" });
    const fromPlain = await message(plain, target);
    expect(await registry().registerTaskControl(target, register(crypto.randomUUID(), fromPlain)))
      .toMatchObject({ ok: false, errorCode: "capability_required" });
  });
});

describe("task-control submit refusals", () => {
  it("refuses an ineligible owner, first without and then with a finished operation", async () => {
    const { owner, target, taskId } = await granted();
    const first = status({ taskId });
    const { execute } = await registry().submitTaskControl(owner, first);
    await complete(target, taskId, execute!.operationId);
    await registry().updateRegistration(owner, FACTS, codex, [SESSIONS_CAPABILITY]);
    expect(await registry().submitTaskControl(owner, status({ taskId }))).toEqual(denied("capability_required"));
    expect(await registry().submitTaskControl(owner, first)).toEqual(denied("grant_revoked"));
    expect(await registry().queryTaskControl(owner, first.requestId)).toMatchObject({ state: "denied", errorCode: "grant_revoked" });
  });

  it("denies replays and new requests once the target loses the runtime", async () => {
    const { owner, target, taskId } = await granted();
    const done = status({ taskId }), pending = status({ taskId });
    const { execute } = await registry().submitTaskControl(owner, done);
    await complete(target, taskId, execute!.operationId);
    await registry().submitTaskControl(owner, pending);
    await registry().replaceRuntimes(target, []);
    expect(await registry().submitTaskControl(owner, done)).toEqual(denied("grant_revoked"));
    expect(await registry().queryTaskControl(owner, pending.requestId)).toMatchObject({ state: "denied", errorCode: "grant_revoked" });
    expect(await registry().submitTaskControl(owner, pending)).toEqual(denied("grant_revoked"));
    expect(await registry().submitTaskControl(owner, status({ taskId }))).toEqual(denied("grant_revoked"));
  });

  it("refuses unknown sources and sources owned by another node", async () => {
    const { owner, taskId, sourceMessageId } = await granted();
    const foreign = await node();
    expect(await registry().submitTaskControl(owner, status({ sourceMessageId: crypto.randomUUID() }))).toEqual(denied("source_not_found"));
    expect(await registry().submitTaskControl(foreign, status({ sourceMessageId }))).toEqual(denied("foreign_owner"));
    expect(await registry().submitTaskControl(owner, status({ sourceRequestId: crypto.randomUUID() }))).toEqual(denied("source_not_found"));
    expect(await registry().submitTaskControl(foreign, status({ taskId }))).toEqual(denied("foreign_owner"));
    expect(await registry().submitTaskControl(owner, status({ taskId: crypto.randomUUID() }))).toEqual(denied("task_unknown"));
  });

  it("refuses a delegated task to a node that is not its owner", async () => {
    const owner = await node(), foreign = await node();
    const target = await node([...controlCaps, DELEGATE_ACCEPT_CAPABILITY], ["claude"]);
    const created = await registry().createTask({ title: "delegated", text: "synthetic", requirements: { runtime: "claude", node: target },
      permissionMode: "auto", createdBy: `session:${owner}/maestro`, requestedBy: `${owner}/maestro`, directive: "operator said so",
      requestId: crypto.randomUUID(), fromNode: owner });
    if (!created.ok) throw new Error(created.reason);
    expect(await registry().submitTaskControl(foreign, status({ taskId: created.task.taskId }))).toEqual(denied("foreign_owner"));
  });

  it("adds no reported state for a message-started task", async () => {
    const { owner, sourceMessageId } = await granted([...controlCaps, TASK_CONTROL_REPORT_CAPABILITY]);
    const submitted = await registry().submitTaskControl(owner, status({ sourceMessageId }));
    expect(submitted.reply).toMatchObject({ state: "pending" });
    expect(submitted.reply).not.toHaveProperty("reportedState");
  });
});

describe("task-control result refusals", () => {
  it("refuses results for an unknown operation, a changed replay, a wrong runtime and an unasked stop", async () => {
    const { owner, target, taskId } = await granted();
    const statusOp = (await registry().submitTaskControl(owner, status({ taskId }))).execute!.operationId;
    const stopOp = (await registry().submitTaskControl(owner, { name: "task.control.submit", requestId: crypto.randomUUID(),
      action: "stop", taskId, expectedRunVersion: "c".repeat(64) })).execute!.operationId;
    const result = (operationId: string, extra: Record<string, unknown> = {}) => registry().recordTaskControlResult(target, {
      name: "task.control.result", operationId, taskId, state: "succeeded", runtime: "codex", taskState: "running",
      processState: "running", observedAt: "2026-11-19T08:00:00.000Z", freshness: "fresh", stopSupported: true, stopConfirmed: false, ...extra });
    const mismatch = { ok: false, errorCode: "result_mismatch" };
    expect(await result(crypto.randomUUID())).toEqual(mismatch);
    expect(await result(statusOp, { runtime: "claude" })).toEqual(mismatch);
    expect(await result(statusOp, { stopConfirmed: true })).toEqual(mismatch);
    expect(await result(stopOp, { state: "failed", errorCode: "stop_failed", stopConfirmed: true })).toEqual(mismatch);
    expect(await result(statusOp)).toMatchObject({ ok: true });
    expect(await result(statusOp, { taskState: "stopped" })).toEqual(mismatch);
  });
});

describe("task-control query, retry and pending pages", () => {
  it("answers a query for an unknown request without an operation", async () => {
    const owner = await node(), requestId = crypto.randomUUID();
    const answer = await registry().queryTaskControl(owner, requestId);
    expect(answer).toMatchObject({ name: "task.control.query.result", requestId });
    expect(answer).not.toHaveProperty("operationId");
  });

  it("retries only a pending operation whose grant is still usable", async () => {
    const { owner, target, taskId } = await granted();
    expect(await registry().retryTaskControl(owner, crypto.randomUUID())).toBeNull();
    const submit = status({ taskId });
    const { execute } = await registry().submitTaskControl(owner, submit);
    expect(await registry().retryTaskControl(owner, submit.requestId)).toMatchObject({ operationId: execute!.operationId });
    await registry().replaceRuntimes(target, []);
    expect(await registry().retryTaskControl(owner, submit.requestId)).toBeNull();
    expect(await registry().queryTaskControl(owner, submit.requestId)).toMatchObject({ state: "denied", errorCode: "grant_revoked" });
  });

  it("drops and denies pending executions whose grant became unusable", async () => {
    const { owner, target, taskId } = await granted();
    const submit = status({ taskId });
    await registry().submitTaskControl(owner, submit);
    await registry().updateRegistration(owner, FACTS, codex, [SESSIONS_CAPABILITY]);
    expect(await registry().pendingTaskControlFor(target, 32)).toEqual([]);
    await registry().updateRegistration(owner, FACTS, codex, controlCaps);
    expect(await registry().queryTaskControl(owner, submit.requestId)).toMatchObject({ state: "denied", errorCode: "grant_revoked" });
  });
});
