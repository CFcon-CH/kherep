import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { wakeAudit } from "./autonomy.mts";
import { note, pollCodexInbound, pruneNoted } from "./codex-wake.mts";
import { messageIds, storeMessage, type InboxRecord } from "./inbox.mts";
import { watchInboxReads } from "./inbox-read-fixture.mts";
import { fixture } from "./inbox-storage-fixture.mts";
import { taskId, taskNode, T0 } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";

// Issue #1012: pruneNoted takes the ids of an inbox read the caller already
// did, so the exchange round does not list the inbox again for it. The audit
// memory is module-global; this file owns it, and every test uses its own ids.

const SESSION = "ended-0";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" };
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const audited = (paths: { dir: string }): string[][] => fs.existsSync(wakeAudit(paths as never))
  ? fs.readFileSync(wakeAudit(paths as never), "utf8").trim().split("\n").map((line) => JSON.parse(line).messageIds) : [];
const record = (messageId: string): InboxRecord => ({ messageId, from: PEER, toSession: "synthetic-target", text: "synthetic",
  createdAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), state: "delivered", depth: 0 });

// An inbox path that is a file: listing it throws, so a passing call did not list it.
function unlistable(root: string): string {
  const file = path.join(root, "not-an-inbox");
  fs.writeFileSync(file, "synthetic");
  assert.throws(() => messageIds(file));
  return file;
}

test("1012: with an id list pruneNoted forgets an absent noted id, keeps a present one and does not list the inbox", (t) => {
  const node = taskNode(t);
  const paths = { ...node.paths, inbox: unlistable(node.paths.dir) };
  const [absent, present] = [id(1), id(2)];
  note(paths, T0, SESSION, [absent, present], "disabled");
  pruneNoted(paths, [present]);
  note(paths, T0, SESSION, [absent, present], "disabled");
  assert.deepEqual(audited(paths), [[absent, present], [absent]], "only the forgotten id is audited again");
});

test("1012: without an id list pruneNoted lists the inbox as before, bound records included", (t) => {
  const f = fixture(t);
  storeMessage(f.paths.inbox, f.body);
  assert.ok(fs.existsSync(f.bound), "the fixture stores a bound record");
  const absent = id(11);
  note(f.paths, T0, SESSION, [f.body.messageId, absent], "disabled");
  const reads = watchInboxReads(t, f.paths.inbox);
  pruneNoted(f.paths);
  assert.ok(reads.reads() > 0, "the listing validates the bound record");
  reads.restore();
  note(f.paths, T0, SESSION, [f.body.messageId, absent], "disabled");
  assert.deepEqual(audited(f.paths), [[f.body.messageId, absent], [absent]]);
});

function endedTask(t: test.TestContext) {
  const node = taskNode(t, { runtimes: ["codex"] });
  const task = taskId(1012);
  writeTask(node.paths, { taskId: task, name: `task-${task.slice(0, 8)}`, sessionId: SESSION, runtime: "codex", state: "done",
    permissionMode: "auto", cwd: node.workspace, startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString() }, T0);
  return node;
}

test("1012: pollCodexInbound prunes with the ids of its routing read and does not list the inbox", async (t) => {
  const node = endedTask(t);
  const [absent, present] = [id(21), id(22)];
  const paths = { ...node.paths, inbox: unlistable(node.paths.dir) };
  note(paths, T0, SESSION, [absent, present], "disabled");
  const logs: string[] = [];
  await pollCodexInbound({ ...node.deps(), paths, inbox: () => [record(present)] }, (line) => logs.push(line));
  assert.deepEqual(logs, [], "the routing read succeeded");
  note(paths, T0, SESSION, [absent, present], "disabled");
  assert.deepEqual(audited(paths), [[absent, present], [absent]]);
});

test("1012: after a failed routing read pollCodexInbound prunes from the inbox listing, as before", async (t) => {
  const node = endedTask(t);
  const [absent, present] = [id(31), id(32)];
  storeMessage(node.paths.inbox, { messageId: present, from: PEER, toSession: "synthetic-target", text: "synthetic",
    createdAt: new Date(T0).toISOString() }, T0);
  note(node.paths, T0, SESSION, [absent, present], "disabled");
  const logs: string[] = [];
  await pollCodexInbound({ ...node.deps(), inbox: () => { throw new Error("synthetic index fault"); } }, (line) => logs.push(line));
  assert.ok(logs.some((line) => line.startsWith("kherep-node: could not read inbox for Codex task routing:")), logs.join("\n"));
  note(node.paths, T0, SESSION, [absent, present], "disabled");
  assert.deepEqual(audited(node.paths), [[absent, present], [absent]]);
});
