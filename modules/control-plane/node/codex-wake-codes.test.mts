import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import { takeTurn } from "./autonomy.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { getMessage, getMessageProgress, storeMessage } from "./inbox.mts";
import { taskId, taskNode, T0 } from "./task-fixture.mts";
import { writeTask, type TaskRecord } from "./task-records.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";

// Issue #239: a working directory the policy refuses holds the resume of an
// ended Codex task as a policy decision, with the code closed-session delivery
// uses for it (issue #230). wake-failed stays for a resume that failed.

const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };
const SESSION = "0199a000-0000-7000-8000-000000000239";

type Node = ReturnType<typeof taskNode>;

function endedTask(node: Node, cwd: string): TaskRecord {
  const id = taskId(2390);
  return writeTask(node.paths, { taskId: id, name: `task-${id.slice(0, 8)}`, sessionId: SESSION, runtime: "codex", state: "done",
    permissionMode: "auto", cwd, startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString() }, T0);
}

function message(node: Node, record: TaskRecord): string {
  const messageId = crypto.randomUUID();
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: record.name, text: "synthetic peer message",
    createdAt: new Date(T0).toISOString(), taskId: record.taskId }, T0, 0);
  return messageId;
}

async function poll(node: Node, cwd: (node: Node) => string): Promise<{ id: string; lines: string[] }> {
  const id = message(node, endedTask(node, cwd(node)));
  const target = { runtime: "codex", sessionId: SESSION };
  publishSynthetic(node.paths, [fixtureEvidence(target, "idle-loaded", T0)], T0,
    [{ ...target, state: "idle-loaded" }], node.livenessAuthority);
  const lines: string[] = [];
  // No codex binary: a resume that got past every guard fails to start.
  await pollCodexInbound({ ...node.deps(), codex: { findCodex: () => null } }, (line) => lines.push(line));
  return { id, lines };
}

const progress = (node: Node, id: string) => {
  const p = getMessageProgress(node.paths.inbox, id);
  return [p?.phase, p?.code];
};

const refusals: [what: string, cwd: (node: Node) => string, reason: RegExp][] = [
  ["a cwd outside the workspace roots", (node) => node.root, /cwd is outside the workspace roots of this node/],
  ["a cwd that does not exist", (node) => path.join(node.workspace, "gone"), /cwd does not exist on this node/],
  ["a relative cwd", () => "repo", /cwd must be an absolute path/],
];

for (const [what, cwd, reason] of refusals) {
  test(`a Codex task resume refused for ${what} waits with wake-not-authorized, not wake-failed`, async (t) => {
    const node = taskNode(t, { runtimes: ["codex"] });
    const { id, lines } = await poll(node, cwd);
    assert.deepEqual(progress(node, id), ["waiting", "wake-not-authorized"]);
    assert.match(lines.join("\n"), new RegExp(`not resuming task ${taskId(2390)} for messages: ${reason.source}`));
    const record = getMessage(node.paths.inbox, id);
    assert.deepEqual([record?.state, record?.offers, record?.retry], ["accepted", undefined, undefined], "not offered, tried again");
    assert.equal(takeTurn(node.paths, SESSION, T0), "ok", "the turn budget is untouched");
  });
}

test("a Codex task resume that fails to start still reports wake-failed", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const { id, lines } = await poll(node, (n) => n.workspace);
  assert.deepEqual(progress(node, id), ["failed", "wake-failed"]);
  assert.match(lines.join("\n"), /could not resume task .* codex is not installed on this node/);
  assert.equal(getMessage(node.paths.inbox, id)?.retry, true, "offered again later");
});
