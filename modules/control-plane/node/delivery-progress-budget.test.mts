import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, listenerLock, listenerScope } from "./autonomy.mts";
import { ensureDir, nodePaths, type NodePaths } from "./config.mts";
import { observeClaudeDeliveryProgress } from "./delivery-progress.mts";
import { recordSent, writeOutbox } from "./exchange.mts";
import { getMessageProgress, storeMessage, unreportedStatuses, writeJsonAtomic } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";
import { T0, taskNode } from "./task-fixture.mts";

const SESSION = "8e1f0000-0000-4000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" };
const ID = "d1380000-0000-4000-8000-000000000827";
const HOUR = 3_600_000, DAY = 24 * HOUR;

// An idle listed Claude session with a live listed listener and one accepted message.
function held(t: test.TestContext, turns: number[] | null, wake: Record<string, unknown> = {}) {
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: [SESSION], ...wake } });
  const row = { sessionId: SESSION, runtime: "claude-code", state: "idle-loaded", name: "review" };
  publishSynthetic(node.paths, [fixtureEvidence(row, "idle-loaded", T0)], T0, [row]);
  storeMessage(node.paths.inbox, { messageId: ID, from: PEER, toSession: "review", text: "private", createdAt: new Date(T0).toISOString() }, T0);
  ensureDir(listenerDir(node.paths));
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "live", pid: process.pid, startedAt: T0, event: "Stop" });
  writeJsonAtomic(listenerScope(node.paths, SESSION), { token: "live", listed: true });
  const ledger = path.join(listenerDir(node.paths), `${SESSION}.turns.json`);
  if (turns) writeJsonAtomic(ledger, { turns });
  return { node, ledger };
}

test("#827 a message held by a full day window reports budget-exhausted with the release time", (t) => {
  const turns = Array.from({ length: 100 }, (_, i) => T0 - DAY + 60_000 + i * 60_000);
  const { node, ledger } = held(t, turns);
  const before = fs.readFileSync(ledger, "utf8");
  observeClaudeDeliveryProgress(node.deps());
  assert.deepEqual(getMessageProgress(node.paths.inbox, ID), { phase: "waiting", code: "budget-exhausted",
    observedAt: new Date(T0).toISOString(), retryAt: new Date(turns[0] + DAY).toISOString() });
  assert.equal(fs.readFileSync(ledger, "utf8"), before, "the observer spends and repairs nothing");
  assert.equal(fs.existsSync(`${ledger}.lock`), false, "the observer takes no budget lock");
});

test("#827 a full hour window under a configured limit reports the hourly release time", (t) => {
  const turns = [T0 - 50 * 60_000, T0 - 40 * 60_000];
  const { node } = held(t, turns, { budget: { perHour: 2 } });
  observeClaudeDeliveryProgress(node.deps());
  const progress = getMessageProgress(node.paths.inbox, ID);
  assert.equal(progress?.code, "budget-exhausted");
  assert.equal(progress?.retryAt, new Date(turns[0] + HOUR).toISOString());
});

test("#827 the hold ends with the window: the next observation reports wake-pending again", (t) => {
  const turns = [T0 - 50 * 60_000, T0 - 40 * 60_000];
  const { node } = held(t, turns, { budget: { perHour: 2 } });
  observeClaudeDeliveryProgress(node.deps());
  node.tick(11 * 60_000);
  const row = { sessionId: SESSION, runtime: "claude-code", state: "idle-loaded", name: "review" };
  publishSynthetic(node.paths, [fixtureEvidence(row, "idle-loaded", T0 + 11 * 60_000)], T0 + 11 * 60_000, [row]);
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "live", pid: process.pid, startedAt: T0 + 11 * 60_000, event: "Stop" });
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(getMessageProgress(node.paths.inbox, ID)?.code, "wake-pending");
});

test("#827 the sender's msg status names the target's budget and the next slot", async (t) => {
  const turns = Array.from({ length: 100 }, (_, i) => T0 - DAY + 60_000 + i * 60_000);
  const { node } = held(t, turns);
  observeClaudeDeliveryProgress(node.deps());
  const report = unreportedStatuses(node.paths.inbox, T0).find(r => r.messageId === ID)!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep 827 sender "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sender: NodePaths = nodePaths(root);
  writeOutbox(sender, { messageId: ID, fromSession: "peer", to: { nodeId: "00000000-0000-4000-8000-0000000000aa", session: "review" },
    text: "private", createdAt: new Date(T0).toISOString() });
  recordSent(sender, ID, report.state, undefined, T0, report.progress);
  const lines: string[] = [];
  assert.equal(await runMsg(["status", ID], { paths: sender, env: {}, now: () => T0, out: line => lines.push(line), err: line => assert.fail(line) }), 0);
  assert.match(lines[0], /accepted: the target's autonomous-turn budget is exhausted \[waiting\/budget-exhausted; /);
  assert.ok(lines[0].includes(`retry after ${new Date(turns[0] + DAY).toISOString()}`), lines[0]);
});

// Pins: these pass before and after the change.
test("pin #827 spacing, an unreadable ledger and a missing ledger stay wake-pending", (t) => {
  for (const [name, turns] of [["spacing", [T0 - 10_000]], ["missing", null]] as const) {
    const { node } = held(t, turns as number[] | null);
    observeClaudeDeliveryProgress(node.deps());
    assert.equal(getMessageProgress(node.paths.inbox, ID)?.code, "wake-pending", name);
  }
  const { node, ledger } = held(t, [1]);
  fs.writeFileSync(ledger, "invalid");
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(getMessageProgress(node.paths.inbox, ID)?.code, "wake-pending", "unknown budget claims no hold");
});

test("pin #827 without a live listener an exhausted owner still reads awaiting-user-turn", (t) => {
  const { node } = held(t, Array(100).fill(T0 - 2 * HOUR));
  fs.rmSync(listenerLock(node.paths, SESSION));
  observeClaudeDeliveryProgress(node.deps());
  assert.equal(getMessageProgress(node.paths.inbox, ID)?.code, "awaiting-user-turn");
});
