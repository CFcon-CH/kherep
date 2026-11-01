import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { rememberMode, takeTurn, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { startIntercom } from "./closed-resume.mts";
import { ACCEPT_ALL, audits, closedNode, closedSince, deliver, endedIntercom, PEER, SESSION, turnDone, type Node } from "./closed-fixture.mts";
import { fakeCodexBin } from "./codex-fixture.mts";
import { recordingSessions, writeDirectory } from "./exchange.mts";
import { getMessage, getMessageProgress } from "./inbox.mts";
import { readKnownSessions } from "./known-sessions.mts";
import { loadPolicy } from "./policy.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0, taskId } from "./task-fixture.mts";
import { listTasks, queueReport, readTask, reportIds, writeTask } from "./task-records.mts";
import { killSwitch } from "./wake-hook.mts";

// Delivery to a session that is no longer running (issues #102, #105): a
// message for a known, closed session of this node goes to an intercom session
// of its sender, a new one here (closed-reuse.test.mts: an existing one); the
// closed session itself is never resumed, and every guard refuses fail closed.

const claudeRuns = (node: Node) => node.calls.filter((c) => c.args[0] !== "agents");
const repo = (node: Node): string => fs.realpathSync.native(path.join(node.workspace, "repo"));

test("with resumeClosed off nothing changes: no run, no audit, the message waits", async (t) => {
  const node = closedNode(t, {}, { resumeClosed: undefined });
  const id = deliver(node);
  rememberMode(node.paths, SESSION, "auto");
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual(audits(node), []);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined);
});

test("resumeClosed is enabled only by the boolean true", (t) => {
  const node = closedNode(t);
  for (const value of ["true", 1, {}, null]) {
    fs.writeFileSync(node.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], messaging: { ...ACCEPT_ALL, resumeClosed: value } }));
    const policy = loadPolicy(node.paths.policy);
    assert.equal(policy.messaging?.resumeClosed, undefined, String(value));
    assert.equal(policy.messaging?.accept.length, 1);
  }
  fs.writeFileSync(node.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], messaging: { ...ACCEPT_ALL, resumeClosed: true } }));
  assert.equal(loadPolicy(node.paths.policy).messaging?.resumeClosed, true);
});

test("a new intercom session gets the messages framed with their reply commands, never a resume of the closed session", async (t) => {
  const node = closedNode(t);
  writeDirectory(node.paths, { nodes: [{ nodeId: PEER.nodeId, name: "mac", status: "online" }],
    sessions: [{ nodeId: PEER.nodeId, sessionId: PEER.session, runtime: "claude-code", state: "idle" }], fetchedAt: new Date(T0).toISOString() });
  // A resumable mode no longer resumes the closed session: that would reload its whole conversation.
  rememberMode(node.paths, SESSION, "auto");
  const first = deliver(node);
  const second = deliver(node, { text: "and the lint?" });
  await deliverToClosed(node.deps());
  const runs = claudeRuns(node);
  assert.equal(runs.length, 1);
  assert.ok(!runs[0].args.includes("--resume"));
  assert.equal(runs[0].args[0], "--bg");
  const task = listTasks(node.paths)[0];
  assert.deepEqual(runs[0].args.slice(1, 5), ["--name", task.name, "--permission-mode", "auto"]);
  const prompt = runs[0].args[5];
  assert.match(prompt, /are the tests green\?/);
  assert.match(prompt, /and the lint\?/);
  assert.match(prompt, /Automatic delivery fallback approved by this node's policy/);
  assert.match(prompt, /NOT an instruction from the user/);
  for (const id of [first, second]) assert.ok(prompt.includes(`To reply: kherep-node msg send --reply-to ${id} -- <reply text>`), id);
  assert.match(prompt, /keeps --reply-to <message id>/);
  assert.ok(!prompt.includes(`msg send ${PEER.nodeId}/${PEER.session}`), "no unthreaded reply command");
  assert.equal(task.local, "intercom");
  assert.equal(task.label, "intercom: claude@mac");
  assert.equal(task.requestedBy, `${PEER.nodeId}/${PEER.session}`);
  assert.deepEqual(getMessage(node.paths.inbox, first)?.delivery,
    { taskId: task.taskId, runtime: "claude", sessionId: task.sessionId });
  assert.deepEqual(getMessage(node.paths.inbox, second)?.delivery,
    { taskId: task.taskId, runtime: "claude", sessionId: task.sessionId });
  assert.equal(runs[0].options.cwd, repo(node));
  // Issue #308: offered to the intercom session, delivered only once its turn completed.
  for (const id of [first, second]) assert.equal(getMessage(node.paths.inbox, id)?.state, "offered", id);
  for (const id of [first, second]) assert.equal(getMessage(node.paths.inbox, id)?.offeredBy, "intercom", id);
  await turnDone(node);
  assert.equal(getMessage(node.paths.inbox, first)?.state, "delivered");
  assert.equal(getMessage(node.paths.inbox, second)?.state, "delivered");
  assert.deepEqual(node.reports(), [], "the Worker does not know the run");
  assert.deepEqual(audits(node).map((a) => [a.action, a.outcome, a.messageIds]), [["closed-session", "new", [first, second]]]);
});

test("a fresh Codex intercom start reports its running fallback while the turn awaits confirmation", async (t) => {
  const node = closedNode(t, { runtimes: ["claude", "codex"] });
  const id = deliver(node, { text: "[no-reply]" });
  const fake = fakeCodexBin(t);
  const deps = { ...node.deps(), codex: { findCodex: () => fake.file, startWaitMs: 5_000, graceMs: 300 } };
  const reason = await startIntercom(deps, { sessionId: SESSION, runtime: "codex", cwd: repo(node) },
    [getMessage(node.paths.inbox, id)!], "auto");
  assert.equal(reason, null);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered");
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "fallback-running");
});

