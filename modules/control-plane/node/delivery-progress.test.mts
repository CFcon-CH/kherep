import assert from "node:assert/strict";
import test from "node:test";

import { listenerDir, listenerLock, listenerScope } from "./autonomy.mts";
import { codexNode } from "./codex-fixture.mts";
import { pollCodexQueue } from "./codex-queue.mts";
import { codexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { observeClaudeDeliveryProgress } from "./delivery-progress.mts";
import { recordSent, writeOutbox } from "./exchange.mts";
import { getMessageProgress, markOffered, markReported, storeMessage, unreportedStatuses, writeJsonAtomic } from "./inbox.mts";
import { T0, taskNode, TASK } from "./task-fixture.mts";
import { ensureDir } from "./config.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";
import type { SessionInfo } from "../protocol.mts";
import type { NodePaths } from "./config.mts";
import { writeRequest, writeTask } from "./task-records.mts";

const SESSION = "8e1f0000-0000-4000-8000-000000000001";
const SESSION_TWO = "8e1f0000-0000-4000-8000-000000000002";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" };
let sequence = 0;
// Positive progress cases explicitly supply fresh generated source facts.
function writeLocalSessions(paths: NodePaths, rows: SessionInfo[], now: number): void {
  const normalized = rows.map(row => ({ ...row, state: row.state === "idle" ? "idle-loaded" : row.state === "working" ? "running" : row.state }));
  publishSynthetic(paths, normalized.map(row => fixtureEvidence(row,
    row.state === "idle-loaded" || row.state === "running" ? row.state : "unknown", now)), now, normalized);
}
const id = (): string => `d138${(++sequence).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;

function deliver(node: ReturnType<typeof taskNode>, state = "idle", taskId?: string): string {
  writeLocalSessions(node.paths, [{ sessionId: SESSION, runtime: "claude-code", state, name: "review" }], T0);
  const messageId = id();
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: "review", text: "private",
    createdAt: new Date(T0).toISOString(), ...(taskId ? { taskId } : {}) }, T0);
  return messageId;
}

const code = (node: ReturnType<typeof taskNode>, messageId: string): string | undefined =>
  getMessageProgress(node.paths.inbox, messageId)?.code;

test("normalized loaded-idle progress preserves policy vetoes; UNKNOWN never reports a wake", (t) => {
  t.mock.method(Date, "now", () => T0);
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: ["another-session"] } });
  const messageId = deliver(node);
  const target = { sessionId: SESSION, runtime: "claude-code" };
  publishSynthetic(node.paths, [{ ...target,
    holder: { status: "value", value: { present: true, creationIdentity: "synthetic-owner" }, source: "native-holder", complete: true, observedAt: T0, reasonCode: "observed" },
    loaded: { status: "value", value: true, source: "native-app", complete: true, observedAt: T0, reasonCode: "observed" },
    turn: { status: "value", value: "idle", source: "native-turn", complete: true, observedAt: T0, reasonCode: "observed" },
  }], T0, [{ ...target, name: "review", state: "idle-loaded" }]);
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "wake-not-authorized");
  publishSynthetic(node.paths, [target], T0, [{ ...target, name: "review", state: "unknown" }]);
  observeClaudeDeliveryProgress(node.deps());
  assert.notEqual(code(node, messageId), "wake-pending");
});

test("an idle listed Claude session excluded by wake policy reports the next user turn", (t) => {
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: ["another-session"] } });
  const messageId = deliver(node);
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "wake-not-authorized");
});

test("Claude progress distinguishes busy, offered, and task-granted sessions", (t) => {
  const busy = taskNode(t, {}, { wake: { enabled: true, sessions: ["another-session"] } });
  const busyId = deliver(busy, "working");
  observeClaudeDeliveryProgress(busy.deps());
  assert.equal(code(busy, busyId), "target-busy");

  const offered = taskNode(t, {}, { wake: { enabled: true, sessions: ["another-session"] } });
  const offeredId = deliver(offered);
  markOffered(offered.paths.inbox, offeredId, T0);
  observeClaudeDeliveryProgress(offered.deps());
  assert.equal(code(offered, offeredId), "awaiting-turn-confirmation");

  const granted = taskNode(t);
  writeTask(granted.paths, { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: granted.workspace,
    permissionMode: "auto", state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), sessionId: SESSION }, T0);
  const grantedId = deliver(granted, "idle", TASK);
  observeClaudeDeliveryProgress(granted.deps());
  assert.equal(code(granted, grantedId), "awaiting-user-turn", "a task grant is authorized even without wake policy");
});
test("only a live bounded Claude listener is reported as wake-pending", (t) => {
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: [SESSION] } });
  const messageId = deliver(node);
  ensureDir(listenerDir(node.paths));
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "stale", pid: 2147483647, startedAt: T0, event: "Stop" });
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "awaiting-user-turn", "a stale lock is not a live wake");
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "live", pid: process.pid, startedAt: T0, event: "Stop" });
  writeJsonAtomic(listenerScope(node.paths, SESSION), { token: "live", listed: true });
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "wake-pending");
});

// Issue #213: wake-pending only for what the live listener wakes for, as its
// scope file says (wake-hook.mts). An older listener writes none.
test("a live listener on its task grant alone is not reported as waking for a message outside the grant", (t) => {
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: ["*"] } });
  writeTask(node.paths, { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: node.workspace,
    permissionMode: "auto", state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), sessionId: SESSION }, T0);
  const other = deliver(node);
  const granted = deliver(node, "idle", TASK);
  ensureDir(listenerDir(node.paths));
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "live", pid: process.pid, startedAt: T0, event: "Stop" });
  const observe = (scope: unknown): string[] => {
    writeJsonAtomic(listenerScope(node.paths, SESSION), scope);
    observeClaudeDeliveryProgress(node.deps());
    return [code(node, other), code(node, granted)].map(String);
  };
  assert.deepEqual(observe({ token: "live", listed: false, taskId: TASK }), ["awaiting-user-turn", "wake-pending"]);
  assert.deepEqual(observe({ token: "live", listed: false }), ["awaiting-user-turn", "awaiting-user-turn"],
    "a listener still waiting for its grant covers neither");
  assert.deepEqual(observe({ token: "replaced", listed: true }), ["awaiting-user-turn", "wake-pending"],
    "a scope of another listener, or none, says nothing beyond the task grant");
  assert.deepEqual(observe({ token: "live", listed: true }), ["wake-pending", "wake-pending"]);
});

// Issue #253: with wake.replies a reply to the idle session's own recent
// message is authorized without a listing; wake-pending only while a live
// listener's scope says it wakes for replies. Other messages stay unauthorized.
test("a reply-granted message reports wake-pending with a reply-scoped listener, else the next user turn", (t) => {
  const node = taskNode(t, {}, { wake: { enabled: true, replies: true } });
  const original = id();
  writeOutbox(node.paths, { messageId: original, fromSession: "review", fromSessionId: SESSION, to: PEER, text: "question",
    createdAt: new Date(T0 - 60_000).toISOString(), depth: 0 });
  recordSent(node.paths, original, "accepted", undefined, T0);
  const unrelated = deliver(node);
  const reply = (from: typeof PEER): string => {
    const messageId = id();
    storeMessage(node.paths.inbox, { messageId, from, toSession: "review", text: "private", inReplyTo: original,
      createdAt: new Date(T0).toISOString() }, T0, 1);
    return messageId;
  };
  const granted = reply(PEER);
  const foreign = reply({ ...PEER, nodeId: "00000000-0000-4000-8000-0000000000dd" });
  const observe = (scope?: unknown): string[] => {
    if (scope !== undefined) {
      ensureDir(listenerDir(node.paths));
      writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "live", pid: process.pid, startedAt: T0, event: "Stop" });
      writeJsonAtomic(listenerScope(node.paths, SESSION), scope);
    }
    observeClaudeDeliveryProgress(node.deps());
    return [code(node, unrelated), code(node, foreign), code(node, granted)].map(String);
  };
  assert.deepEqual(observe(), ["wake-not-authorized", "wake-not-authorized", "awaiting-user-turn"], "no listener");
  assert.deepEqual(observe({ token: "live", listed: false }), ["wake-not-authorized", "wake-not-authorized", "awaiting-user-turn"],
    "a listener without the reply scope");
  assert.deepEqual(observe({ token: "live", listed: false, replies: true }), ["wake-not-authorized", "wake-not-authorized", "wake-pending"]);
});

// Issue #264: with wake.replies a message of a task the idle session requested,
// from the node that runs it, is authorized and reported like a reply grant.
test("a task-message-granted message reports wake-pending with a replies-scoped listener, else the next user turn", (t) => {
  const node = taskNode(t, {}, { wake: { enabled: true, replies: true } });
  writeRequest(node.paths, { requestId: id(), title: "intercom: claude@n", text: "question", requirements: { runtime: "claude", node: PEER.nodeId },
    directive: "Yes", requestedBy: "review", requestedBySessionId: SESSION, createdAt: new Date(T0 - 60_000).toISOString(),
    state: "dispatched", taskId: TASK, nodeId: PEER.nodeId });
  const unrelated = deliver(node);
  const granted = deliver(node, "idle", TASK);
  const foreign = id();
  storeMessage(node.paths.inbox, { messageId: foreign, from: { ...PEER, nodeId: "00000000-0000-4000-8000-0000000000dd" }, toSession: "review",
    text: "private", taskId: TASK, createdAt: new Date(T0).toISOString() }, T0);
  const observe = (scope?: unknown): string[] => {
    if (scope !== undefined) {
      ensureDir(listenerDir(node.paths));
      writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "live", pid: process.pid, startedAt: T0, event: "Stop" });
      writeJsonAtomic(listenerScope(node.paths, SESSION), scope);
    }
    observeClaudeDeliveryProgress(node.deps());
    return [code(node, unrelated), code(node, foreign), code(node, granted)].map(String);
  };
  assert.deepEqual(observe(), ["wake-not-authorized", "wake-not-authorized", "awaiting-user-turn"], "no listener");
  assert.deepEqual(observe({ token: "live", listed: false }), ["wake-not-authorized", "wake-not-authorized", "awaiting-user-turn"],
    "a listener without the reply scope");
  assert.deepEqual(observe({ token: "live", listed: false, replies: true }), ["wake-not-authorized", "wake-not-authorized", "wake-pending"]);
});

// Issue #266: the task message grant is covered by wake.replies; without it a
// task message to an unlisted session is not authorized.
test("a task message to an unlisted idle session stays wake-not-authorized without wake.replies", (t) => {
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: ["another-session"] } });
  writeRequest(node.paths, { requestId: id(), title: "intercom: claude@n", text: "question", requirements: { runtime: "claude", node: PEER.nodeId },
    directive: "Yes", requestedBy: "review", requestedBySessionId: SESSION, createdAt: new Date(T0 - 60_000).toISOString(),
    state: "dispatched", taskId: TASK, nodeId: PEER.nodeId });
  const messageId = deliver(node, "idle", TASK);
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "wake-not-authorized");
});

test("a task association grants no wake while sessions are disabled", (t) => {
  const node = taskNode(t, { enabled: false });
  writeTask(node.paths, { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: node.workspace,
    permissionMode: "auto", state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), sessionId: SESSION }, T0);
  const messageId = deliver(node, "idle", TASK);
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, messageId), "wake-disabled");
});

test("ambiguous Claude aliases stay stable across order and receipts, then resolve", (t) => {
  const node = taskNode(t);
  const sessions = [
    { sessionId: SESSION, runtime: "claude-code", state: "idle", name: "shared" },
    { sessionId: SESSION_TWO, runtime: "claude-code", state: "working", name: "shared" },
  ];
  writeLocalSessions(node.paths, sessions, T0);
  const accepted = id();
  const offered = id();
  for (const messageId of [accepted, offered]) {
    storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: "shared", text: "private",
      createdAt: new Date(T0).toISOString() }, T0);
  }
  markOffered(node.paths.inbox, offered, T0);

  observeClaudeDeliveryProgress(node.deps());
  const first = getMessageProgress(node.paths.inbox, accepted)!;
  const offeredFirst = getMessageProgress(node.paths.inbox, offered)!;
  assert.equal(first.code, "ambiguous-target");
  assert.equal(offeredFirst.code, "awaiting-turn-confirmation");
  markReported(node.paths.inbox, accepted, "accepted", "accepted", T0, first.observedAt);
  assert.deepEqual(unreportedStatuses(node.paths.inbox, T0).map((record) => record.messageId), [offered]);

  node.tick(2_000);
  writeLocalSessions(node.paths, [...sessions].reverse(), T0 + 2_000);
  observeClaudeDeliveryProgress(node.deps());
  assert.deepEqual(getMessageProgress(node.paths.inbox, accepted), first);
  assert.deepEqual(getMessageProgress(node.paths.inbox, offered), offeredFirst);
  assert.equal(unreportedStatuses(node.paths.inbox, T0 + 2_000).some((record) => record.messageId === accepted), false,
    "a covering receipt remains settled when the resolution is unchanged");

  node.tick(2_000);
  writeLocalSessions(node.paths, [sessions[0]], T0 + 4_000);
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(code(node, accepted), "wake-disabled");
  assert.deepEqual(getMessageProgress(node.paths.inbox, offered), offeredFirst,
    "an offered message keeps awaiting turn confirmation");
});

test("an exact Claude session id wins over another session's matching name", (t) => {
  const node = taskNode(t);
  const sessions = [
    { sessionId: "collision", runtime: "claude-code", state: "idle", name: "exact" },
    { sessionId: SESSION, runtime: "claude-code", state: "working", name: "collision" },
  ];
  writeLocalSessions(node.paths, [...sessions].reverse(), T0);
  const messageId = id();
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: "collision", text: "private",
    createdAt: new Date(T0).toISOString() }, T0);

  observeClaudeDeliveryProgress(node.deps());
  const first = getMessageProgress(node.paths.inbox, messageId)!;
  assert.equal(first.code, "wake-disabled");
  markReported(node.paths.inbox, messageId, "accepted", "accepted", T0, first.observedAt);

  node.tick(2_000);
  writeLocalSessions(node.paths, sessions, T0 + 2_000);
  observeClaudeDeliveryProgress(node.deps());
  assert.deepEqual(getMessageProgress(node.paths.inbox, messageId), first);
  assert.equal(unreportedStatuses(node.paths.inbox, T0 + 2_000).length, 0);
});

test("a Claude name cannot shadow an exact Codex id across observer and queue polls", (t) => {
  const node = codexNode(t);
  const codexId = "01a0db01-0000-7000-8000-00000000c0de";
  recordCodexSession(node.paths, codexId, node.workspace, T0, "default");
  const sessions = [
    { sessionId: SESSION, runtime: "claude-code", state: "working", name: codexId },
    { sessionId: codexId, runtime: "codex", state: "active", name: codexSessionName(codexId) },
  ];
  writeLocalSessions(node.paths, sessions, T0);
  const messageId = id();
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: codexId, text: "private",
    createdAt: new Date(T0).toISOString() }, T0);

  observeClaudeDeliveryProgress(node.deps());
  assert.equal(getMessageProgress(node.paths.inbox, messageId), null, "the exact non-Claude id owns the address");
  pollCodexQueue(node.deps());
  const first = getMessageProgress(node.paths.inbox, messageId)!;
  assert.equal(first.code, "wake-disabled");
  markReported(node.paths.inbox, messageId, "accepted", "accepted", T0, first.observedAt);

  node.tick(2_000);
  writeLocalSessions(node.paths, [...sessions].reverse(), T0 + 2_000);
  observeClaudeDeliveryProgress(node.deps());
  pollCodexQueue(node.deps());
  assert.deepEqual(getMessageProgress(node.paths.inbox, messageId), first);
  assert.equal(unreportedStatuses(node.paths.inbox, T0 + 2_000).length, 0);
  assert.equal(node.runs().length, 0);
});

test("a Claude and Codex shared name stays ambiguous across observer and queue polls", (t) => {
  const node = codexNode(t);
  const codexId = "01a0db01-0000-7000-8000-00000000f00d";
  const alias = codexSessionName(codexId);
  recordCodexSession(node.paths, codexId, node.workspace, T0, "default");
  const sessions = [
    { sessionId: SESSION, runtime: "claude-code", state: "idle", name: alias },
    { sessionId: codexId, runtime: "codex", state: "active", name: alias },
  ];
  writeLocalSessions(node.paths, sessions, T0);
  const messageId = id();
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: alias, text: "private",
    createdAt: new Date(T0).toISOString() }, T0);

  observeClaudeDeliveryProgress(node.deps());
  pollCodexQueue(node.deps());
  const first = getMessageProgress(node.paths.inbox, messageId)!;
  assert.equal(first.code, "ambiguous-target");
  markReported(node.paths.inbox, messageId, "accepted", "accepted", T0, first.observedAt);

  node.tick(2_000);
  writeLocalSessions(node.paths, [...sessions].reverse(), T0 + 2_000);
  observeClaudeDeliveryProgress(node.deps());
  pollCodexQueue(node.deps());
  assert.deepEqual(getMessageProgress(node.paths.inbox, messageId), first);
  assert.equal(unreportedStatuses(node.paths.inbox, T0 + 2_000).length, 0);
  assert.equal(node.runs().length, 0);
});
