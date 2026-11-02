import assert from "node:assert/strict";
import test from "node:test";

import { takeTurn, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, deliver, missListings, PEER, SESSION, turnDone, type Node } from "./closed-fixture.mts";
import { deliveryContext } from "./deliver-core.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0 } from "./task-fixture.mts";
import { listTasks, taskGrants, writeTask, type TaskRecord } from "./task-records.mts";
import { wakeText } from "./wake-hook.mts";
import { pending } from "./wake-pending.mts";

// Issue #105: the intercom session a closed-session message started is reused
// for the next messages of the same sender session; a running one gets them
// through its delivery hook and wake, an ended one is resumed.

const claudeRuns = (node: Node) => node.calls.filter((c) => c.args[0] !== "agents");

// The first message: a new intercom session, still running.
async function firstIntercom(node: Node): Promise<TaskRecord> {
  deliver(node);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  assert.equal(task.local, "intercom");
  assert.ok(task.sessionId);
  return task;
}

// A later round with a fresh listing that shows none of the sessions.
function later(node: Node): void {
  node.tick(TURN_SPACING_MS * 2);
  missListings(node, 1, node.deps().now!());
}

test("a second message from the same sender goes to its running intercom session: no second session", async (t) => {
  const node = closedNode(t);
  const task = await firstIntercom(node);
  later(node);
  const id = deliver(node, { text: "and the lint?" });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 1, "no second run");
  assert.equal(listTasks(node.paths).length, 1);
  const record = getMessage(node.paths.inbox, id)!;
  assert.equal(record.toSession, task.sessionId);
  assert.equal(record.closedTo, SESSION);
  assert.deepEqual(record.delivery, { taskId: task.taskId, runtime: "claude", sessionId: task.sessionId });
  assert.equal(record.state, "accepted");
  assert.ok(record.closedAttempt);
  assert.equal(taskGrants(task, record), true, "the wake's task grant covers the sender's messages");
  const armed = { startedAt: T0 - 60_000, event: "Stop" as const };
  assert.deepEqual(pending(node.paths, [task.sessionId!, task.name], task.sessionId!, armed, T0, (r) => taskGrants(task, r))
    .fresh.map((r) => r.messageId), [id],
    "a listener of the intercom session wakes it for the message");
  const last = audits(node).at(-1)!;
  assert.deepEqual([last.outcome, last.reason, last.taskId, last.messageIds], ["reused", "intercom session running", task.taskId, [id]]);
  // The delivery hook of the intercom session offers it with the threaded reply command.
  const context = deliveryContext("Stop", [task.sessionId!, task.name], { paths: node.paths, replyCommand: "kherep-node" });
  assert.ok(context.includes(`To reply: kherep-node msg send --reply-to ${id} -- <reply text>`));
});

test("a listener armed after the message arrived but before it was readdressed still wakes for it (#113)", async (t) => {
  const node = closedNode(t);
  const task = await firstIntercom(node);
  later(node);
  const id = deliver(node, { text: "and the docs?" });
  const arrived = Date.parse(getMessage(node.paths.inbox, id)!.receivedAt);
  // Measured order: arrival, then the intercom session's listener arms, then the round readdresses.
  const armed = { startedAt: arrived + 1_000, event: "Stop" as const };
  node.tick(10_000);
  await deliverToClosed(node.deps());
  const record = getMessage(node.paths.inbox, id)!;
  assert.equal(record.toSession, task.sessionId);
  assert.ok(Date.parse(record.closedAttempt!) > armed.startedAt + 3_000, "the handover comes after the listener's grace period");
  assert.deepEqual(pending(node.paths, [task.sessionId!, task.name], task.sessionId!, armed, Date.parse(record.closedAttempt!),
    (r) => taskGrants(task, r))
    .fresh.map((r) => r.messageId), [id], "judged by the handover, not by the arrival");
});

