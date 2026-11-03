import { watchInboxReads } from "./inbox-read-fixture.mts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir } from "./autonomy.mts";
import { codexNode } from "./codex-fixture.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { codexSessionName, legacyCodexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, getMessageProgress, storeMessage, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { taskId, T0 } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";

const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" };
const OWNERS = Array.from({ length: 8 }, (_, n) => `01a0db0${n}-0000-7000-8000-00000000000${n}`);

function queueNode(t: test.TestContext) {
  const node = codexNode(t, {}, { findCodex: () => null }); // Native admission has separate targeted-read tests.
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, unknown>;
  policy.wake = { enabled: true, sessions: ["*"] };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  return node;
}

function message(node: ReturnType<typeof queueNode>, toSession: string, now = T0, depth = 0,
  messageId = crypto.randomUUID()): string {
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession,
    text: "synthetic peer message", createdAt: new Date(now).toISOString() }, now, depth);
  return messageId;
}

const queues = (node: ReturnType<typeof queueNode>) => {
  assert.deepEqual(node.runs(), [], "CP admission launches no native process");
  return node.runs();
};
const hints = (node: ReturnType<typeof queueNode>): string[] => fs.readdirSync(listenerDir(node.paths))
  .filter((file) => file.endsWith(".busy-hint.json"))
  .map((file) => JSON.parse(fs.readFileSync(path.join(listenerDir(node.paths), file), "utf8")).owner);

function actions(node: ReturnType<typeof queueNode>): { action: string; messageIds: string[] }[] {
  const file = path.join(node.paths.dir, "wake.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function countInboxScans(t: test.TestContext, inbox: string): () => number {
  const readdir = fs.readdirSync;
  let scans = 0;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (path.resolve(String(args[0])) === path.resolve(inbox)) scans++;
    return readdir(...args);
  });
  return () => scans;
}

test("a multi-owner queue round without targets takes one full Inbox snapshot", async (t) => {
  const node = queueNode(t);
  for (const owner of OWNERS) recordCodexSession(node.paths, owner, node.workspace, T0, "default");
  const taskOwner = "01a0db09-0000-7000-8000-000000000009";
  recordCodexSession(node.paths, taskOwner, node.workspace, T0, "default");
  writeTask(node.paths, { taskId: taskId(371), runtime: "codex", name: "task-synthetic", cwd: node.workspace,
    permissionMode: "auto", state: "done", startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString(), sessionId: taskOwner });
  for (let n = 0; n < 40; n++) message(node, `unrelated-${n}`);
  const scans = countInboxScans(t, node.paths.inbox);

  pollCodexQueue(node.deps());
  await codexQueueIdle();

  assert.equal(scans(), 1, "one round-local Inbox snapshot, independent of owner count");
  assert.deepEqual(node.runs().filter((run) => run.argv[0] === "queue"), []);
});

test("multiple admitted owners reread no unrelated message body after the round snapshot", async (t) => {
  const node = queueNode(t);
  const owners = OWNERS.slice(0, 3);
  for (const owner of owners) {
    recordCodexSession(node.paths, owner, node.workspace, T0, "default");
    message(node, owner);
  }
  const unrelated = Array.from({ length: 20 }, (_, n) => message(node, `unrelated-${n}`));
  const reads = new Map(unrelated.map((id) => [path.join(node.paths.inbox, `${id}.json`), 0]));
  const intercepted = watchInboxReads(t, file => reads.has(file), { after: file => reads.set(file, reads.get(file)! + 1) });

  pollCodexQueue(node.deps());
  await codexQueueIdle();

  assert.deepEqual([...reads.values()], Array(20).fill(1), "filename cleanup must not reparse unrelated records");
  assert.deepEqual(queues(node), []);
  assert.deepEqual(hints(node).sort(), [...owners].sort());
  intercepted.restore();
  pollCodexQueue(node.deps());
  await codexQueueIdle();
  assert.equal(hints(node).length, owners.length, "pending CP hints are not published twice");
});

test("a round without an eligible plain Codex owner does not read an Inbox record snapshot", async (t) => {
  const node = queueNode(t);
  message(node, "unrelated");
  const recordReads = watchInboxReads(t, node.paths.inbox).reads;

  pollCodexQueue(node.deps());
  await codexQueueIdle();

  assert.equal(recordReads(), 0, "filename-only note cleanup may still run");
});

test("full ids and aliases route oldest first while an ambiguous alias and task owner stay excluded", async (t) => {
  const node = queueNode(t);
  const a = "01a0db01-0000-7000-8000-00000000aaaa";
  const b = "01a0db01-1111-7000-8000-00000000bbbb";
  recordCodexSession(node.paths, a, node.workspace, T0, "default");
  recordCodexSession(node.paths, b, node.workspace, T0, "default");
  writeLocalSessions(node.paths, [a, b].map((sessionId) => ({
    sessionId, runtime: "codex", state: "active", name: codexSessionName(sessionId),
  })), T0);
  const oldest = message(node, a, T0);
  const newer = message(node, codexSessionName(a), T0 + 1);
  const toB = message(node, codexSessionName(b), T0 + 2);
  const ambiguous = message(node, legacyCodexSessionName(a), T0 + 3);

  pollCodexQueue(node.deps());
  await codexQueueIdle();

  assert.deepEqual(queues(node), []);
  assert.deepEqual(hints(node).sort(), [a, b].sort());
  assert.deepEqual(actions(node).filter((entry) => entry.action === "wake")
    .map((entry) => entry.messageIds), [[oldest, newer], [toB]]);
  assert.equal(getMessageProgress(node.paths.inbox, ambiguous)?.code, "ambiguous-target");
  for (const id of [oldest, newer, toB, ambiguous]) assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
});

