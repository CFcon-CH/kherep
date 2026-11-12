import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { observeClaudeDeliveryProgress } from "./delivery-progress.mts";
import { connectionClaudeHooks, readLocalSessions, recordingSessions } from "./exchange-sessions.mts";
import { getMessageProgress, storeMessage } from "./inbox.mts";
import { markUnseen } from "./known-sessions.mts";
import { T0, taskNode } from "./task-fixture.mts";

// Issue #883 stage 1: an accepted message for a Claude session without a running process reads target-not-loaded
// instead of target-not-idle. The progress code stays target-busy. Nothing else changes.

const SESSION = "8e1f0000-0000-4000-8000-000000000883";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" };
const MESSAGE = "d1380883-0000-4000-8000-000000000000";
const MINUTE = 60_000;
const ROW: SessionInfo = { sessionId: SESSION, runtime: "claude-code", state: "idle", name: "review", kind: "interactive" };
type Node = ReturnType<typeof taskNode>;

function listing(node: Node, rows: SessionInfo[], unseen: string[] = []): Promise<SessionInfo[]> {
  const at = node.deps().now!();
  return recordingSessions(node.paths, async () => markUnseen(rows.map(r => ({ ...r })), unseen), () => {}, () => at)();
}
function setup(t: test.TestContext, toSession = "review"): Node {
  const node = taskNode(t);
  storeMessage(node.paths.inbox, { messageId: MESSAGE, from: PEER, toSession, text: "private", createdAt: new Date(T0).toISOString() }, T0);
  return node;
}
function observed(node: Node): { code?: string; diagnostic?: { code: string; observedState?: string } } {
  observeClaudeDeliveryProgress(node.deps());
  const file = path.join(node.paths.inbox, "progress", `${MESSAGE}.json`);
  return { code: getMessageProgress(node.paths.inbox, MESSAGE)?.code, diagnostic: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).diagnostic : undefined };
}

test("a session in a complete Claude listing whose state is unknown keeps target-not-idle", async (t) => {
  const node = setup(t);
  await listing(node, [ROW]);
  assert.equal(readLocalSessions(node.paths, T0)[0].listed, true);
  const result = observed(node);
  assert.equal(result.code, "target-busy");
  assert.equal(result.diagnostic?.code, "target-not-idle");
});

test("a carried row absent from a complete Claude listing reads target-not-loaded; the progress code stays target-busy", async (t) => {
  const node = setup(t);
  await listing(node, [ROW]);
  node.tick(MINUTE);
  await listing(node, []);
  assert.deepEqual(readLocalSessions(node.paths, T0 + MINUTE).map(s => [s.sessionId, s.listed, s.state]), [[SESSION, false, "unknown"]]);
  const result = observed(node);
  assert.equal(result.code, "target-busy");
  assert.deepEqual([result.diagnostic?.code, result.diagnostic?.observedState], ["target-not-loaded", "unknown"]);
  // Opening the session lists it again: back to the old code at the next listing.
  node.tick(MINUTE);
  await listing(node, [ROW]);
  assert.equal(observed(node).diagnostic?.code, "target-not-idle");
});

test("an incomplete or failed Claude listing keeps target-not-idle", async (t) => {
  for (const unseen of [["claude-code"], ["*"]]) await t.test(`unseen ${unseen}`, async (sub) => {
    const node = setup(sub);
    await listing(node, [ROW]);
    node.tick(MINUTE);
    await listing(node, [], unseen);
    assert.equal(readLocalSessions(node.paths, T0 + MINUTE)[0].listed, undefined);
    assert.equal(observed(node).diagnostic?.code, "target-not-idle");
  });
  await t.test("failed listings after a complete absence", async (sub) => {
    const node = setup(sub);
    await listing(node, [ROW]);
    node.tick(MINUTE);
    await listing(node, []);
    assert.equal(observed(node).diagnostic?.code, "target-not-loaded");
    // A failed listing writes nothing; once the last complete one is older than three minutes it decides nothing.
    node.tick(MINUTE);
    await assert.rejects(recordingSessions(node.paths, async () => { throw new Error("claude agents failed"); }, () => {}, () => T0 + 2 * MINUTE)());
    assert.equal(observed(node).diagnostic?.code, "target-not-loaded", "within the freshness window");
    node.tick(2 * MINUTE + 1);
    assert.equal(readLocalSessions(node.paths, T0 + 4 * MINUTE + 1)[0].listed, undefined);
    assert.equal(observed(node).diagnostic?.code, "target-not-idle");
  });
});

test("a fresh hook observation is not target-not-loaded, even when the listing omits the session", async (t) => {
  const node = setup(t);
  await listing(node, [ROW]);
  node.tick(MINUTE);
  connectionClaudeHooks(node.paths).set(SESSION, { sessionId: SESSION, observedAt: T0 + MINUTE });
  await listing(node, []);
  const [row] = readLocalSessions(node.paths, T0 + MINUTE);
  assert.deepEqual([row.listed, row.state], [false, "reachable-probable"]);
  const result = observed(node);
  assert.equal(result.code, "target-busy");
  assert.equal(result.diagnostic?.code, "target-not-idle");
});

test("a Codex row carries no listed value and gets no Claude progress", async (t) => {
  const codex = "019a0000-0000-7000-8000-000000000883";
  const node = setup(t, codex);
  await listing(node, [{ sessionId: codex, runtime: "codex", state: "idle", kind: "codex" }]);
  node.tick(MINUTE);
  await listing(node, []);
  const [row] = readLocalSessions(node.paths, T0 + MINUTE);
  assert.deepEqual([row.sessionId, row.runtime, Object.hasOwn(row, "listed")], [codex, "codex", false]);
  assert.equal(observed(node).diagnostic, undefined);
});
