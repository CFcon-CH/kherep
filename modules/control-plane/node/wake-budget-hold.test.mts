import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerLock, listenerScope } from "./autonomy.mts";
import { evaluateTurnBudget } from "./autonomy-budget.mts";
import { checkWakeBudget } from "./doctor-wake-budget.mts";
import { getMessage, getMessageProgress, markDelivered, markOffered, unreportedStatuses, writeJsonAtomic } from "./inbox.mts";
import { DEFAULT_TURN_BUDGET } from "./policy.mts";
import { T0, TASK } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";
import { ARMED_BEFORE_T0, clock, code, fullHour, heldNode, iso, ledger, liveListener, message, observe, SESSION, status } from "./wake-hold-fixture.mts";

// Issue #827: an accepted message a live listener would wake for reports the
// exhausted ledger that denies the wake, instead of wake-pending.

test("Claude budget denial reaches both status routes", async t => {
  const node = heldNode(t);
  const id = message(node);
  const before = fs.readFileSync(ledger(node));
  const retryAt = evaluateTurnBudget(fullHour(T0), DEFAULT_TURN_BUDGET, T0).nextAvailableAt!;
  observe(node);
  assert.deepEqual(getMessageProgress(node.paths.inbox, id), { phase: "waiting", code: "budget-exhausted", observedAt: iso(T0), retryAt });
  const [report] = unreportedStatuses(node.paths.inbox, T0, [getMessage(node.paths.inbox, id)!]);
  assert.equal(report.progress?.code, "budget-exhausted", "what the sender is told");
  assert.equal(report.progress?.retryAt, retryAt);
  const { sessions } = checkWakeBudget(node.paths, node.deps().policy, T0) as unknown as { sessions: { sessionId: string; nextAvailableAt: string }[] };
  assert.equal(sessions.find(s => s.sessionId === SESSION)?.nextAvailableAt, retryAt, "doctor and status agree");
  const text = await status(node, id);
  assert.match(text, /waiting\/budget-exhausted/);
  assert.ok(text.includes(`retry after ${retryAt}`), text);
  assert.deepEqual(fs.readFileSync(ledger(node)), before, "no turn is charged");
});

test("only a covered accepted message is held", t => {
  const node = heldNode(t);
  writeTask(node.paths, { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto", state: "running",
    startedAt: iso(T0), deadline: iso(T0 + 60_000), updatedAt: iso(T0), sessionId: SESSION }, T0);
  const covered = message(node, { taskId: TASK });
  const outside = message(node);
  const offered = message(node);
  markOffered(node.paths.inbox, offered, T0);
  observe(node);
  const held = getMessageProgress(node.paths.inbox, covered);
  assert.deepEqual([code(node, covered), code(node, outside), code(node, offered)],
    ["budget-exhausted", "budget-exhausted", "awaiting-turn-confirmation"]);
  // The live listener's scope now covers its task grant alone.
  writeJsonAtomic(listenerScope(node.paths, SESSION), { token: "live", listed: false, taskId: TASK });
  observe(node);
  assert.deepEqual([code(node, covered), code(node, outside), code(node, offered)],
    ["budget-exhausted", "awaiting-user-turn", "awaiting-turn-confirmation"]);
  assert.deepEqual(getMessageProgress(node.paths.inbox, covered), held, "an unchanged hold is not written again");
});

test("hold recovery cannot regress message state or charge a turn", async t => {
  const node = heldNode(t);
  const id = message(node);
  const first = fs.readFileSync(ledger(node));
  observe(node);
  const retryAt = getMessageProgress(node.paths.inbox, id)?.retryAt;
  assert.equal(code(node, id), "budget-exhausted", "the precondition");

  // The window released: the wake is pending again.
  node.tick(Date.parse(retryAt!) + 1 - T0);
  liveListener(node);
  observe(node);
  assert.equal(code(node, id), "wake-pending");
  assert.equal(getMessageProgress(node.paths.inbox, id)?.retryAt, undefined);

  // No live listener: no wake is pending, budget or not.
  node.tick(2_000);
  liveListener(node);
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "stale", pid: 2147483647, startedAt: ARMED_BEFORE_T0, event: "Stop" });
  observe(node);
  assert.equal(code(node, id), "awaiting-user-turn");
  assert.deepEqual(fs.readFileSync(ledger(node)), first);

  // An offered message is never shown as held, even with a full ledger.
  node.tick(2_000);
  liveListener(node);
  writeJsonAtomic(ledger(node), { turns: fullHour(clock(node)) });
  const full = fs.readFileSync(ledger(node));
  markOffered(node.paths.inbox, id, clock(node));
  observe(node);
  assert.equal(code(node, id), "awaiting-turn-confirmation");
  assert.match(await status(node, id), /waiting\/awaiting-turn-confirmation/);

  // A delivered message keeps its final state; its progress file is not written.
  const progress = path.join(node.paths.inbox, "progress", `${id}.json`);
  const last = fs.readFileSync(progress);
  markDelivered(node.paths.inbox, id);
  node.tick(2_000);
  liveListener(node);
  observe(node);
  assert.deepEqual(fs.readFileSync(progress), last);
  const text = await status(node, id);
  assert.ok(text.startsWith(`${id} delivered (received `), text);
  assert.equal(text.includes("budget-exhausted"), false);
  assert.deepEqual(fs.readFileSync(ledger(node)), full);
});

for (const [label, turns, ledgerStatus] of [["malformed", "x", "malformed"], ["future-dated", [T0 + 60_000], "future"]] as const) {
  test(`a ${label} ledger is neither a hold nor a clean wake`, async t => {
    const { inspectBudgetHold } = await import("./autonomy-budget.mts");
    const node = heldNode(t, turns);
    const id = message(node);
    assert.deepEqual(inspectBudgetHold(node.paths, SESSION, T0), { kind: "unknown", ledgerStatus });
    observe(node);
    assert.equal(code(node, id), "wake-pending");
    const check = checkWakeBudget(node.paths, node.deps().policy, T0) as unknown as { ok: boolean; sessions: { sessionId: string; ledgerStatus: string }[] };
    assert.equal(check.ok, false);
    assert.equal(check.sessions.find(s => s.sessionId === SESSION)?.ledgerStatus, ledgerStatus);
  });
}

test("a missing ledger is no hold: the listener's turn would be granted", async t => {
  const { inspectBudgetHold } = await import("./autonomy-budget.mts");
  const node = heldNode(t, null);
  const id = message(node);
  assert.deepEqual(inspectBudgetHold(node.paths, SESSION, T0), { kind: "available" });
  observe(node);
  assert.equal(code(node, id), "wake-pending");
  assert.equal(fs.existsSync(ledger(node)), false);
});