test("equal receivedAt values keep their snapshot order across a full id and alias", async (t) => {
  const node = queueNode(t);
  const owner = OWNERS[0];
  recordCodexSession(node.paths, owner, node.workspace, T0, "default");
  writeLocalSessions(node.paths, [{ sessionId: owner, runtime: "codex", state: "active", name: codexSessionName(owner) }], T0);
  const aliasFirst = message(node, codexSessionName(owner), T0, 0, "00000000-0000-4000-8000-000000000001");
  const fullSecond = message(node, owner, T0, 0, "ffffffff-ffff-4fff-8fff-ffffffffffff");

  pollCodexQueue(node.deps());
  await codexQueueIdle();

  assert.deepEqual(actions(node).filter((entry) => entry.action === "wake")
    .map((entry) => entry.messageIds), [[aliasFirst, fullSecond]]);
});

test("targeted refresh rejects records changed after the routing snapshot and uses current depth", async (t) => {
  const node = queueNode(t);
  const owner = OWNERS[0];
  recordCodexSession(node.paths, owner, node.workspace, T0, "default");
  const delivered = message(node, owner, T0);
  const deleted = message(node, owner, T0 + 1);
  const readdressed = message(node, owner, T0 + 2);
  const deep = message(node, owner, T0 + 3);
  const transitions = new Map<string, () => void>([
    [delivered, () => rewrite(delivered, { state: "delivered" })],
    [deleted, () => fs.rmSync(file(deleted))],
    [readdressed, () => rewrite(readdressed, { toSession: "different-owner" })],
    [deep, () => rewrite(deep, { depth: 6 })],
  ]);
  watchInboxReads(t, node.paths.inbox, { after: selected => {
    const id = path.basename(selected, ".json"), transition = transitions.get(id);
    if (transition) { transitions.delete(id); transition(); }
  } });
  function file(id: string): string { return path.join(node.paths.inbox, `${id}.json`); }
  function rewrite(id: string, patch: Partial<InboxRecord>): void {
    writeJsonAtomic(file(id), { ...getMessage(node.paths.inbox, id), ...patch });
  }

  pollCodexQueue(node.deps());
  await codexQueueIdle();

  assert.deepEqual(queues(node), []);
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${owner}.busy-hint.json`)), false);
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${owner}.busy-admission.json`)), false);
  assert.equal(getMessage(node.paths.inbox, delivered)?.state, "delivered");
  assert.equal(getMessage(node.paths.inbox, deleted), null);
  assert.equal(getMessage(node.paths.inbox, readdressed)?.toSession, "different-owner");
  assert.deepEqual(actions(node).filter((entry) => entry.action === "depth-limit").map((entry) => entry.messageIds), [[deep]]);
});

test("a message arriving after the snapshot waits for the next CP admission round", async (t) => {
  const node = queueNode(t);
  const owner = OWNERS[0];
  recordCodexSession(node.paths, owner, node.workspace, T0, "default");
  const unrelated = message(node, "unrelated", T0);
  const unrelatedFile = path.join(node.paths.inbox, `${unrelated}.json`);
  let arrived: string | undefined, injected = false;
  const intercepted = watchInboxReads(t, candidate => candidate === unrelatedFile, { after: () => {
    if (!injected) { injected = true; arrived = message(node, owner, T0 + 1); }
  } });

  pollCodexQueue(node.deps());
  await codexQueueIdle();
  intercepted.restore();

  assert.ok(arrived);
  assert.deepEqual(queues(node), [], "the captured round cannot see a later arrival");
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${owner}.busy-hint.json`)), false);
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${owner}.busy-admission.json`)), false);
  pollCodexQueue(node.deps());
  await codexQueueIdle();
  assert.deepEqual(queues(node), []);
  assert.deepEqual(hints(node), [owner]);
  assert.equal(getMessage(node.paths.inbox, arrived)?.state, "accepted");
});

test("an Inbox snapshot failure logs once and fails the queue round closed", async (t) => {
  const node = queueNode(t);
  for (const owner of OWNERS.slice(0, 3)) recordCodexSession(node.paths, owner, node.workspace, T0, "default");
  const id = message(node, "unrelated");
  const failingFile = path.join(node.paths.inbox, `${id}.json`);
  watchInboxReads(t, candidate => candidate === failingFile, { fault: () => true });
  const lines: string[] = [];

  pollCodexQueue(node.deps(), (line) => lines.push(line));
  await codexQueueIdle();

  assert.deepEqual(queues(node), []);
  assert.deepEqual(lines, ["kherep-node: could not scan Codex Inbox: unreadable"]);
});
