import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, deliver, missListings, PEER, SESSION, type Node } from "./closed-fixture.mts";
import { SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { deliveryContext } from "./deliver-core.mts";
import { recordingSessions, type SentRecord } from "./exchange.mts";
import { getMessage, getMessageProgress, writeJsonAtomic } from "./inbox.mts";
import { CLOSED_AFTER_MISSES, CLOSED_MIN_AGE_MS, readKnownSessions, rememberSessions } from "./known-sessions.mts";
import { replyLines } from "./msg-inbox.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0, taskId } from "./task-fixture.mts";
import { listTasks, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #389: a session missing from one listing is not closed. Closed-session
// delivery hands a message (a reply or not) to an intercom session of its
// sender only once the target missed CLOSED_AFTER_MISSES consecutive successful
// listings spanning CLOSED_MIN_AGE_MS. Before that every message stays
// addressed to its session and waits; after it a reply takes the #102/#105
// path like any other message, and msg status on the original sender names
// where it went.

const ORIGINAL = "5e5d0389-0000-4000-8000-000000000001";
const claudeRuns = (node: Node) => node.calls.filter((c) => c.args[0] !== "agents");

function assertWaitingFor(node: Node, id: string): void {
  const record = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([record.state, record.toSession, record.closedTo, record.closedAttempt, record.delivery],
    ["accepted", SESSION, undefined, undefined, undefined], "stays addressed to its session, no handover");
  const progress = getMessageProgress(node.paths.inbox, id);
  assert.deepEqual([progress?.phase, progress?.code], ["waiting", "awaiting-user-turn"]);
}

function assertHandedTo(node: Node, id: string, task: TaskRecord): void {
  const record = getMessage(node.paths.inbox, id)!;
  assert.equal(record.closedTo, SESSION);
  assert.ok(record.toSession === task.name || record.toSession === task.sessionId, record.toSession);
  assert.equal(record.delivery?.taskId, task.taskId);
}

// One more periodic listing without SESSION, at the node's clock.
function periodicMiss(node: Node, at: number): void {
  node.tick(at - (node.deps().now?.() ?? T0));
  missListings(node, 1, at);
}

test("a reply and a plain message for a session missing from fewer than N listings stay with it (issue #389)", async (t) => {
  const node = closedNode(t, {}, {}, CLOSED_AFTER_MISSES - 1);
  const reply = deliver(node, { text: "the production credential is wrong", inReplyTo: ORIGINAL });
  const plain = deliver(node, { text: "and the lint?" });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0, "no intercom session");
  assert.equal(listTasks(node.paths).length, 0);
  assertWaitingFor(node, reply);
  assertWaitingFor(node, plain);
  assert.deepEqual(audits(node), []);
  // The session's own delivery hook offers both on its next turn.
  const context = deliveryContext("UserPromptSubmit", [SESSION], { paths: node.paths, replyCommand: "kherep-node" });
  assert.ok(context.includes(reply) && context.includes(plain));
  assert.match(context, /the production credential is wrong/);
});

test("the Nth periodic miss closes the session: reply and plain message go to a new intercom session of the sender (issue #389)", async (t) => {
  const node = closedNode(t, {}, {}, CLOSED_AFTER_MISSES - 1);
  const reply = deliver(node, { inReplyTo: ORIGINAL });
  const plain = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  periodicMiss(node, T0 + SESSIONS_INTERVAL_MS);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  assert.equal(task.local, "intercom");
  assert.equal(task.requestedBy, `${PEER.nodeId}/${PEER.session}`);
  const runs = claudeRuns(node);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].args.join(" ").includes(reply), "the reply is in the intercom prompt");
  assertHandedTo(node, reply, task);
  assertHandedTo(node, plain, task);
});

test("N listings within less than the minimum age hand nothing over (issue #389)", async (t) => {
  const node = closedNode(t, {}, {}, 0);
  // A burst of listings, 10 s apart (registration, Worker session.list, ...).
  missListings(node, CLOSED_AFTER_MISSES + 2, T0, 10_000);
  const reply = deliver(node, { inReplyTo: ORIGINAL });
  const plain = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assertWaitingFor(node, reply);
  assertWaitingFor(node, plain);
  // The next periodic listing is CLOSED_MIN_AGE_MS after the first miss.
  const firstMiss = T0 - (CLOSED_AFTER_MISSES + 1) * 10_000;
  assert.ok(T0 + SESSIONS_INTERVAL_MS - firstMiss >= CLOSED_MIN_AGE_MS);
  periodicMiss(node, T0 + SESSIONS_INTERVAL_MS);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  assertHandedTo(node, reply, task);
  assertHandedTo(node, plain, task);
});

