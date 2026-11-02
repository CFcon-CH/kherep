import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { isNodeMessageStatusBody } from "../protocol-messages.mts";
import type { TaskRuntime } from "../protocol-tasks.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, deliver } from "./closed-fixture.mts";
import { THREAD, codexNode, waitFor } from "./codex-fixture.mts";
import { listCodexTaskSessions } from "./codex-sessions.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";
import { readExit } from "./codex-output.mts";
import { codexFiles } from "./codex-process.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { getMessage, getMessageProgress, storeMessage, unreportedStatuses } from "./inbox.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { createReadiness, type Readiness } from "./runtime-readiness.mts";
import { continueTask, startTask } from "./session-runner.mts";
import { startArgs, T0, TASK } from "./task-fixture.mts";
import { listTasks, readTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #197: a run that needs a runtime which cannot authenticate starts
// nothing. A task is reported failed, a message refused, each with a fixed reason.

const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };
const EXPIRED: ProbeResult = { ok: false, cause: "sign-in", detail: "Login expired · Please run /login" };
const REASON = (runtime: TaskRuntime): string => `target runtime ${runtime} not ready (sign-in required)`;

function verdicts(result: ProbeResult): { readiness: Readiness; probes: TaskRuntime[] } {
  const probes: TaskRuntime[] = [];
  return { probes, readiness: createReadiness(async (runtime) => { probes.push(runtime); return result; }, { now: () => T0 }) };
}

test("an operator task for a runtime that is not signed in fails with the fixed reason and starts nothing", async (t) => {
  const node = closedNode(t);
  const { readiness, probes } = verdicts(EXPIRED);
  await assert.rejects(startTask(startArgs(), { ...node.deps(), readiness }), /target runtime claude not ready \(sign-in required\)/);
  assert.deepEqual(node.calls, [], "no claude run");
  assert.equal(readTask(node.paths, TASK), null, "no record, so no slot and no start counted");
  assert.deepEqual(node.reports(), [{ taskId: TASK, state: "failed", reason: REASON("claude") }]);
  assert.deepEqual(probes, ["claude"]);
});

test("a message for a closed session is refused, not delivered, when the runtime cannot run a turn", async (t) => {
  const node = closedNode(t);
  const id = deliver(node);
  const { readiness } = verdicts(EXPIRED);
  await readiness.check("claude");
  await deliverToClosed({ ...node.deps(), readiness });
  assert.deepEqual(node.calls.filter((c) => c.args[0] !== "agents"), [], "no intercom start");
  const record = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([record.state, record.reason, record.closedAttempt], ["refused", REASON("claude"), undefined]);
  const [status] = unreportedStatuses(node.paths.inbox).map(({ messageId, state, reason }) => ({ messageId, state, reason }));
  assert.deepEqual(status, { messageId: id, state: "refused", reason: REASON("claude") });
  assert.equal(isNodeMessageStatusBody(status), true, "an existing Worker accepts the refusal");
  assert.deepEqual(audits(node).map((a) => [a.outcome, a.reason]), [["refused", REASON("claude")]]);
  assert.equal(listTasks(node.paths).length, 0);
});

test("after a probe that timed out the message waits as retry-pending with no attempt; it is never refused for that", async (t) => {
  const node = closedNode(t);
  const id = deliver(node);
  const { readiness } = verdicts({ ok: false, cause: "timeout", detail: "" });
  await readiness.check("claude");
  await deliverToClosed({ ...node.deps(), readiness });
  const record = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([record.state, record.closedAttempt], ["accepted", undefined]);
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "retry-pending");
  assert.equal(node.calls.length, 0, "no intercom start");
});

test("while the probe runs the message waits as retry-pending; a ready verdict then starts the intercom", async (t) => {
  const node = closedNode(t);
  const id = deliver(node);
  let release: (result: ProbeResult) => void = () => {};
  const readiness = createReadiness(() => new Promise<ProbeResult>((resolve) => { release = resolve; }));
  await deliverToClosed({ ...node.deps(), readiness });
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "retry-pending");
  assert.equal(node.calls.length, 0);
  release({ ok: true });
  await readiness.check("claude");
  await deliverToClosed({ ...node.deps(), readiness });
  assert.equal(node.calls.filter((c) => c.args[0] === "--bg").length, 1, "started once ready");
});

test("a Codex task start and a Codex message resume are refused while codex cannot authenticate", posix, async (t) => {
  const node = codexNode(t);
  await startTask(startArgs(TASK, { runtime: "codex" }), node.deps());
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, "the first run");
  await watchTasks(node.deps());
  assert.equal(readTask(node.paths, TASK)?.state, "done");
  node.reports();
  const { readiness } = verdicts(EXPIRED);
  await assert.rejects(continueTask({ taskId: TASK, prompt: "more" }, { ...node.deps(), readiness }), /target runtime codex not ready/);
  const other = "3f2a1b0c-0000-4000-8000-0000000000ff";
  await assert.rejects(startTask(startArgs(other, { runtime: "codex" }), { ...node.deps(), readiness }), /target runtime codex not ready/);
  assert.deepEqual(node.reports(), [{ taskId: other, state: "failed", reason: REASON("codex") }]);
  const id = "7e570001-0000-4000-8000-0000000000ee";
  storeMessage(node.paths.inbox, { messageId: id, from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" },
    toSession: "task-3f2a1b0c", text: "status?", createdAt: new Date(T0).toISOString(), taskId: TASK }, T0);
  await readiness.check("codex");
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  fs.writeFileSync(node.paths.policy, JSON.stringify({ ...policy, wake: { enabled: true, sessions: ["unrelated"] } }));
  await pollCodexInbound({ ...node.deps(), readiness });
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", "UNKNOWN cannot authorize even an early runtime refusal");
  publishSynthetic(node.paths, [fixtureEvidence({ runtime: "codex", sessionId: THREAD }, "idle-loaded", T0)],
    T0, listCodexTaskSessions(node.paths, T0).map(row => ({ ...row, state: "idle-loaded" })), node.livenessAuthority);
  await pollCodexInbound({ ...node.deps(), readiness });
  assert.equal(node.runs().length, 1, "only the first run");
  assert.deepEqual([getMessage(node.paths.inbox, id)?.state, getMessage(node.paths.inbox, id)?.reason], ["refused", REASON("codex")]);
});
