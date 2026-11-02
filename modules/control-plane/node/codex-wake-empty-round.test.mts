import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { pollCodexInbound } from "./codex-wake.mts";
import { getMessage, storeMessage, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { taskId, taskNode, T0 } from "./task-fixture.mts";
import { writeTask, type TaskRecord } from "./task-records.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";

type Node = ReturnType<typeof taskNode>;
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };

function endedTasks(t: test.TestContext, count = 1) {
  const node = taskNode(t, { runtimes: ["codex"] });
  const tasks = Array.from({ length: count }, (_, n): TaskRecord => {
    const id = taskId(1000 + n);
    return writeTask(node.paths, { taskId: id, name: `task-${id.slice(0, 8)}`, sessionId: `ended-${n}`,
      runtime: "codex", state: "done", permissionMode: "auto", cwd: node.workspace,
      startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString() }, T0);
  });
  // Independent fresh holder/loaded evidence, not the ended task rows.
  const rows = tasks.map(task => ({ runtime: "codex", sessionId: task.sessionId!, state: "idle-loaded" }));
  publishSynthetic(node.paths, rows.map(row => fixtureEvidence(row, "idle-loaded", T0)), T0, rows, node.livenessAuthority);
  const attempts: string[] = [];
  const deps = () => ({ ...node.deps(), codex: { findCodex: () => { attempts.push("resume"); return null; } } });
  return { ...node, tasks, attempts, deps };
}

test("ended task metadata without fresh independent source evidence never resumes", async t => {
  const node = endedTasks(t);
  const target = { runtime: "codex", sessionId: node.tasks[0].sessionId! };
  message(node, target.sessionId, "accepted", node.tasks[0]);
  publishSynthetic(node.paths, [fixtureEvidence(target, "unknown", T0)], T0,
    [{ ...target, state: "unknown" }], node.livenessAuthority);
  await pollCodexInbound(node.deps());
  assert.equal(node.attempts.length, 0);
});

function message(node: Node, toSession: string, state: InboxRecord["state"] = "accepted", task?: TaskRecord): InboxRecord {
  const record = storeMessage(node.paths.inbox, { messageId: crypto.randomUUID(), from: PEER, toSession,
    text: "synthetic peer message", createdAt: new Date(T0).toISOString(), ...(task ? { taskId: task.taskId } : {}) }, T0);
  const saved = { ...record, state, ...(state === "offered" ? { offers: 1, offeredAt: new Date(T0 - 600_000).toISOString() } : {}) };
  writeJsonAtomic(path.join(node.paths.inbox, `${record.messageId}.json`), saved);
  return saved;
}

function countInboxReads(t: test.TestContext, node: Node): () => number {
  let reads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] === "string" && path.dirname(args[0]) === node.paths.inbox && args[0].endsWith(".json")) reads++;
    return read(...args);
  });
  return () => reads;
}

test("18 ended tasks with no pending task messages read the populated inbox once and start no process", async (t) => {
  const node = endedTasks(t, 18);
  for (let n = 0; n < 278; n++) {
    let state: InboxRecord["state"] = "accepted";
    if (n === 0) state = "delivered";
    else if (n === 1) state = "refused";
    message(node, n < 2 ? node.tasks[n].name : "unrelated-session", state);
  }
  const reads = countInboxReads(t, node);
  await pollCodexInbound(node.deps());
  assert.equal(node.attempts.length, 0, "an empty task round starts no process");
  assert.equal(reads(), 278, "one listInbox snapshot, rather than one full scan per ended task");
});

test("no eligible ended Codex task means no inbox read", async (t) => {
  const node = endedTasks(t, 6);
  const changes: Partial<TaskRecord>[] = [{ runtime: "claude" }, { sessionId: "not/plain" }, { state: "running" },
    { running: true }, { operatorStoppedAt: new Date(T0).toISOString() }, { sessionId: undefined }];
  node.tasks.forEach((task, n) => {
    writeTask(node.paths, { ...task, ...changes[n] }, T0);
    message(node, task.name, "accepted", task);
  });
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    assert.notEqual(args[0], node.paths.inbox, "no directory or record read when no task is eligible");
    return readdir(...args);
  });
  await pollCodexInbound(node.deps());
  assert.equal(node.attempts.length, 0);
});

for (const ref of ["sessionId", "name"] as const) {
  test(`an accepted message addressed by exact task ${ref} reaches the existing wake path`, async (t) => {
    const node = endedTasks(t);
    const task = node.tasks[0];
    const record = message(node, task[ref]!, "accepted", task);
    await pollCodexInbound(node.deps());
    assert.equal(node.attempts.length, 1);
    assert.equal(getMessage(node.paths.inbox, record.messageId)?.retry, true, "the failed process start keeps the offer retryable");
  });
}

test("target matching is exact and ignores pending messages for other sessions", async (t) => {
  const node = endedTasks(t);
  const task = node.tasks[0];
  message(node, `${task.name}-other`, "accepted", task);
  message(node, `${task.sessionId}-other`, "offered", task);
  const reads = countInboxReads(t, node);
  await pollCodexInbound(node.deps());
  assert.equal(reads(), 2);
  assert.equal(node.attempts.length, 0);
});

