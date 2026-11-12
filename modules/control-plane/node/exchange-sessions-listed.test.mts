import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { readLocalSessions, recordingSessions } from "./exchange-sessions.mts";
import { readJson } from "./inbox.mts";
import { markUnseen } from "./known-sessions.mts";

// Issue #883: sessions.json records per Claude row whether a complete `claude agents` listing contained it.

const NOW = Date.UTC(2026, 10, 12), MINUTE = 60_000;
const CLAUDE = "8e1f0000-0000-4000-8000-000000000883", OTHER = "8e1f0000-0000-4000-8000-000000000884";
const row = (sessionId: string): SessionInfo => ({ sessionId, runtime: "claude-code", state: "idle", kind: "interactive" });

function node(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-883-listed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  return paths;
}
const round = (paths: NodePaths, at: number, rows: SessionInfo[], unseen: string[] = []): Promise<SessionInfo[]> =>
  recordingSessions(paths, async () => markUnseen(rows.map(r => ({ ...r })), unseen), () => {}, () => at)();
const file = (paths: NodePaths) => readJson<{ sessions: Record<string, unknown>[] }>(paths.sessions)!.sessions;

test("listed is written for Claude rows of a complete listing and turns false on a carried row", async (t) => {
  const paths = node(t);
  const first = await round(paths, NOW, [row(CLAUDE), row(OTHER), { sessionId: "codex-1", runtime: "codex", state: "idle" }]);
  assert.deepEqual(file(paths).map(s => [s.sessionId, s.listed]), [[CLAUDE, true], [OTHER, true], ["codex-1", undefined]]);
  assert.ok(first.every(s => !Object.hasOwn(s, "listed")), "the published listing carries no listed field");

  const second = await round(paths, NOW + MINUTE, [row(OTHER)]);
  assert.deepEqual(file(paths).map(s => [s.sessionId, s.listed]), [[OTHER, true], [CLAUDE, false], ["codex-1", undefined]]);
  assert.ok(second.every(s => !Object.hasOwn(s, "listed")), "a carried row does not put listed on the wire");
  assert.deepEqual(readLocalSessions(paths, NOW + MINUTE).map(s => [s.sessionId, s.listed]), [[OTHER, true], [CLAUDE, false], ["codex-1", undefined]]);

  // A carried row stays carried and keeps saying it is not listed.
  await round(paths, NOW + 2 * MINUTE, [row(OTHER)]);
  assert.equal(readLocalSessions(paths, NOW + 2 * MINUTE).find(s => s.sessionId === CLAUDE)?.listed, false);
  // Listed again once the listing contains it.
  await round(paths, NOW + 3 * MINUTE, [row(OTHER), row(CLAUDE)]);
  assert.equal(readLocalSessions(paths, NOW + 3 * MINUTE).find(s => s.sessionId === CLAUDE)?.listed, true);
});

test("an incomplete Claude listing writes no listed value", async (t) => {
  for (const unseen of [["claude-code"], ["*"]]) await t.test(`unseen ${unseen}`, async (sub) => {
    const paths = node(sub);
    await round(paths, NOW, [row(CLAUDE), row(OTHER)]);
    await round(paths, NOW + MINUTE, [row(OTHER)], unseen);
    assert.ok(file(paths).every(s => !Object.hasOwn(s, "listed")), JSON.stringify(file(paths)));
    assert.ok(readLocalSessions(paths, NOW + MINUTE).every(s => s.listed === undefined));
  });
});

test("readLocalSessions drops listed from a file older than three minutes or with a malformed value", async (t) => {
  const paths = node(t);
  await round(paths, NOW, [row(CLAUDE)]);
  assert.equal(readLocalSessions(paths, NOW + 3 * MINUTE)[0].listed, true);
  assert.equal(readLocalSessions(paths, NOW + 3 * MINUTE + 1)[0].listed, undefined);
  const value = readJson<Record<string, unknown>>(paths.sessions)!;
  fs.writeFileSync(paths.sessions, JSON.stringify({ ...value, sessions: [{ ...file(paths)[0], listed: "no" }] }));
  assert.equal(Object.hasOwn(readLocalSessions(paths, NOW)[0], "listed"), false);
});
