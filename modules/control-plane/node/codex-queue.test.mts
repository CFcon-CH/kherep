import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, takeTurn, TURN_SPACING_MS } from "./autonomy.mts";
import { codexNode } from "./codex-fixture.mts";
import { codexQueueIdle, guardQueue, pollCodexQueue, queueArgs } from "./codex-queue.mts";
import { codexSessionName, legacyCodexSessionName, readCodexSession, recordCodexSession } from "./codex-sessions.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, getMessageProgress, markOffered, storeMessage } from "./inbox.mts";
import { T0, TASK } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";

// Authorized CP hint publication with the original admission guards.

const SID = "01a0db01-0000-7000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "claude-peer-session" };
let counter = 0;

type Node = ReturnType<typeof codexNode>;

// A node whose policy wakes the listed sessions, and one recorded Codex session.
function wakeNode(t: test.TestContext, wake: string[] | null = [SID], mode: string | null = "default", session = SID): Node {
  const node = codexNode(t, {}, { findCodex: () => null }); // Isolate CP hint behavior from the native producer.
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, unknown>;
  if (wake) policy.wake = { enabled: true, sessions: wake };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  recordCodexSession(node.paths, session, node.workspace, T0, mode ?? undefined);
  return node;
}

function deliver(node: Node, text: string, depth = 0, toSession = SID): string {
  const id = `9e57${(++counter).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;
  storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession, text, createdAt: new Date(T0).toISOString() }, T0, depth);
  return id;
}

// One exchange round, then the queue runs it handed to its lane.
async function poll(node: Node): Promise<void> {
  pollCodexQueue(node.deps());
  await codexQueueIdle();
}

const queues = (node: Node): string[][] => {
  assert.deepEqual(node.runs(), [], "CP publication starts no native process");
  return [];
};
const hints = (node: Node): number => fs.readdirSync(listenerDir(node.paths)).filter((file) => file.endsWith(".busy-hint.json")).length;
const generation = (node: Node, owner = SID): string => JSON.parse(fs.readFileSync(path.join(listenerDir(node.paths), `${owner}.busy-hint.json`), "utf8")).generation;
const actions = (node: Node): [string, string[]][] => {
  const file = path.join(node.paths.dir, "wake.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((l) => [l.action, l.messageIds]) : [];
};

test("an idle Codex session gets a CP hint; the message waits for original-owner intake", async (t) => {
  const node = wakeNode(t);
  const id = deliver(node, "secret peer text: deploy now");
  await poll(node);
  assert.deepEqual(queues(node), []);
  assert.equal(hints(node), 1);
  const all = JSON.stringify(node.runs());
  assert.ok(!all.includes("secret peer text") && !all.includes(PEER.session) && !all.includes(PEER.nodeId), "no peer text or names");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", "offered only by the hook in the woken turn");
  assert.deepEqual(actions(node), [["wake", [id]]]);
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "awaiting-user-turn");
  assert.ok(!fs.readFileSync(path.join(node.paths.dir, "wake.jsonl"), "utf8").includes("secret"), "the audit carries no text");
});

test("a second poll preserves progress while a CP hint waits for intake", async (t) => {
  const session = "5eec0001-0000-7000-8000-000000000002";
  const node = wakeNode(t, [session], "default", session);
  const id = deliver(node, "x", 0, session);
  const deps = node.deps({ findCodex: () => null, queueTimeoutMs: 2_000 });
  pollCodexQueue(deps);
  await codexQueueIdle();
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "awaiting-user-turn");
  pollCodexQueue(deps);
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "awaiting-user-turn");
  await codexQueueIdle();
});

test("one pending hint per session; accepted content can be admitted again later", async (t) => {
  const node = wakeNode(t);
  const first = deliver(node, "one");
  await poll(node);
  const initial = generation(node);
  const second = deliver(node, "two");
  node.tick(TURN_SPACING_MS + 1);
  await poll(node);
  assert.notEqual(generation(node), initial, "a newly accepted message gets its own hint without waiting for the older one");
  markOffered(node.paths.inbox, first, T0);
  await poll(node);
  const next = generation(node);
  assert.notEqual(next, initial, "the new message already has an admitted hint");
  // Never offered within 10 minutes (no hook): not queued again, it waits for the next prompt.
  node.tick(11 * 60_000);
  await poll(node);
  assert.notEqual(generation(node), next, "accepted messages need fresh authorized admission after ten minutes");
  assert.equal(getMessage(node.paths.inbox, second)?.state, "accepted");
  assert.equal(getMessageProgress(node.paths.inbox, second)?.code, "awaiting-user-turn");
});

test("the wake guards: opt-out, allowlist, kill switch, permission mode, reply depth", async (t) => {
  const off = wakeNode(t, null);
  deliver(off, "x");
  await poll(off);
  assert.deepEqual([queues(off), actions(off)], [[], []], "wake disabled: nothing, not even an audit line");

  const unlisted = wakeNode(t, ["someone-else"]);
  const a = deliver(unlisted, "x");
  const killed = wakeNode(t);
  fs.writeFileSync(path.join(killed.paths.dir, "wake.disabled"), "");
  const b = deliver(killed, "x");
  const bypass = wakeNode(t, ["*"], "bypassPermissions");
  const c = deliver(bypass, "x");
  const unknown = wakeNode(t, ["*"], null);
  const d = deliver(unknown, "x");
  const deep = wakeNode(t);
  const e = deliver(deep, "x", 6);
  for (const node of [unlisted, killed, bypass, unknown, deep]) await poll(node);
  for (const [n, node] of [unlisted, killed, bypass, unknown, deep].entries()) assert.deepEqual(queues(node), [], String(n));
  assert.deepEqual([getMessageProgress(unlisted.paths.inbox, a)?.code, getMessageProgress(killed.paths.inbox, b)?.code,
    getMessageProgress(bypass.paths.inbox, c)?.code, getMessageProgress(unknown.paths.inbox, d)?.code,
    getMessageProgress(deep.paths.inbox, e)?.code],
  ["wake-not-authorized", "wake-disabled", "permission-restricted", "permission-restricted", "reply-limit"]);
  assert.deepEqual([actions(unlisted), actions(killed), actions(bypass), actions(unknown), actions(deep)],
    [[["not-allowlisted", [a]]], [["disabled", [b]]], [["permission-mode", [c]]], [["permission-mode-unknown", [d]]], [["depth-limit", [e]]]]);

  // An unknown mode is fine when the allowlist names the session's full id.
  const named = wakeNode(t, [SID], null);
  deliver(named, "x");
  await poll(named);
  assert.equal(hints(named), 1);
  // A codex- name never authorizes: names can be shared.
  const byName = wakeNode(t, [codexSessionName(SID)]);
  const g = deliver(byName, "x");
  await poll(byName);
  assert.deepEqual([queues(byName), actions(byName)], [[], [["not-allowlisted", [g]]]]);


});

test("CP hint admission preserves an existing configured shared budget", async (t) => {
  const node = wakeNode(t);
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as { wake: Record<string, unknown> };
  policy.wake.budget = { perHour: 8, perDay: 100 };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  for (let n = 0; n < 6; n++) assert.equal(takeTurn(node.paths, SID, T0 - 50 * 60_000 + n * 2 * TURN_SPACING_MS), "ok");
  const ledger = path.join(listenerDir(node.paths), `${SID}.turns.json`);
  const before = fs.readFileSync(ledger);
  const id = deliver(node, "x");
  await poll(node);
  assert.deepEqual([hints(node), actions(node)], [1, [["wake", [id]]]]);
  assert.deepEqual(fs.readFileSync(ledger), before, "CP admission does not book a seventh real turn");
});

test("task sessions are excluded; original owners do not depend on a working CLI", async (t) => {
  const node = wakeNode(t);
  writeTask(node.paths, { taskId: TASK, runtime: "codex", name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto", state: "done",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), sessionId: SID });
  deliver(node, "x");
  await poll(node);
  assert.deepEqual(queues(node), []);
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${SID}.busy-hint.json`)), false);
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${SID}.busy-admission.json`)), false);

  const FAIL = "fa11db01-0000-7000-8000-000000000001";
  const failing = wakeNode(t, [FAIL], "default", FAIL);
  const id = deliver(failing, "x", 0, FAIL);
  pollCodexQueue(failing.deps({ findCodex: () => { throw new Error("missing CLI"); } }));
  await codexQueueIdle();
  assert.deepEqual(actions(failing), [["wake", [id]]]);
  assert.equal(getMessageProgress(failing.paths.inbox, id)?.code, "awaiting-user-turn");
  assert.deepEqual(queues(failing), []);

});

test("codex queue never gets a flag that changes the sandbox or approvals", () => {
  for (const flag of ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "--add-dir",
    "--sandbox", "-s", "-c", "--config"]) {
    assert.throws(() => guardQueue(["queue", flag]), /changes the sandbox/, flag);
  }
  assert.throws(() => queueArgs("--approve-for-me", 1), /not a plain name/);
  assert.deepEqual(queueArgs(SID, 2), ["queue", "--thread", SID, "--message",
    "Kherep: 2 peer message(s) waiting in your inbox."]);
});

test("the Codex delivery hook records the session's permission mode and keeps it when an input lacks it", (t) => {
  const node = codexNode(t);
  const input = (extra: Record<string, unknown>) => ({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: node.workspace, ...extra });
  deliverForCodex(input({ permission_mode: "bypassPermissions" }), { paths: node.paths, now: () => T0 });
  assert.equal(readCodexSession(node.paths, SID)?.permissionMode, "bypassPermissions");
  deliverForCodex(input({}), { paths: node.paths, now: () => T0 + 1000 });
  assert.equal(readCodexSession(node.paths, SID)?.permissionMode, "bypassPermissions");
  deliverForCodex(input({ permission_mode: "not a mode!" }), { paths: node.paths, now: () => T0 + 2000 });
  assert.equal(readCodexSession(node.paths, SID)?.permissionMode, "bypassPermissions", "a malformed value changes nothing");
});

test("two sessions started in the same minute: their shared old name wakes neither", async (t) => {
  const A = "01a0db01-0000-7000-8000-00000000aaaa";
  const B = "01a0db01-1111-7000-8000-00000000bbbb";
  const node = wakeNode(t, [A, B], "default", A);
  recordCodexSession(node.paths, B, node.workspace, T0, "default");
  writeLocalSessions(node.paths, [A, B].map((sessionId) => ({
    sessionId, runtime: "codex", state: "active", name: codexSessionName(sessionId),
  })), T0);
  const shared = deliver(node, "x", 0, legacyCodexSessionName(A));
  await poll(node);
  assert.deepEqual(queues(node), []);
  assert.deepEqual(actions(node), [["ambiguous-name", [shared]]]);
  const toA = deliver(node, "y", 0, codexSessionName(A));
  await poll(node);
  assert.deepEqual(queues(node), []);
  assert.equal(hints(node), 1);
  assert.equal(getMessage(node.paths.inbox, toA)?.state, "accepted");
});

test("CP-only admission returns at once without a native executable or turn budget", async (t) => {
  const HANG = "0a9e0001-0000-7000-8000-000000000001";
  const node = wakeNode(t, [HANG], "default", HANG);
  deliver(node, "x", 0, HANG);
  const began = Date.now();
  pollCodexQueue(node.deps({ queueTimeoutMs: 1 }));
  assert.ok(Date.now() - began < 300, "the round returns at once");
  await codexQueueIdle();
  assert.deepEqual(queues(node), []);
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${HANG}.busy-hint.json`)), true);
  const initial = generation(node, HANG);
  node.tick(11 * 60_000);
  await poll(node);
  assert.notEqual(generation(node, HANG), initial, "later CP admission uses fresh guards");
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${HANG}.turns.json`)), false);
});