test("an offered task message still reaches the existing retry bookkeeping", async (t) => {
  const node = endedTasks(t);
  const record = message(node, node.tasks[0].name, "offered", node.tasks[0]);
  await pollCodexInbound(node.deps());
  const saved = getMessage(node.paths.inbox, record.messageId)!;
  assert.equal(node.attempts.length, 1);
  assert.deepEqual([saved.state, saved.offers, saved.retry], ["offered", 2, true]);
});

test("a message arriving after an empty snapshot waits until the next fresh round", async (t) => {
  const node = endedTasks(t, 2);
  const unrelated = message(node, "unrelated-session");
  const file = path.join(node.paths.inbox, `${unrelated.messageId}.json`);
  const read = fs.readFileSync;
  let arrived: InboxRecord | undefined;
  const intercepted = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const result = read(...args);
    if (args[0] === file && !arrived) arrived = message(node, node.tasks[1].name, "accepted", node.tasks[1]);
    return result;
  });
  await pollCodexInbound(node.deps());
  intercepted.mock.restore();
  assert.ok(arrived);
  assert.equal(node.attempts.length, 0, "the initially empty round ends");
  assert.equal(getMessage(node.paths.inbox, arrived.messageId)?.state, "accepted");
  await pollCodexInbound(node.deps());
  assert.equal(node.attempts.length, 1, "the following round rereads the inbox");
  assert.equal(getMessage(node.paths.inbox, arrived.messageId)?.retry, true);
});

test("an initially pending round reads every task freshly after an awaited wake", async (t) => {
  const node = endedTasks(t, 2);
  message(node, node.tasks[0].name, "accepted", node.tasks[0]);
  let arrived: InboxRecord | undefined;
  const deps = node.deps();
  deps.codex.findCodex = () => {
    node.attempts.push("resume");
    if (node.attempts.length === 1) queueMicrotask(() => { arrived = message(node, node.tasks[1].name, "accepted", node.tasks[1]); });
    return null;
  };
  await pollCodexInbound(deps);
  assert.ok(arrived);
  assert.equal(node.attempts.length, 2, "the second task was not in the initial pending target set");
  assert.equal(getMessage(node.paths.inbox, arrived.messageId)?.retry, true);
});

test("wakeTask rereads a pending message changed after the routing snapshot", async (t) => {
  const node = endedTasks(t);
  const record = message(node, node.tasks[0].name, "accepted", node.tasks[0]);
  const file = path.join(node.paths.inbox, `${record.messageId}.json`);
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const result = read(...args);
    if (args[0] === file && ++reads === 1) writeJsonAtomic(file, { ...record, state: "delivered" });
    return result;
  });
  await pollCodexInbound(node.deps());
  assert.equal(node.attempts.length, 0, "the routing snapshot cannot authorize execution");
  assert.equal(reads, 2, "the wake decision uses a fresh sessionInbox read");
});

for (const sessions of [{ enabled: false }, { runtimes: ["claude"] }]) {
  // Issue #244: the waiting message is read to label it wake-disabled, but nothing starts.
  test(`disabled Codex sessions start no resume: ${JSON.stringify(sessions)}`, async (t) => {
    const node = endedTasks(t);
    const deps = node.deps();
    Object.assign(deps.policy.sessions!, sessions);
    const record = message(node, node.tasks[0].name, "accepted", node.tasks[0]);
    await pollCodexInbound(deps);
    assert.equal(node.attempts.length, 0);
    assert.equal(getMessage(node.paths.inbox, record.messageId)?.state, "accepted");
  });
}

test("a failed routing snapshot is logged and the original per-task read retries independently", async (t) => {
  const node = endedTasks(t);
  const record = message(node, node.tasks[0].name, "accepted", node.tasks[0]);
  const file = path.join(node.paths.inbox, `${record.messageId}.json`);
  const read = fs.readFileSync;
  let failed = false;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === file && !failed) { failed = true; throw new Error("synthetic routing read failure"); }
    return read(...args);
  });
  const lines: string[] = [];
  await pollCodexInbound(node.deps(), (line) => lines.push(line));
  assert.equal(node.attempts.length, 1, "the original wakeTask read retries after the routing failure");
  assert.equal(getMessage(node.paths.inbox, record.messageId)?.retry, true);
  assert.ok(lines.some((line) => /could not read inbox for Codex task routing: synthetic routing read failure/.test(line)));
});

// Issue #487: one waiting message for one ended task made every ended task
// read the whole inbox (23 tasks x about 0.5 s per round on the live node).
test("20 ended tasks and one waiting task message read the inbox a constant number of times, not once per task", async (t) => {
  const node = endedTasks(t, 20);
  for (let n = 0; n < 100; n++) message(node, "unrelated-session", "delivered");
  const waiting = message(node, node.tasks[0].name, "accepted", node.tasks[0]);
  const reads = countInboxReads(t, node);
  await pollCodexInbound(node.deps());
  assert.equal(node.attempts.length, 1, "the one task with a waiting message is resumed");
  assert.equal(getMessage(node.paths.inbox, waiting.messageId)?.retry, true);
  // Routing, the resume path (as before), one re-read after the acting task; it was one full read per task.
  assert.ok(reads() <= 6 * 101, `${reads()} record reads for 101 records and 20 ended tasks`);
});
