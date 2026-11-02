import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { senderState } from "../protocol-messages.mts";
import { takeTurn, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import { codexNode, THREAD, waitFor } from "./codex-fixture.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { observeCodexTaskProgress } from "./delivery-progress.mts";
import { getMessage, getMessageProgress, markClosedAttempt, setMessageProgress, storeMessage } from "./inbox.mts";
import { taskId, taskNode, T0 } from "./task-fixture.mts";
import { writeTask, type TaskRecord } from "./task-records.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";

// Issue #197: a message for a Codex task session never waits without a
// reason. Busy, operator-stopped, guarded, failed and running targets each
// report a fixed progress code that the sender reads as accepted, stopped or
// running.

const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };
const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };

type Node = ReturnType<typeof taskNode>;

function task(node: Node, change: Partial<TaskRecord> = {}, n = 1): TaskRecord {
  const id = taskId(2000 + n);
  return writeTask(node.paths, { taskId: id, name: `task-${id.slice(0, 8)}`, sessionId: `0199a000-0000-7000-8000-00000000000${n}`,
    runtime: "codex", state: "done", permissionMode: "auto", cwd: node.workspace, startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString(), ...change }, T0);
}

function message(node: Node, toSession: string, extra: { taskId?: string; depth?: number } = {}): string {
  const messageId = crypto.randomUUID();
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession, text: "synthetic peer message", createdAt: new Date(T0).toISOString(),
    ...(extra.taskId ? { taskId: extra.taskId } : {}) }, T0, extra.depth ?? 0);
  return messageId;
}

const code = (node: Node, id: string): string | undefined => getMessageProgress(node.paths.inbox, id)?.code;

test("a busy or operator-stopped Codex task explains its waiting messages without reading the inbox otherwise", (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const quiet = task(node, {}, 1);
  const busy = task(node, { state: "running" }, 2);
  const resuming = task(node, { running: true }, 3);
  const stopped = task(node, { operatorStoppedAt: new Date(T0).toISOString() }, 4);
  const ids = {
    quiet: message(node, quiet.name, { taskId: quiet.taskId }),
    busy: message(node, busy.sessionId!, { taskId: busy.taskId }),
    resuming: message(node, resuming.name, { taskId: resuming.taskId }),
    stopped: message(node, stopped.sessionId!, { taskId: stopped.taskId }),
    handedOver: message(node, "closed-session"),
  };
  // A message closed-session delivery handed to the running intercom keeps its fallback progress.
  markClosedAttempt(node.paths.inbox, ids.handedOver, T0, busy.sessionId);
  setMessageProgress(node.paths.inbox, ids.handedOver, "fallback", "fallback-running", T0);

  observeCodexTaskProgress(node.deps());
  assert.equal(code(node, ids.quiet), undefined, "an ended task is left to the wake path");
  assert.equal(code(node, ids.busy), "target-busy");
  assert.equal(code(node, ids.resuming), "target-busy");
  assert.equal(code(node, ids.stopped), "operator-stopped");
  assert.equal(code(node, ids.handedOver), "fallback-running");
  assert.equal(senderState("accepted", getMessageProgress(node.paths.inbox, ids.stopped)), "stopped");

  // No held task: no inbox read at all.
  fs.rmSync(node.paths.tasks, { recursive: true, force: true });
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    assert.notEqual(args[0], node.paths.inbox, "no inbox read without a busy or stopped Codex task");
    return readdir(...args);
  });
  observeCodexTaskProgress(node.deps());
});

test("each wake guard of an ended Codex task leaves a reason on its waiting messages", async (t) => {
  const node = taskNode(t, { runtimes: ["codex"] });
  const ended = task(node);
  const target = { runtime: "codex", sessionId: ended.sessionId! };
  const refresh = () => { const now = node.deps().now!();
    publishSynthetic(node.paths, [fixtureEvidence(target, "idle-loaded", now)], now,
      [{ ...target, state: "idle-loaded" }], node.livenessAuthority); };
  refresh();
  const deps = () => ({ ...node.deps(), codex: { findCodex: () => null } });
  const unlisted = message(node, ended.name);
  const deep = message(node, ended.name, { taskId: ended.taskId, depth: 6 });
  const granted = message(node, ended.name, { taskId: ended.taskId });
  fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "");
  await pollCodexInbound(deps());
  assert.equal(code(node, unlisted), "wake-not-authorized");
  assert.equal(code(node, deep), "reply-limit");
  assert.equal(code(node, granted), "wake-disabled");
  fs.rmSync(path.join(node.paths.dir, "wake.disabled"));

  for (let n = 0; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(node.paths, ended.sessionId!, T0 - 50 * 60_000 + n * TURN_SPACING_MS * 2), "ok");
  await pollCodexInbound(deps());
  assert.equal(code(node, granted), "budget-exhausted");
  node.tick(2 * 60 * 60_000);
  refresh();

  // The resume cannot start a process: failed, and offered again later.
  await pollCodexInbound(deps());
  assert.equal(getMessageProgress(node.paths.inbox, granted)?.phase, "failed");
  assert.equal(code(node, granted), "wake-failed");
  assert.equal(getMessage(node.paths.inbox, granted)?.retry, true);
});

test("a resumed Codex task run reads as running until its turn confirms delivery", posix, async (t) => {
  const node = codexNode(t);
  const ended = writeTask(node.paths, { taskId: taskId(3001), name: "task-00000bb9", sessionId: THREAD, runtime: "codex", state: "done",
    permissionMode: "auto", cwd: node.workspace, startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString() }, T0);
  const carried = message(node, ended.name, { taskId: ended.taskId });
  const target = { runtime: "codex", sessionId: THREAD };
  publishSynthetic(node.paths, [fixtureEvidence(target, "idle-loaded", T0)], T0,
    [{ ...target, state: "idle-loaded" }], node.livenessAuthority);
  // [sleep] keeps the fake run alive, so a second message finds the task busy.
  fs.writeFileSync(path.join(node.paths.inbox, `${carried}.json`), JSON.stringify({
    ...getMessage(node.paths.inbox, carried), text: "take your time [sleep]" }));
  await pollCodexInbound(node.deps());
  await waitFor(() => node.runs().length === 1, "the message run");
  assert.equal(getMessage(node.paths.inbox, carried)?.state, "offered");
  assert.equal(code(node, carried), "awaiting-turn-confirmation");
  assert.equal(senderState("accepted", getMessageProgress(node.paths.inbox, carried)), "running");

  const waiting = message(node, ended.name, { taskId: ended.taskId });
  observeCodexTaskProgress(node.deps());
  assert.equal(code(node, waiting), "target-busy");
  assert.equal(code(node, carried), "awaiting-turn-confirmation", "the carried message keeps running");
});