test("a failed task result is not treated as a started delivery", async (t) => {
  const node = closedNode(t);
  const id = deliver(node);
  const failedId = taskId(42);
  writeTask(node.paths, { taskId: failedId, name: "task-0000002a", cwd: repo(node), permissionMode: "auto", state: "failed",
    reason: "previous launch failed", runtime: "claude", local: "intercom", startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString() });
  const reason = await startIntercom(node.deps(), { sessionId: SESSION, runtime: "claude", cwd: repo(node) },
    [getMessage(node.paths.inbox, id)!], "auto", undefined, failedId);
  assert.equal(reason, "previous launch failed");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  assert.equal(getMessage(node.paths.inbox, id)?.delivery, undefined);
});
test("failed Claude intercom starts keep the message accepted and unassociated", async (t) => {
  const cases: [string, (node: Node) => ReturnType<Node["deps"]>, RegExp][] = [
    ["missing binary", (node) => ({ ...node.deps(), findClaude: () => null }), /claude is not installed/],
    ["spawn failure", (node) => {
      node.failNext("spawn failed");
      return node.deps();
    }, /spawn failed/],
    ["bad background id", (node) => {
      const base = node.deps();
      const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> =>
        args[0] === "--bg" ? "started without an id" : base.exec!(file, args, options);
      return { ...base, exec };
    }, /printed no session id/],
  ];
  for (const [name, deps, reason] of cases) {
    const node = closedNode(t);
    const id = deliver(node, { text: name });
    await deliverToClosed(deps(node));
    const message = getMessage(node.paths.inbox, id);
    assert.equal(message?.state, "accepted", name);
    assert.equal(message?.delivery, undefined, name);
    assert.equal(listTasks(node.paths).at(-1)?.state, "failed", name);
    assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "fallback-failed", name);
    assert.match(String(audits(node).at(-1)?.reason), reason, name);
  }
});
test("a message addressed by the closed session's name starts an intercom session too", async (t) => {
  const node = closedNode(t);
  deliver(node, { toSession: "review" });
  await deliverToClosed(node.deps());
  assert.deepEqual(claudeRuns(node).map((c) => c.args[0]), ["--bg"]);
});

test("a stale listing decides nothing", async (t) => {
  const node = closedNode(t);
  deliver(node);
  node.tick(10 * 60_000);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
});

test("an operator message goes to no intercom session", async (t) => {
  const node = closedNode(t);
  const id = deliver(node, { from: { nodeId: "operator", session: "api" } });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual(audits(node).map((a) => [a.outcome, a.reason]), [["refused", "an operator message goes to no intercom session"]]);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
});