test("a listing that shows the session resets its streak (issue #389)", async (t) => {
  const node = closedNode(t);
  const shown = { sessionId: SESSION, runtime: "claude-code", state: "idle", name: "review" };
  node.tick(SESSIONS_INTERVAL_MS);
  missListings(node, 1, T0 + SESSIONS_INTERVAL_MS, SESSIONS_INTERVAL_MS, [shown]);
  for (let i = 2; i <= CLOSED_AFTER_MISSES; i++) periodicMiss(node, T0 + i * SESSIONS_INTERVAL_MS);
  const reply = deliver(node, { inReplyTo: ORIGINAL });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0, `${CLOSED_AFTER_MISSES - 1} misses since it was shown`);
  assertWaitingFor(node, reply);
  periodicMiss(node, T0 + (CLOSED_AFTER_MISSES + 1) * SESSIONS_INTERVAL_MS);
  await deliverToClosed(node.deps());
  assertHandedTo(node, reply, listTasks(node.paths)[0]);
});

test("a failed listing counts no miss; the next successful one does (issue #389)", async (t) => {
  const node = closedNode(t, {}, {}, CLOSED_AFTER_MISSES - 1);
  const now = () => node.deps().now!();
  const reply = deliver(node, { inReplyTo: ORIGINAL });
  node.tick(SESSIONS_INTERVAL_MS);
  const failing = recordingSessions(node.paths, async () => { throw new Error("claude agents failed"); }, () => {}, now);
  await assert.rejects(failing(), /claude agents failed/);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assertWaitingFor(node, reply);
  const { fixtureEvidence, syntheticListing } = await import("./session-authority-fixture.mts");
  await recordingSessions(node.paths, async () => syntheticListing(node.livenessAuthority, [],
    [fixtureEvidence({ runtime: "claude-code", sessionId: SESSION }, "closed", now())], now()),
    () => {}, now, undefined, undefined, node.livenessAuthority)();
  await deliverToClosed(node.deps());
  assertHandedTo(node, reply, listTasks(node.paths)[0]);
});

test("a reply for a closed session goes to the sender's running intercom session, and msg status names it (issue #389)", async (t) => {
  const node = closedNode(t);
  deliver(node);
  await deliverToClosed(node.deps());
  const [intercom] = listTasks(node.paths);
  node.tick(TURN_SPACING_MS * 2);
  missListings(node, 1, T0 + TURN_SPACING_MS * 2);
  const reply = deliver(node, { inReplyTo: ORIGINAL });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 1, "handed to the running session, no further run");
  assertHandedTo(node, reply, intercom);
  const progress = getMessageProgress(node.paths.inbox, reply);
  assert.deepEqual([progress?.phase, progress?.code], ["fallback", "fallback-running"]);
  const last = audits(node).at(-1)!;
  assert.deepEqual([last.outcome, last.reason, last.messageIds], ["reused", "intercom session running", [reply]]);
  // The original sender sees where the reply went.
  const sent: SentRecord = { messageId: ORIGINAL, fromSession: SESSION, to: PEER, state: "replied", updatedAt: new Date(T0).toISOString() };
  const lines = replyLines(node.paths, sent).filter((l) => !l.startsWith("  reply ") || l.includes(reply));
  assert.match(lines[0], new RegExp(`^  reply ${reply} from node ${PEER.nodeId}, session ${PEER.session} \\(accepted, received `));
  const record = getMessage(node.paths.inbox, reply)!;
  assert.deepEqual(lines.slice(1, 3), [`    forwarded to: session ${record.toSession}`, `    delivery task: ${intercom.taskId}`]);
});

test("a target this node never listed is tracked from its first message and closed only by the misses after it (issue #389)", async (t) => {
  const node = closedNode(t);
  // A task session that ended between two listings: no known-sessions entry.
  const ended = "7a5c0389-0000-4000-8000-0000000000aa";
  writeTask(node.paths, { taskId: taskId(7), name: "task-00000007", sessionId: ended, cwd: path.join(node.workspace, "repo"),
    permissionMode: "auto", state: "done", startedAt: new Date(T0 - 600_000).toISOString(),
    deadline: new Date(T0 + 3_600_000).toISOString(), updatedAt: new Date(T0 - 300_000).toISOString() });
  const id = deliver(node, { toSession: ended, inReplyTo: ORIGINAL });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual(readKnownSessions(node.paths).filter((s) => s.sessionId === ended).map((s) => [s.runtime, s.misses]),
    [["claude-code", undefined]], "tracked from now on");
  for (let i = 1; i < CLOSED_AFTER_MISSES; i++) {
    periodicMiss(node, T0 + i * SESSIONS_INTERVAL_MS);
    await deliverToClosed(node.deps());
  }
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual([getMessage(node.paths.inbox, id)?.toSession, getMessage(node.paths.inbox, id)?.closedTo], [ended, undefined]);
  periodicMiss(node, T0 + CLOSED_AFTER_MISSES * SESSIONS_INTERVAL_MS);
  await deliverToClosed(node.deps());
  const intercom = listTasks(node.paths).find((task) => task.local === "intercom")!;
  assert.equal(getMessage(node.paths.inbox, id)?.closedTo, ended);
  assert.equal(getMessage(node.paths.inbox, id)?.delivery?.taskId, intercom.taskId);
});

