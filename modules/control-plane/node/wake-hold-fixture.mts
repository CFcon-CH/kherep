import assert from "node:assert/strict";
import path from "node:path";
import type test from "node:test";

import { listenerDir, listenerLock, listenerScope, type ListenerLock } from "./autonomy.mts";
import { ensureDir } from "./config.mts";
import { observeClaudeDeliveryProgress } from "./delivery-progress.mts";
import { getMessageProgress, storeMessage, writeJsonAtomic } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";
import { DEFAULT_TURN_BUDGET } from "./policy.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { WAKE_GRACE_MS } from "./wake-pending.mts";

// Issue #827: a synthetic node directory, a fake clock and this process as the
// live listener, for the tests of the budget hold and of the listener's selection.

export const SESSION = "8e1f0000-0000-4000-8000-000000000827";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" };
const ROW = { sessionId: SESSION, runtime: "claude-code", state: "idle-loaded", name: "review" };
export const iso = (ms: number): string => new Date(ms).toISOString();
let sequence = 0;

export type Node = ReturnType<typeof taskNode>;
export const clock = (node: Node): number => node.deps().now!();
export const ledger = (node: Node): string => path.join(listenerDir(node.paths), `${SESSION}.turns.json`);
export const code = (node: Node, id: string): string | undefined => getMessageProgress(node.paths.inbox, id)?.code;
// Sixty seconds apart, so that no test depends on the spacing of turns.
export const fullHour = (now: number): number[] => Array.from({ length: DEFAULT_TURN_BUDGET.perHour }, (_, i) => now - (i + 1) * 60_000);
// Armed before the message at T0 by more than the grace period: the listener selects that message.
export const ARMED_BEFORE_T0 = T0 - WAKE_GRACE_MS - 1_000;

// Armed by default before the messages at T0.
export function liveListener(node: Node, lock: Partial<ListenerLock> = {}): void {
  ensureDir(listenerDir(node.paths));
  publishSynthetic(node.paths, [fixtureEvidence(ROW, "idle-loaded", clock(node))], clock(node), [ROW]);
  writeJsonAtomic(listenerLock(node.paths, SESSION), { token: "live", pid: process.pid, startedAt: ARMED_BEFORE_T0, event: "Stop", ...lock });
  writeJsonAtomic(listenerScope(node.paths, SESSION), { token: "live", listed: true });
}

export function message(node: Node, extra: { taskId?: string; depth?: number; receivedAt?: number } = {}): string {
  const messageId = `d827${(++sequence).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;
  storeMessage(node.paths.inbox, { messageId, from: PEER, toSession: "review", text: "private",
    createdAt: iso(T0), ...(extra.taskId ? { taskId: extra.taskId } : {}) }, extra.receivedAt ?? T0, extra.depth ?? 0);
  return messageId;
}

export function heldNode(t: test.TestContext, stamps: unknown = fullHour(T0), wake: Record<string, unknown> = {}) {
  const node = taskNode(t, {}, { wake: { enabled: true, sessions: [SESSION], ...wake } });
  liveListener(node);
  if (stamps !== null) writeJsonAtomic(ledger(node), { turns: stamps });
  return node;
}

export const observe = (node: Node): void => observeClaudeDeliveryProgress(node.deps());

export async function status(node: Node, id: string): Promise<string> {
  const lines: string[] = [];
  assert.equal(await runMsg(["status", id], { paths: node.paths, env: {}, now: () => clock(node), out: line => lines.push(line),
    err: line => assert.fail(line) }), 0);
  return lines.join("\n");
}
