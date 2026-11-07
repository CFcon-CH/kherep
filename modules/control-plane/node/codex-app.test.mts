import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codexAppRollout, codexAssignmentRollout, currentCodexApp, ROLLOUT_DAY_DIRS } from "./codex-app.mts";
import { codexNode } from "./codex-fixture.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { loadPolicy } from "./policy.mts";
import { T0, TASK } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";

// Waking the current Codex desktop app session without pinning its id (issue
// #82): wake.codexApp grants the most recently seen recorded session whose
// rollout's first line says the app started it, and no other. Fixture rollouts
// only; no real Codex home is read.

const APP = "01a0db01-0000-7000-8000-00000000a001";
const APP_OLD = "01a0db01-0000-7000-8000-00000000a002";
const EXEC = "01a0db01-0000-7000-8000-00000000e001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "claude-peer-session" };
const APP_META = { originator: "Codex Desktop", source: "vscode" };
const EXEC_META = { originator: "codex_exec", source: "exec" };
let counter = 0;

function codexHome(t: test.TestContext): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// A rollout with the given first line (an object is written as a session_meta line).
function rollout(home: string, sessionId: string, first: string | Record<string, unknown>, day = "2026/09/25"): string {
  const dir = path.join(home, "sessions", ...day.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${day.replaceAll("/", "-")}T10-00-00-${sessionId}.jsonl`);
  const line = typeof first === "string" ? first
    : JSON.stringify({ timestamp: "2026-09-25T10:00:00Z", type: "session_meta", payload: { id: sessionId, cli_version: "0.153.4", ...first } });
  fs.writeFileSync(file, `${line}\n{"type":"event_msg","payload":{}}\n`);
  return file;
}

type Node = ReturnType<typeof codexNode>;

// A node with the given wake section and no codex binary: an authorized
// Desktop or TUI admission publishes without a CLI.
function appNode(t: test.TestContext, wake: Record<string, unknown>): { node: Node; home: string; poll: () => Promise<void> } {
  const home = codexHome(t);
  const node = codexNode(t, {}, { home, findCodex: () => null });
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, unknown>;
  policy.wake = { enabled: true, ...wake };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  return { node, home, poll: async () => { pollCodexQueue(node.deps()); await codexQueueIdle(); } };
}

function deliver(node: Node, toSession: string): string {
  const id = `ae57${(++counter).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;
  storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession, text: "secret peer text", createdAt: new Date(T0).toISOString() }, T0, 0);
  return id;
}