// The peer's intercom session, shown by one listing and then closed by N misses.
async function endedIntercom(node: Node): Promise<TaskRecord> {
  deliver(node);
  await deliverToClosed(node.deps());
  const [task] = listTasks(node.paths);
  writeTask(node.paths, { ...task, state: "done" });
  rememberSessions(node.paths, [{ sessionId: task.sessionId!, runtime: "claude-code", state: "idle" }], T0 + 1_000);
  const end = T0 + 1_000 + CLOSED_AFTER_MISSES * SESSIONS_INTERVAL_MS;
  node.tick(end - T0);
  missListings(node, CLOSED_AFTER_MISSES, end);
  return task;
}

test("a reply to the peer's closed intercom session itself resumes that session (issue #389)", async (t) => {
  const node = closedNode(t);
  const intercom = await endedIntercom(node);
  const reply = deliver(node, { toSession: intercom.sessionId, inReplyTo: ORIGINAL });
  await deliverToClosed(node.deps());
  const runs = claudeRuns(node);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].args.slice(0, 2), ["--resume", intercom.sessionId]);
  const record = getMessage(node.paths.inbox, reply)!;
  assert.equal(record.toSession, intercom.sessionId);
  assert.deepEqual(record.delivery, { taskId: intercom.taskId, runtime: "claude", sessionId: intercom.sessionId });
});

test("a reply whose intercom session cannot be resumed starts a new intercom session, as any message (issue #389)", async (t) => {
  const node = closedNode(t);
  const intercom = await endedIntercom(node);
  const reply = deliver(node, { toSession: intercom.sessionId, inReplyTo: ORIGINAL });
  const base = node.deps();
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] !== "--resume") return base.exec!(file, args, options);
    node.calls.push({ file, args, options });
    throw new Error("No conversation found with session ID");
  };
  await deliverToClosed({ ...base, exec });
  assert.deepEqual(claudeRuns(node).map((c) => c.args[0]), ["--bg", "--resume", "--bg"]);
  const fresh = listTasks(node.paths).find((t) => t.taskId !== intercom.taskId)!;
  assert.equal(fresh.local, "intercom");
  const record = getMessage(node.paths.inbox, reply)!;
  assert.deepEqual([record.closedTo, record.delivery?.taskId], [intercom.sessionId, fresh.taskId]);
  assert.match(String(audits(node).at(-1)!.reason), /^intercom session not resumed: /);
});

test("msg status lists forwarded destination and delivery identity only for a handed-over reply (issue #389)", async (t) => {
  const node = closedNode(t);
  deliver(node);
  await deliverToClosed(node.deps());
  const [intercom] = listTasks(node.paths);
  const handed = deliver(node, { inReplyTo: ORIGINAL });
  const record = getMessage(node.paths.inbox, handed)!;
  writeJsonAtomic(path.join(node.paths.inbox, `${handed}.json`), { ...record, toSession: intercom.sessionId, closedTo: SESSION,
    closedAttempt: new Date(T0).toISOString(), delivery: { taskId: intercom.taskId, runtime: "claude", sessionId: intercom.sessionId } });
  const sent: SentRecord = { messageId: ORIGINAL, fromSession: SESSION, to: PEER, state: "replied", updatedAt: new Date(T0).toISOString() };
  assert.deepEqual(replyLines(node.paths, sent).slice(1), [
    `    forwarded to: session ${intercom.sessionId}`,
    `    delivery task: ${intercom.taskId}`,
    `    delivery session: ${intercom.sessionId}`,
  ]);
  // A reply that reached the sender itself keeps the single line.
  const direct = deliver(node, { inReplyTo: ORIGINAL });
  assert.equal(replyLines(node.paths, sent).filter((l) => l.includes(direct)).length, 1);
  assert.equal(replyLines(node.paths, sent).length, 5);
});