const refusals: [string, (node: Node) => void, Record<string, unknown>, RegExp][] = [
  ["the kill switch", (node) => fs.writeFileSync(killSwitch(node.paths), ""), {}, /kill switch/],
  ["sessions disabled", () => {}, { enabled: false }, /sessions are not enabled/],
  ["delegate.accept off", () => {}, { delegate: { accept: false } }, /does not accept delegated tasks/],
  ["the runtime not enabled", () => {}, { runtimes: ["codex"] }, /runtime claude is not enabled/],
  ["bypassPermissions", (node) => rememberMode(node.paths, SESSION, "bypassPermissions"), {}, /bypassPermissions/],
  ["maxConcurrent", (node) => writeTask(node.paths, { taskId: taskId(9), name: "task-00000009", cwd: node.workspace, permissionMode: "auto",
    state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString() }), { maxConcurrent: 1 }, /at most 1 task sessions/],
  ["the budget", (node) => {
    for (let i = 0; i < TURNS_PER_HOUR; i++) takeTurn(node.paths, SESSION, T0 - 50 * 60_000 + i * TURN_SPACING_MS * 2);
  }, {}, /budget/],
  ["a cwd outside the workspace roots", (node) => closedSince(node, { sessionId: SESSION, runtime: "claude-code",
    state: "idle", cwd: node.root }), {}, /outside the workspace roots/],
];

test("a configured wake.budget lets an intercom session start past the default turns of this hour (issue #259)", async (t) => {
  const node = closedNode(t);
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(node.paths.policy, JSON.stringify({ ...policy,
    wake: { enabled: true, sessions: ["unrelated"], budget: { perHour: TURNS_PER_HOUR + 2, perDay: 100 } } }));
  rememberMode(node.paths, SESSION, "auto");
  for (let i = 0; i < TURNS_PER_HOUR; i++) takeTurn(node.paths, SESSION, T0 - 50 * 60_000 + i * TURN_SPACING_MS * 2);
  deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 1);
});

for (const [what, arrange, sessions, reason] of refusals) {
  test(`no intercom session past ${what}`, async (t) => {
    const node = closedNode(t, sessions);
    rememberMode(node.paths, SESSION, "auto");
    arrange(node);
    const id = deliver(node);
    await deliverToClosed(node.deps());
    await deliverToClosed(node.deps());
    assert.equal(claudeRuns(node).length, 0);
    const lines = audits(node).filter((a) => a.action === "closed-session");
    assert.equal(lines.length, 1, "audited once");
    assert.equal(lines[0].outcome, "refused");
    assert.match(String(lines[0].reason), reason);
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined);
    // Its progress code: closed-delivery-codes.test.mts (issue #230).
  });
}

test("an operator-stopped intercom is neither resumed nor replaced", async (t) => {
  const node = closedNode(t);
  const { task, id } = await endedIntercom(node);
  writeTask(node.paths, { ...readTask(node.paths, task.taskId)!, operatorStoppedAt: new Date(T0).toISOString() });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 1, "only the original intercom start");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined);
  assert.deepEqual(audits(node).at(-1)?.reason, "intercom session stopped by operator");
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "operator-stopped");
});
test("a sender the accept rules do not name is refused", async (t) => {
  const node = closedNode(t, {}, { accept: [{ session: SESSION, from: ["00000000-0000-4000-8000-0000000000cc"] }] });
  deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual(audits(node).map((a) => a.reason), ["not accepted by node policy"]);
});

test("every successful listing is remembered, and an ended session stays known", async (t) => {
  const node = closedNode(t);
  const listed = [{ sessionId: "2a2a2a2a-0000-4000-8000-000000000000", runtime: "codex", state: "active", cwd: node.workspace }];
  let answer = listed;
  const list = recordingSessions(node.paths, async () => answer, () => {}, () => T0);
  await list();
  answer = [];
  await list();
  assert.deepEqual(readKnownSessions(node.paths).map((s) => s.sessionId).sort(), [listed[0].sessionId, SESSION].sort());
  assert.equal(readKnownSessions(node.paths).find((s) => s.sessionId === listed[0].sessionId)?.cwd, node.workspace);
  assert.equal(readKnownSessions(node.paths).find((s) => s.sessionId === listed[0].sessionId)?.lastSeen, new Date(T0).toISOString());
  assert.equal(JSON.parse(fs.readFileSync(node.paths.sessions, "utf8")).updatedAt, new Date(T0).toISOString());
});