const audit = (node: Node): Record<string, unknown>[] => {
  const file = path.join(node.paths.dir, "wake.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};
const decisions = (node: Node): [unknown, unknown, unknown][] => audit(node).map((l) => [l.sessionId, l.action, l.grant]);

test("policy: wake.codexApp is an optional boolean; anything else disables waking", (t) => {
  const dir = codexHome(t);
  const load = (wake: unknown) => {
    const file = path.join(dir, "policy.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, allowedCommands: [], wake }));
    return loadPolicy(file).wake;
  };
  assert.deepEqual(load({ enabled: true, sessions: ["a"] }), { enabled: true, sessions: ["a"] }, "absent: unchanged");
  assert.deepEqual(load({ enabled: true, sessions: ["a"], codexApp: false }), { enabled: true, sessions: ["a"] });
  assert.deepEqual(load({ enabled: true, sessions: ["a"], codexApp: true }), { enabled: true, sessions: ["a"], codexApp: true });
  assert.deepEqual(load({ enabled: true, codexApp: true }), { enabled: true, sessions: [], codexApp: true }, "the grant alone needs no list");
  assert.deepEqual(load({ enabled: true, sessions: [], codexApp: true }), { enabled: true, sessions: [], codexApp: true });
  for (const codexApp of ["true", 1, null, {}, []]) assert.equal(load({ enabled: true, sessions: ["a"], codexApp }), undefined, JSON.stringify(codexApp));
  assert.equal(load({ enabled: false, codexApp: true }), undefined);
  assert.equal(load({ enabled: true, sessions: [], codexApp: false }), undefined, "an empty list still needs the grant");
  assert.equal(load({ enabled: true }), undefined);
  assert.equal(load({ enabled: true, sessions: ["a", 3], codexApp: true }), undefined);
});

test("the rollout check accepts only a Codex Desktop session_meta with source vscode for this id", (t) => {
  const home = codexHome(t);
  rollout(home, APP, APP_META);
  assert.equal(codexAppRollout(home, APP), "ok");
  rollout(home, APP, { ...APP_META, session_id: APP, parent_thread_id: null, forked_from_id: null,
    attached_thread: false, forked_from_ordinal_exclusive: null, agent_role: null });
  assert.equal(codexAppRollout(home, APP), "ok", "supported explicit original defaults");
  assert.equal(codexAppRollout(home, "01a0db01-0000-7000-8000-00000000ffff"), "no-rollout");
  const cases: [string, string | Record<string, unknown>][] = [
    ["exec", EXEC_META],
    ["subagent", { originator: "Codex Desktop", source: { subagent: "review" } }],
    ["subagent thread", { ...APP_META, parent_thread_id: "01a0db01-0000-7000-8000-0000000000aa" }],
    ["other originator", { originator: "codex_work_desktop", source: "vscode" }],
    ["desktop exec", { originator: "Codex Desktop", source: "exec" }],
    ["missing originator", { source: "vscode" }],
    ["another id", { ...APP_META, id: "01a0db01-0000-7000-8000-00000000bbbb" }],
    ["garbled", "{\"type\":\"session_meta\",\"payload\":{\"originator\":\"Codex Desktop\""],
    ["not session_meta", JSON.stringify({ type: "event_msg", payload: { id: "x", ...APP_META } })],
    ["no payload", JSON.stringify({ type: "session_meta" })],
    ["empty", ""],
  ];
  for (const [n, [label, first]] of cases.entries()) {
    const id = `01a0db01-0000-7000-8000-${(0xc000 + n).toString(16).padStart(12, "0")}`;
    rollout(home, id, first);
    assert.equal(codexAppRollout(home, id), "not-app", label);
  }
  // A first line without an end within the read limit is refused.
  const long = "01a0db01-0000-7000-8000-00000000d001";
  const file = rollout(home, long, APP_META);
  fs.writeFileSync(file, `{"type":"session_meta","payload":{"id":"${long}","originator":"Codex Desktop","source":"vscode","x":"${"a".repeat(300 * 1024)}"}}`);
  assert.equal(codexAppRollout(home, long), "not-app");
  // An id that is not a plain name is never looked up.
  assert.equal(codexAppRollout(home, "../x"), "no-rollout");
});

test("the rollout search is bounded to the newest date directories", (t) => {
  const home = codexHome(t);
  rollout(home, APP, APP_META, "2025/01/01");
  // ROLLOUT_DAY_DIRS newer day directories, plus entries that are not dates.
  for (let n = 0; n < ROLLOUT_DAY_DIRS; n++) {
    fs.mkdirSync(path.join(home, "sessions", "2026", String(1 + Math.floor(n / 28)).padStart(2, "0"), String(1 + (n % 28)).padStart(2, "0")), { recursive: true });
  }
  fs.mkdirSync(path.join(home, "sessions", "latest", "01", "01"), { recursive: true });
  assert.equal(codexAppRollout(home, APP), "no-rollout", "older than the newest day directories");
  const near = codexHome(t);
  rollout(near, APP, APP_META, "2026/01/01");
  fs.mkdirSync(path.join(near, "sessions", "2026", "02", "01"), { recursive: true });
  assert.equal(codexAppRollout(near, APP), "ok");
});

test("currentCodexApp picks the most recently seen app session, never an exec one, and none on a tie", (t) => {
  const { node, home } = appNode(t, { codexApp: true });
  rollout(home, APP_OLD, APP_META);
  rollout(home, APP, APP_META);
  rollout(home, EXEC, EXEC_META);
  recordCodexSession(node.paths, APP_OLD, node.workspace, T0 - 60_000, "default");
  recordCodexSession(node.paths, APP, node.workspace, T0 - 30_000, "default");
  recordCodexSession(node.paths, EXEC, node.workspace, T0, "default");
  assert.equal(currentCodexApp(node.paths, [APP_OLD, APP, EXEC], home), APP);
  recordCodexSession(node.paths, APP_OLD, node.workspace, T0 - 30_000, "default");
  assert.equal(currentCodexApp(node.paths, [APP_OLD, APP, EXEC], home), null, "two app sessions seen at the same time: neither");
  assert.equal(currentCodexApp(node.paths, [EXEC], home), null);
});

test("codexApp admits a CP hint for the app mailbox and does not grant a newer exec session", async (t) => {
  const { node, home, poll } = appNode(t, { codexApp: true });
  rollout(home, APP, APP_META);
  rollout(home, EXEC, EXEC_META);
  recordCodexSession(node.paths, APP, node.workspace, T0 - 60_000, "default");
  recordCodexSession(node.paths, EXEC, node.workspace, T0, "default");
  const toApp = deliver(node, APP);
  const toExec = deliver(node, EXEC);
  await poll();
  assert.deepEqual(decisions(node).sort(), [[APP, "wake", "codexApp"], [EXEC, "not-allowlisted", undefined]]);
  assert.ok(!JSON.stringify(audit(node)).includes("secret"), "the audit carries no text");
  assert.equal(getMessage(node.paths.inbox, toExec)?.state, "accepted");
  assert.equal(getMessage(node.paths.inbox, toApp)?.state, "accepted", "the delivery hook offers it");
});

test("codexApp refuses a missing, garbled or foreign session_meta, a task thread and an unknown permission mode", async (t) => {
  for (const [label, setupCase] of [
    ["missing", () => {}],
    ["garbled", (home: string) => rollout(home, APP, "{not json")],
    ["foreign", (home: string) => rollout(home, APP, { originator: "Claude Code", source: "vscode" })],
  ] as [string, (home: string) => void][]) {
    const { node, home, poll } = appNode(t, { codexApp: true });
    setupCase(home);
    recordCodexSession(node.paths, APP, node.workspace, T0, "default");
    deliver(node, APP);
    await poll();
    assert.deepEqual(decisions(node), [[APP, "not-allowlisted", undefined]], label);
  }
  const unknown = appNode(t, { codexApp: true });
  rollout(unknown.home, APP, APP_META);
  recordCodexSession(unknown.node.paths, APP, unknown.node.workspace, T0);
  deliver(unknown.node, APP);
  await unknown.poll();
  assert.deepEqual(decisions(unknown.node), [[APP, "permission-mode-unknown", "codexApp"]]);
  const bypass = appNode(t, { codexApp: true });
  rollout(bypass.home, APP, APP_META);
  recordCodexSession(bypass.node.paths, APP, bypass.node.workspace, T0, "bypassPermissions");
  deliver(bypass.node, APP);
  await bypass.poll();
  assert.deepEqual(decisions(bypass.node), [[APP, "permission-mode", "codexApp"]]);
  const task = appNode(t, { codexApp: true });
  rollout(task.home, APP, APP_META);
  recordCodexSession(task.node.paths, APP, task.node.workspace, T0, "default");
  writeTask(task.node.paths, { taskId: TASK, runtime: "codex", name: "task-3f2a1b0c", cwd: task.node.workspace, permissionMode: "auto", state: "done",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), sessionId: APP });
  deliver(task.node, APP);
  await task.poll();
  assert.deepEqual(decisions(task.node), [], "a task thread is resumed, never queued");
});

test("codexApp keeps the kill switch first", async (t) => {
  const { node, home, poll } = appNode(t, { codexApp: true });
  rollout(home, APP, APP_META);
  recordCodexSession(node.paths, APP, node.workspace, T0, "default");
  fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "");
  deliver(node, APP);
  await poll();
  assert.deepEqual(decisions(node), [[APP, "disabled", undefined]]);
});

test("without codexApp a Desktop has no grant; full-id authorization permits either runtime's CP hint", async (t) => {
  for (const wake of [{ sessions: ["someone-else"] }, { sessions: ["someone-else"], codexApp: false }]) {
    const { node, home, poll } = appNode(t, wake);
    rollout(home, APP, APP_META);
    recordCodexSession(node.paths, APP, node.workspace, T0, "default");
    deliver(node, APP);
    await poll();
    assert.deepEqual(decisions(node), [[APP, "not-allowlisted", undefined]], JSON.stringify(wake));
  }
  // Full-id authorization uses no codexApp grant field and both admit CP hints.
  for (const desktop of [false, true]) {
    const { node, home, poll } = appNode(t, { sessions: [APP], codexApp: true });
    if (desktop) rollout(home, APP, APP_META);
    recordCodexSession(node.paths, APP, node.workspace, T0, "default");
    deliver(node, APP);
    await poll();
    assert.deepEqual(decisions(node), [[APP, "wake", undefined]]);
  }
});

test("assignment original-thread checks preserve legacy app eligibility", (t) => {
  const home = codexHome(t);
  rollout(home, APP, { ...APP_META, forked_from_id: APP_OLD });
  assert.equal(codexAppRollout(home, APP), "ok", "legacy Desktop fork eligibility remains unchanged");
  const cases: [string, Record<string, unknown>][] = [
    ["native fork", { ...APP_META, forked_from_id: APP_OLD }],
    ["malformed fork", { ...APP_META, forked_from_id: false }],
    ["attached fork", { ...APP_META, attached_thread: true }],
    ["unsupported attached marker", { ...APP_META, attached_thread: "false" }],
    ["fork boundary", { ...APP_META, forked_from_ordinal_exclusive: 0 }],
    ["different root session", { ...APP_META, session_id: APP_OLD }],
    ["agent nickname", { ...APP_META, agent_nickname: "synthetic-child" }],
    ["agent role", { ...APP_META, agent_role: "worker" }],
    ["legacy agent role", { ...APP_META, agent_type: "worker" }],
    ["agent path", { ...APP_META, agent_path: "/synthetic/child" }],
    ["subagent history", { ...APP_META, subagent_history_start_ordinal: 0 }],
  ];
  for (const [label, metadata] of cases) {
    rollout(home, APP, metadata);
    assert.equal(codexAssignmentRollout(home, APP), "not-app", label);
    assert.equal(codexAppRollout(home, APP), "ok", `legacy ${label}`);
  }
  rollout(home, APP, { ...APP_META, session_id: APP, forked_from_id: null, parent_thread_id: null, attached_thread: false });
  assert.equal(codexAssignmentRollout(home, APP), "ok", "supported original");
  rollout(home, APP, EXEC_META);
  assert.equal(codexAssignmentRollout(home, APP), "not-app", "exec remains denied");
  rollout(home, APP, { ...APP_META, id: APP_OLD });
  assert.equal(codexAssignmentRollout(home, APP), "not-app", "exact id remains required");
  assert.equal(codexAssignmentRollout(home, APP_OLD), "no-rollout");
});
