import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { MessageProgressCode } from "../protocol-messages.mts";
import { rememberMode, takeTurn, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, closedSince, deliver, missListings, SESSION, type Node } from "./closed-fixture.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, getMessageProgress } from "./inbox.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0, taskId } from "./task-fixture.mts";
import { listTasks, writeTask, type TaskRecord } from "./task-records.mts";
import { killSwitch } from "./wake-hook.mts";

// Issue #230: every reason closed-session delivery refuses a message for
// carries its own progress code. A policy refusal waits with the code of the
// guard that holds it; fallback-failed is reserved for a launch that failed.

const claudeRuns = (node: Node) => node.calls.filter((c) => c.args[0] !== "agents");
const progress = (node: Node, id: string) => {
  const p = getMessageProgress(node.paths.inbox, id);
  return [p?.phase, p?.code];
};
const task = (node: Node, n: number, extra: Partial<TaskRecord>): TaskRecord => ({ taskId: taskId(n), name: `task-0000000${n}`,
  cwd: node.workspace, permissionMode: "auto", state: "done", startedAt: new Date(T0).toISOString(),
  deadline: new Date(T0 + 3_600_000).toISOString(), updatedAt: new Date(T0).toISOString(), ...extra });
// Issue #389: listed with that cwd, then closed by its miss streak.
const knownCwd = (node: Node, cwd: string) => closedSince(node, { sessionId: SESSION, runtime: "claude-code", state: "idle", cwd });

type Case = [what: string, code: MessageProgressCode, reason: RegExp, arrange?: (node: Node) => void, sessions?: Record<string, unknown>,
  messaging?: Record<string, unknown>, message?: Parameters<typeof deliver>[1]];
const policyRefusals: Case[] = [
  ["the kill switch", "wake-disabled", /kill switch/, (node) => fs.writeFileSync(killSwitch(node.paths), "")],
  ["sessions disabled", "wake-disabled", /sessions are not enabled/, undefined, { enabled: false }],
  // Issue #396: these two are the node's authorization policy and keep wake-not-authorized.
  ["delegate.accept off", "wake-not-authorized", /does not accept delegated tasks/, undefined, { delegate: { accept: false } }],
  ["the accept rules", "wake-not-authorized", /not accepted by node policy/, undefined, {},
    { accept: [{ session: SESSION, from: ["00000000-0000-4000-8000-0000000000cc"] }] }],
  ["the reply depth", "reply-limit", /reply depth limit/, undefined, {}, {}, { depth: 6 }],
  ["bypassPermissions", "permission-restricted", /bypassPermissions/, (node) => rememberMode(node.paths, SESSION, "bypassPermissions")],
  ["an operator sender", "wake-not-authorized", /operator message/, undefined, {}, {}, { from: { nodeId: "operator", session: "api" } }],
  ["an operator stop of the session", "operator-stopped", /stopped by operator/,
    (node) => writeTask(node.paths, task(node, 7, { sessionId: SESSION, operatorStoppedAt: new Date(T0).toISOString() }))],
  ["the runtime not enabled", "wake-disabled", /runtime claude is not enabled/, undefined, { runtimes: ["codex"] }],
  ["maxConcurrent", "retry-pending", /at most 1 task sessions at a time/,
    (node) => writeTask(node.paths, task(node, 9, { state: "running" })), { maxConcurrent: 1 }],
  ["maxStartsPerDay", "retry-pending", /at most 1 task sessions per day/, (node) => writeTask(node.paths, task(node, 9, {})),
    { maxStartsPerDay: 1 }],
  ["the turn budget", "budget-exhausted", /budget/, (node) => {
    for (let i = 0; i < TURNS_PER_HOUR; i++) takeTurn(node.paths, SESSION, T0 - 50 * 60_000 + i * TURN_SPACING_MS * 2);
  }],
  // Issue #396: an unusable recorded cwd is no policy decision; it waits with cwd-refused.
  ["a cwd outside the workspace roots", "cwd-refused", /cwd is outside the workspace roots of this node/,
    (node) => knownCwd(node, node.root)],
  ["a cwd that does not exist", "cwd-refused", /cwd does not exist/, (node) => knownCwd(node, path.join(node.workspace, "gone"))],
  ["a relative cwd", "cwd-refused", /cwd must be an absolute path/, (node) => knownCwd(node, "repo")],
  ["a start permission mode the policy does not allow", "permission-restricted", /permission mode default is not allowed/, undefined,
    { permissionModes: ["acceptEdits"], defaultPermissionMode: "acceptEdits" }],
];

