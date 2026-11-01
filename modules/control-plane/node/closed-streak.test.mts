import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { recordingSessions } from "./exchange.mts";
import {
  CLOSED_AFTER_MISSES, CLOSED_MIN_AGE_MS, closedSession, KNOWN_RETENTION_MS, knownSessionsFile, readKnownSessions, rememberSessions,
} from "./known-sessions.mts";
import { listSessions } from "./sessions.mts";

// #706: miss/min-age remains a diagnostic and an independent baseline veto.
// It cannot prove closure without fresh complete exact native absence metadata.
// Reset, retention and per-runtime completeness behavior remain covered below.

const S = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
const CODEX = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const T = Date.UTC(2026, 9, 12, 12);
const MINUTE = 60_000;
const session: SessionInfo = { sessionId: S, runtime: "claude-code", state: "idle", name: "review" };

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-closed-streak-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  rememberSessions(paths, [session], T);
  return paths;
}

// Successful listings without the session, one per entry of at.
const miss = (paths: NodePaths, ...at: number[]) => { for (const when of at) rememberSessions(paths, [], when); };

test("the minimum age keeps N listings within one periodic cycle apart (issue #389)", () => {
  assert.equal(CLOSED_AFTER_MISSES, 3);
  assert.ok(CLOSED_MIN_AGE_MS > SESSIONS_INTERVAL_MS, "a burst of listings cannot close a session");
  assert.ok(CLOSED_MIN_AGE_MS < (CLOSED_AFTER_MISSES - 1) * SESSIONS_INTERVAL_MS, "N periodic listings do");
});

test("even N periodic misses do not prove closure without positive metadata (#706)", (t) => {
  const paths = setup(t);
  miss(paths, T + MINUTE, T + 2 * MINUTE);
  assert.equal(closedSession(paths, S), false);
  assert.deepEqual(readKnownSessions(paths).map((s) => [s.misses, s.missedSince, s.lastSeen]),
    [[2, new Date(T + MINUTE).toISOString(), new Date(T).toISOString()]]);
  miss(paths, T + 3 * MINUTE);
  assert.equal(closedSession(paths, S), false, "#706: misses alone never prove closed");
  assert.equal(closedSession(paths, "never-listed"), false, "a session this node never listed has no streak");
});

test("N misses in less than the minimum age do not close a session (issue #389)", (t) => {
  const paths = setup(t);
  miss(paths, T + 1_000, T + 2_000, T + 3_000, T + 4_000);
  assert.equal(closedSession(paths, S), false);
  miss(paths, T + 1_000 + CLOSED_MIN_AGE_MS - 1);
  assert.equal(closedSession(paths, S), false);
  miss(paths, T + 1_000 + CLOSED_MIN_AGE_MS);
  assert.equal(closedSession(paths, S), false, "#706: misses alone never prove closed");
});

test("a listing that shows the session resets its streak (issue #389)", (t) => {
  const paths = setup(t);
  miss(paths, T + MINUTE, T + 2 * MINUTE);
  rememberSessions(paths, [session], T + 3 * MINUTE);
  const [entry] = readKnownSessions(paths);
  assert.deepEqual([entry.misses, entry.missedSince, entry.missedAt], [undefined, undefined, undefined]);
  miss(paths, T + 4 * MINUTE, T + 5 * MINUTE);
  assert.equal(closedSession(paths, S), false);
  miss(paths, T + 6 * MINUTE);
  assert.equal(closedSession(paths, S), false, "#706: misses alone never prove closed");
});

test("a failed listing counts no miss, and the streak survives a new recorder (daemon restart) (issue #389)", async (t) => {
  const paths = setup(t);
  let clock = T;
  let fail = false;
  const list = async (): Promise<SessionInfo[]> => {
    if (fail) throw new Error("claude agents failed");
    return [];
  };
  const record = () => recordingSessions(paths, list, () => {}, () => clock);
  const first = record();
  clock += MINUTE;
  await first();
  clock += MINUTE;
  await first();
  fail = true;
  for (let i = 0; i < 5; i++) {
    clock += MINUTE;
    await assert.rejects(first(), /claude agents failed/);
  }
  assert.equal(readKnownSessions(paths)[0].misses, 2, "failed listings counted nothing");
  assert.equal(closedSession(paths, S), false);
  // A new daemon reads the same file.
  fail = false;
  const second = record();
  clock += MINUTE;
  await second();
  assert.equal(readKnownSessions(paths)[0].misses, 3);
  assert.equal(closedSession(paths, S), false, "#706: misses alone never prove closed");
  const stored = JSON.parse(fs.readFileSync(knownSessionsFile(paths), "utf8")) as { sessions: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(stored.sessions[0]).sort(), ["lastSeen", "missedAt", "missedSince", "misses", "name", "runtime", "sessionId"]);
});

test("a listing without claude on PATH counts no miss for Claude sessions, only for Codex ones (issue #389)", async (t) => {
  const paths = setup(t);
  rememberSessions(paths, [session, { sessionId: CODEX, runtime: "codex", state: "idle" }], T);
  let clock = T;
  const record = recordingSessions(paths, (signal) => listSessions({ paths, findClaude: () => null, now: () => clock, signal }),
    () => {}, () => clock);
  for (let i = 1; i <= CLOSED_AFTER_MISSES; i++) {
    clock = T + i * MINUTE;
    await record();
  }
  assert.equal(closedSession(paths, S), false, "a runtime the listing could not see is not missing");
  assert.equal(readKnownSessions(paths).find((s) => s.sessionId === S)?.misses, undefined);
  assert.equal(closedSession(paths, CODEX), false, "#706: Codex misses alone are not closure evidence");
  // An unseen runtime "*" (a listing at its cap) counts no miss for any session.
  rememberSessions(paths, [], T + 10 * MINUTE, ["*"]);
  assert.equal(readKnownSessions(paths).find((s) => s.sessionId === CODEX)?.misses, CLOSED_AFTER_MISSES);
});

test("a listing that shows a session through claude resets the streak a Claude-less listing kept (issue #389)", async (t) => {
  const paths = setup(t);
  miss(paths, T + MINUTE, T + 2 * MINUTE);
  rememberSessions(paths, [], T + 3 * MINUTE, ["claude-code"]);
  assert.equal(readKnownSessions(paths)[0].misses, 2, "kept, neither counted nor reset");
  const rows = [{ sessionId: S, status: "idle", name: "review" }];
  const record = recordingSessions(paths, () => listSessions({ paths, findClaude: () => "/opt/bin/claude",
    exec: async () => JSON.stringify(rows), now: () => T + 4 * MINUTE }), () => {}, () => T + 4 * MINUTE);
  await record();
  assert.equal(readKnownSessions(paths)[0].misses, undefined);
});

test("the streak is pruned with its known session (issue #389)", (t) => {
  const paths = setup(t);
  miss(paths, T + MINUTE, T + 2 * MINUTE, T + 3 * MINUTE);
  assert.equal(closedSession(paths, S), false, "#706: misses alone never prove closed");
  miss(paths, T + KNOWN_RETENTION_MS + 1);
  assert.deepEqual(readKnownSessions(paths), []);
  assert.equal(closedSession(paths, S), false);
});