test("a second message from the same sender resumes its ended intercom session, not the closed one", async (t) => {
  const node = closedNode(t);
  const task = await firstIntercom(node);
  writeTask(node.paths, { ...task, state: "done" });
  later(node);
  const id = deliver(node, { text: "and the lint?" });
  await deliverToClosed(node.deps());
  const runs = claudeRuns(node);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].args, ["--resume", task.sessionId, "--bg", "--permission-mode", "auto", wakeText(1)]);
  assert.ok(!runs.some((r) => r.args.includes(SESSION)), "the closed session is never resumed");
  const [resumed] = listTasks(node.paths);
  assert.equal(listTasks(node.paths).length, 1);
  assert.equal(resumed.state, "started");
  assert.equal(resumed.local, "intercom");
  assert.equal(getMessage(node.paths.inbox, id)?.toSession, task.sessionId);
  assert.deepEqual(getMessage(node.paths.inbox, id)?.delivery,
    { taskId: task.taskId, runtime: "claude", sessionId: task.sessionId });
  const last = audits(node).at(-1)!;
  assert.deepEqual([last.outcome, last.reason, last.taskId], ["reused", "intercom session resumed", task.taskId]);
  assert.deepEqual(node.reports(), []);
});

test("a different sender gets its own intercom session", async (t) => {
  const node = closedNode(t);
  const task = await firstIntercom(node);
  later(node);
  const other = { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "peer-2" };
  deliver(node, { from: other });
  await deliverToClosed(node.deps());
  const tasks = listTasks(node.paths);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((x) => x.requestedBy).sort(), [`${PEER.nodeId}/${PEER.session}`, `${other.nodeId}/${other.session}`].sort());
  assert.equal(taskGrants(task, getMessage(node.paths.inbox, deliver(node, { from: other }))!), false, "no grant for another sender");
  assert.deepEqual(claudeRuns(node).map((r) => r.args[0]), ["--bg", "--bg"]);
});

test("an intercom session that cannot be resumed, or continues as a copy that is not listed, gives way to a new one", async (t) => {
  for (const output of [null, "note: continuing as a copy\nbackgrounded · c0ffee01\n"]) {
    const node = closedNode(t);
    const task = await firstIntercom(node);
    writeTask(node.paths, { ...task, state: "done" });
    later(node);
    const id = deliver(node);
    const base = node.deps();
    const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
      if (args[0] !== "--resume") return base.exec!(file, args, options);
      node.calls.push({ file, args, options });
      if (output === null) throw new Error("No conversation found with session ID");
      return output;
    };
    await deliverToClosed({ ...base, exec });
    const runs = claudeRuns(node).map((c) => c.args[0]);
    assert.deepEqual(runs, output === null ? ["--bg", "--resume", "--bg"] : ["--bg", "--resume", "stop", "--bg"]);
    assert.equal(listTasks(node.paths).length, 2);
    await turnDone(node);
    assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered");
    const last = audits(node).at(-1)!;
    assert.equal(last.outcome, "new");
    assert.match(String(last.reason), /intercom session not resumed/);
  }
});

test("failed resume and failed fallback leave no delivery task association", async (t) => {
  const node = closedNode(t);
  const task = await firstIntercom(node);
  writeTask(node.paths, { ...task, state: "done" });
  later(node);
  const id = deliver(node);
  const base = node.deps();
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] === "--resume") throw new Error("resume failed");
    if (args[0] === "--bg") throw new Error("fallback failed");
    return base.exec!(file, args, options);
  };

  await deliverToClosed({ ...base, exec });
  const message = getMessage(node.paths.inbox, id);
  assert.equal(message?.state, "accepted");
  assert.equal(message?.delivery, undefined);
  assert.equal(listTasks(node.paths).filter((record) => record.state === "failed").length, 1);
  assert.match(String(audits(node).at(-1)?.reason), /resume failed.*fallback failed/);
});
test("an ended intercom session is not resumed past the budget of its session", async (t) => {
  const node = closedNode(t);
  const task = await firstIntercom(node);
  writeTask(node.paths, { ...task, state: "done" });
  later(node);
  for (let i = 0; i < TURNS_PER_HOUR; i++) takeTurn(node.paths, task.sessionId!, T0 - 50 * 60_000 + i * TURN_SPACING_MS * 2);
  const id = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 1);
  const last = audits(node).at(-1)!;
  assert.equal(last.outcome, "refused");
  assert.match(String(last.reason), /budget/);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
});
