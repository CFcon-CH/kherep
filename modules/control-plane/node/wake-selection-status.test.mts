import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { evaluateTurnBudget } from "./autonomy-budget.mts";
import { checkWakeBudget } from "./doctor-wake-budget.mts";
import { getMessage, getMessageProgress, markClosedAttempt } from "./inbox.mts";
import { wakeBudget } from "./policy.mts";
import { T0 } from "./task-fixture.mts";
import { atReplyLimit, pending, rememberWoken, WAKE_BACKLOG_AFTER_MS } from "./wake-pending.mts";
import { code, heldNode, iso, ledger, liveListener, message, observe, SESSION, status, type Node } from "./wake-hold-fixture.mts";

// Issue #827: the daemon shows what the listener would do. A message the listener
// would not select waits for the next user turn, whatever the ledger says.

const retryAt = (node: Node, id: string): string | undefined => getMessageProgress(node.paths.inbox, id)?.retryAt;

test("a message the listener would not select is not held", async t => {
  const node = heldNode(t);
  liveListener(node, { startedAt: T0 });
  const id = message(node);
  const before = fs.readFileSync(ledger(node));
  observe(node);
  assert.equal(code(node, id), "awaiting-user-turn");
  assert.equal(retryAt(node, id), undefined);
  assert.equal((await status(node, id)).includes("budget-exhausted"), false);
  assert.deepEqual(fs.readFileSync(ledger(node)), before, "no turn is charged");
});

test("a message the listener would not select is not wake-pending without a ledger either", t => {
  const node = heldNode(t, null);
  liveListener(node, { startedAt: T0 });
  const id = message(node);
  observe(node);
  assert.equal(code(node, id), "awaiting-user-turn");
});

test("a SessionStart backlog is selected until woken for", t => {
  const node = heldNode(t);
  const lock = { event: "SessionStart", startedAt: T0 } as const;
  liveListener(node, lock);
  const id = message(node);
  observe(node);
  assert.equal(code(node, id), "budget-exhausted", "from the first round, inside the backlog window");
  assert.equal(typeof retryAt(node, id), "string");
  rememberWoken(node.paths, SESSION, [id]);
  observe(node);
  assert.equal(code(node, id), "awaiting-user-turn");
  const settled = getMessageProgress(node.paths.inbox, id);
  node.tick(WAKE_BACKLOG_AFTER_MS + 2_000);
  liveListener(node, lock);
  observe(node);
  assert.deepEqual(getMessageProgress(node.paths.inbox, id), settled, "no flap when the backlog window passes");
});

test("the daemon selects what the listener selects", async t => {
  const { listenerSelects } = await import("./wake-pending.mts");
  const node = heldNode(t, null);
  const after = T0 + 5_000;
  const early = message(node, { receivedAt: T0 - 60_000 });
  const late = message(node, { receivedAt: after });
  const deep = message(node, { receivedAt: after, depth: 6 });
  const readdressed = message(node, { receivedAt: T0 - 60_000 });
  markClosedAttempt(node.paths.inbox, readdressed, after, SESSION);
  const records = [early, late, deep, readdressed].map(id => getMessage(node.paths.inbox, id)!);
  const sorted = (ids: string[]): string[] => [...ids].sort((a, b) => a.localeCompare(b));
  const now = T0 + WAKE_BACKLOG_AFTER_MS + 10_000;
  const agree = (event: "Stop" | "SessionStart", woken: string[], expected: string[]): void => {
    const lock = { event, startedAt: T0 };
    const found = pending(node.paths, [SESSION, "review"], SESSION, lock, now);
    const wakes = [...found.fresh, ...found.backlog].filter(r => !atReplyLimit(r)).map(r => r.messageId);
    assert.deepEqual(sorted(wakes), sorted(expected), `the listener, ${event}`);
    assert.deepEqual(sorted(records.filter(r => listenerSelects(r, lock, woken)).map(r => r.messageId)), sorted(expected), `the daemon, ${event}`);
  };
  agree("Stop", [], [late, readdressed]);
  agree("SessionStart", [], [early, late, readdressed]);
  rememberWoken(node.paths, SESSION, [early]);
  agree("SessionStart", [early], [late, readdressed]);
  const { fresh } = pending(node.paths, [SESSION, "review"], SESSION, { event: "Stop", startedAt: T0 }, now);
  assert.ok(fresh.some(r => r.messageId === deep), "pending keeps a reply-limited record for the listener's depth-limit audit");
});

test("a covered reply-limited message shows the depth limit, not a release time", t => {
  const node = heldNode(t);
  const deep = message(node, { depth: 6 });
  const sibling = message(node);
  observe(node);
  assert.equal(code(node, deep), "reply-limit");
  assert.equal(retryAt(node, deep), undefined);
  assert.equal(code(node, sibling), "budget-exhausted");
});

test("the hold uses the policy's limits", t => {
  const stamps = [T0 - 120_000, T0 - 60_000];
  const node = heldNode(t, stamps, { budget: { perHour: 2 } });
  const id = message(node);
  observe(node);
  const limits = wakeBudget(node.deps().policy);
  const release = evaluateTurnBudget(stamps, limits, T0).nextAvailableAt!;
  assert.ok(Date.parse(release) > T0);
  assert.deepEqual(getMessageProgress(node.paths.inbox, id), { phase: "waiting", code: "budget-exhausted", observedAt: iso(T0), retryAt: release });
  const { sessions } = checkWakeBudget(node.paths, node.deps().policy, T0) as unknown as { sessions: { sessionId: string; nextAvailableAt: string }[] };
  assert.equal(sessions.find(s => s.sessionId === SESSION)?.nextAvailableAt, release, "doctor and status agree");
  const defaults = heldNode(t, stamps);
  const free = message(defaults);
  observe(defaults);
  assert.equal(code(defaults, free), "wake-pending", "the same stamps under the default limits hold nothing");
});
