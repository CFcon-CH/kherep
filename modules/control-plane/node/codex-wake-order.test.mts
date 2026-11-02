import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import type { CodexDeps } from "./codex-process.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { getMessage, getMessageProgress, storeMessage } from "./inbox.mts";
import type { Readiness, Verdict } from "./runtime-readiness.mts";
import { taskId, taskNode, T0 } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";

// Issue #473: the start-time read of an ended task's previous run is a child
// process, so a round reads it only after the guards that need no process:
// the task limit and the working directory. It stays before the readiness
// verdict and the turn budget, so a run still ending keeps its messages
// waiting as target-busy and is never refused or charged a turn meanwhile.

const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };
const SESSION = "0199a000-0000-7000-8000-000000000473";
const PID = 47_301;
const START = "previous-run-start";

type Node = ReturnType<typeof taskNode>;

function setup(t: test.TestContext, sessions: Record<string, unknown> = {}, cwd?: (node: Node) => string) {
  const node = taskNode(t, { runtimes: ["codex"], ...sessions });
  const record = writeTask(node.paths, { taskId: taskId(4730), name: "task-4730", sessionId: SESSION, runtime: "codex",
    state: "done", permissionMode: "auto", cwd: cwd ? cwd(node) : node.workspace, pid: PID, pidStart: START,
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString() }, T0);
  const messageId = crypto.randomUUID();
  const target = { runtime: "codex", sessionId: SESSION };
  publishSynthetic(node.paths, [fixtureEvidence(target, "idle-loaded", T0)], T0,
    [{ ...target, state: "idle-loaded" }], node.livenessAuthority);
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: record.name, text: "synthetic peer message",
    createdAt: new Date(T0).toISOString(), taskId: record.taskId }, T0, 0);
  const order: string[] = [];
  const poll = async (options: { running?: boolean; verdict?: Verdict | null } = {}): Promise<string[]> => {
    const codex: CodexDeps = {
      processStart: async (pid) => { order.push("read"); return pid === PID && options.running ? START : null; },
      findCodex: () => { order.push("resume"); return null; },
    };
    const readiness = options.verdict === undefined ? undefined
      : { peek: () => options.verdict ?? null } as unknown as Readiness;
    await pollCodexInbound({ ...node.deps(), codex, ...(readiness ? { readiness } : {}) });
    const progress = getMessageProgress(node.paths.inbox, messageId);
    return [progress?.phase ?? "none", progress?.code ?? "none", getMessage(node.paths.inbox, messageId)?.state ?? "none"];
  };
  return { node, order, poll };
}

test("a round at the task limit reads no process start and keeps the messages waiting", async (t) => {
  const { node, order, poll } = setup(t, { maxConcurrent: 1 });
  writeTask(node.paths, { taskId: taskId(4731), name: "task-4731", runtime: "codex", state: "running", permissionMode: "auto",
    cwd: node.workspace, startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString() }, T0);
  assert.deepEqual(await poll(), ["waiting", "retry-pending", "accepted"]);
  assert.deepEqual(order, []);
});

test("a refused working directory reads no process start", async (t) => {
  const { order, poll } = setup(t, {}, (node) => path.join(node.workspace, "gone"));
  assert.deepEqual(await poll(), ["waiting", "wake-not-authorized", "accepted"]);
  assert.deepEqual(order, []);
});

test("a previous run still ending keeps target-busy ahead of a pending or refusing readiness verdict", async (t) => {
  const { order, poll } = setup(t);
  assert.deepEqual(await poll({ running: true, verdict: null }), ["waiting", "target-busy", "accepted"]);
  assert.deepEqual(await poll({ running: true, verdict: { ready: false, at: T0, cause: "sign-in" } }),
    ["waiting", "target-busy", "accepted"], "not refused while the previous run still ends");
  assert.deepEqual(order, ["read", "read"]);
});

test("an ended previous run is read once before the readiness verdict and once before the resume", async (t) => {
  const pending = setup(t);
  assert.deepEqual(await pending.poll({ verdict: null }), ["waiting", "retry-pending", "accepted"]);
  assert.deepEqual(pending.order, ["read"]);
  const ready = setup(t);
  assert.deepEqual(await ready.poll(), ["failed", "wake-failed", "offered"]);
  assert.deepEqual(ready.order, ["read", "resume"]);
});