for (const [what, code, reason, arrange, sessions = {}, messaging = {}, message = {}] of policyRefusals) {
  test(`a refusal past ${what} waits with ${code}, not fallback-failed`, async (t) => {
    const node = closedNode(t, sessions, messaging);
    rememberMode(node.paths, SESSION, "auto");
    arrange?.(node);
    const id = deliver(node, message);
    await deliverToClosed(node.deps());
    assert.equal(claudeRuns(node).length, 0, "no launch");
    assert.match(String(audits(node).at(-1)?.reason), reason);
    assert.deepEqual(progress(node, id), ["waiting", code]);
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined, "tried again next round");
    if (code !== "budget-exhausted") assert.equal(takeTurn(node.paths, SESSION, T0), "ok", "the turn budget is untouched");
  });
}

// A limit before the attempt clears: the next round starts the intercom session.
const limits: [string, Record<string, unknown>, TaskRecord["state"], (node: Node) => void][] = [
  ["maxConcurrent", { maxConcurrent: 1 }, "running", (node) => writeTask(node.paths, { ...listTasks(node.paths)[0], state: "done" })],
  ["maxStartsPerDay", { maxStartsPerDay: 1 }, "done", (node) => {
    node.tick(24 * 3_600_000);
    missListings(node, 1, T0 + 24 * 3_600_000);
  }],
];
for (const [what, sessions, state, clear] of limits) {
  test(`a message held by ${what} starts its intercom session once the limit clears`, async (t) => {
    const node = closedNode(t, sessions);
    writeTask(node.paths, task(node, 9, { state }));
    const id = deliver(node);
    await deliverToClosed(node.deps());
    assert.deepEqual(progress(node, id), ["waiting", "retry-pending"]);
    clear(node);
    await deliverToClosed(node.deps());
    assert.equal(claudeRuns(node).length, 1, "started in the next round");
    assert.deepEqual(progress(node, id), ["fallback", "fallback-running"]);
    assert.ok(getMessage(node.paths.inbox, id)?.closedAttempt);
  });
}

// The attempt is marked before the resume, so the message is never tried again:
// a start the policy then refuses is a failed delivery, with the policy reason.
test("a start the policy refuses after a failed resume is a failed delivery, not a waiting policy code", async (t) => {
  const node = closedNode(t);
  rememberMode(node.paths, SESSION, "auto");
  deliver(node);
  await deliverToClosed(node.deps());
  const [intercom] = listTasks(node.paths);
  writeTask(node.paths, { ...intercom, state: "done" });
  node.tick(TURN_SPACING_MS * 2);
  // A closed Codex session of the same sender (issue #389: closed by its miss
  // streak): the Claude intercom is resumed, its start would be Codex.
  const codex = "0199a000-0000-7000-8000-0000000002a0";
  closedSince(node, { sessionId: codex, runtime: "codex", state: "idle", cwd: path.join(node.workspace, "repo") },
    T0 + TURN_SPACING_MS * 2);
  const id = deliver(node, { toSession: codex });
  const base = node.deps();
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] === "--resume") throw new Error("resume failed");
    return base.exec!(file, args, options);
  };
  await deliverToClosed({ ...base, exec });
  assert.match(String(audits(node).at(-1)?.reason),
    /^intercom session not resumed: resume failed; new start refused: runtime codex is not enabled on this node$/);
  assert.deepEqual(progress(node, id), ["failed", "fallback-failed"]);
  assert.ok(getMessage(node.paths.inbox, id)?.closedAttempt);
});

test("a launch that fails still reports fallback-failed", async (t) => {
  const node = closedNode(t);
  rememberMode(node.paths, SESSION, "auto");
  node.failNext("spawn failed");
  const id = deliver(node);
  await deliverToClosed(node.deps());
  assert.match(String(audits(node).at(-1)?.reason), /no intercom session: .*spawn failed/);
  assert.deepEqual(progress(node, id), ["failed", "fallback-failed"]);
});