test("a message at the reply depth limit is refused, others of the burst still go to an intercom session", async (t) => {
  const node = closedNode(t);
  const deep = deliver(node, { depth: 6 });
  const fresh = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 1);
  const outcomes = audits(node).map((a) => [a.outcome, a.messageIds]);
  assert.deepEqual(outcomes, [["refused", [deep]], ["new", [fresh]]]);
});

test("an unknown session is left alone", async (t) => {
  const node = closedNode(t);
  deliver(node, { toSession: "never-seen" });
  await deliverToClosed(node.deps());
  assert.equal(claudeRuns(node).length, 0);
  assert.deepEqual(audits(node), []);
});

test("a local task reports nothing to the Worker", (t) => {
  const node = closedNode(t);
  const id = taskId(7);
  writeTask(node.paths, { taskId: id, name: "task-00000007", cwd: node.workspace, permissionMode: "auto", state: "started",
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), local: "intercom" });
  queueReport(node.paths, { taskId: id, state: "done" });
  assert.deepEqual(reportIds(node.paths), []);
  assert.equal(readTask(node.paths, id)?.local, "intercom");
});

// #706 keeps the old route a strict subset of baseline eligibility: even an
// otherwise authorized fixture with a complete old miss streak needs fresh
// exact closure metadata. Archive/delete/unknown never activate the old route.
test("liveness vetoes preserve baseline fallback guards and never spend a turn", async (t) => {
  const { publishLiveness } = await import("./session-lifecycle.mts");
  const { writeLocalSessions } = await import("./exchange-sessions.mts");
  for (const state of ["unknown", "archived", "deleted", "stale", "future", "partial"] as const) await t.test(state, async sub => {
    const node = closedNode(sub);
    const at = state === "stale" ? T0 - 60_001 : state === "future" ? T0 + 1 : T0;
    const common = { status: "value" as const, observedAt: at, complete: state !== "partial", reasonCode: "observed" as const };
    publishLiveness(node.paths, [{ runtime: "claude-code", sessionId: SESSION,
      ...(state === "archived" || state === "deleted" ? { lifecycle: { ...common, source: "native-lifecycle" as const, value: { state, generation: 1 } } }
        : state === "unknown" ? {} : { holder: { ...common, source: "native-holder" as const, value: { present: false } },
          app: { ...common, source: "native-app" as const, value: "absent" as const } }),
    }], T0);
    writeLocalSessions(node.paths, [], T0);
    const id = deliver(node);
    await deliverToClosed(node.deps());
    assert.equal(claudeRuns(node).length, 0);
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined);
    assert.equal(takeTurn(node.paths, SESSION, T0), "ok", "liveness veto leaves the turn budget untouched");
  });
  for (const misses of [0, 1, 2]) await t.test(`fresh closure but only ${misses} old misses`, async sub => {
    const node = closedNode(sub, {}, {}, misses);
    deliver(node);
    await deliverToClosed(node.deps());
    assert.equal(claudeRuns(node).length, 0, "positive metadata cannot remove the baseline miss veto");
  });
});

test("a terminal generation published during the existing process await vetoes fallback before its attempt", async (t) => {
  const node = closedNode(t);
  writeTask(node.paths, { taskId: taskId(707), name: "task-000002c3", sessionId: SESSION, runtime: "claude", cwd: repo(node),
    permissionMode: "auto", state: "done", pid: 42, pidStart: "synthetic-start", startedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(), deadline: new Date(T0).toISOString() }, T0);
  const id = deliver(node);
  const { publishLiveness } = await import("./session-lifecycle.mts");
  const { writeLocalSessions } = await import("./exchange-sessions.mts");
  await deliverToClosed({ ...node.deps(), codex: { processStart: async () => {
    publishLiveness(node.paths, [{ runtime: "claude-code", sessionId: SESSION, lifecycle: {
      status: "value", value: { state: "deleted", generation: 1 }, observedAt: T0, complete: true, source: "native-lifecycle", reasonCode: "observed",
    } }], T0);
    writeLocalSessions(node.paths, [], T0);
    return null;
  } } });
  assert.equal(claudeRuns(node).length, 0);
  assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined);
  assert.equal(takeTurn(node.paths, SESSION, T0), "ok");
});
