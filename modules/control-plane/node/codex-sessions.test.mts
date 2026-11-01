import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_ACTIVE_MS, CODEX_IDLE_AFTER_MS, CODEX_RETENTION_MS, codexSessionName, codexSessionRefs, idleEvidence, isCodexSession,
  listCodexSessions, listCodexTaskSessions, markStopEnded, readCodexSession, recordCodexSession, refreshCodexEvent,
  type CodexSessionRecord,
} from "./codex-sessions.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { readLocalSessions, recordingSessions, writeLocalSessions } from "./exchange.mts";
import { getMessage, readJson, storeMessage, UNDELIVERABLE_AFTER_MS } from "./inbox.mts";
import { listSessions } from "./sessions.mts";
import { writeTask, type TaskRecord } from "./task-records.mts";

const CODEX = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const NOW = Date.UTC(2026, 8, 25, 12);

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

const file = (paths: NodePaths, id: string): string => path.join(paths.codexSessions, `${id}.json`);

test("records a Codex session in a private file and refreshes lastSeen on every call", (t) => {
  const paths = setup(t);
  recordCodexSession(paths, CODEX, "/work/repo", NOW);
  assert.deepEqual(readJson(file(paths, CODEX)), { sessionId: CODEX, cwd: "/work/repo", lastSeen: new Date(NOW).toISOString(), runtime: "codex" });
  if (process.platform !== "win32") assert.equal(fs.statSync(file(paths, CODEX)).mode & 0o777, 0o600);
  recordCodexSession(paths, CODEX, "bad\u0007cwd", NOW + 1000);
  assert.deepEqual(readJson(file(paths, CODEX)), { sessionId: CODEX, lastSeen: new Date(NOW + 1000).toISOString(), runtime: "codex" });
  assert.equal(isCodexSession(paths, CODEX), true);
  assert.equal(isCodexSession(paths, "other"), false);
  for (const bad of ["", "../escape", "a/b", ".hidden", "x".repeat(129)]) assert.throws(() => recordCodexSession(paths, bad, "/", NOW));
  assert.deepEqual(fs.readdirSync(paths.codexSessions), [`${CODEX}.json`]);
});

test("lists Codex sessions seen within the window, skips older ones and prunes those past retention", (t) => {
  const paths = setup(t);
  assert.deepEqual(listCodexSessions(paths, NOW), [], "no directory is no sessions");
  recordCodexSession(paths, CODEX, "/work/repo", NOW - CODEX_ACTIVE_MS + 1);
  recordCodexSession(paths, "thr_idle", undefined, NOW - CODEX_ACTIVE_MS - 1);
  recordCodexSession(paths, "thr_old", undefined, NOW - CODEX_RETENTION_MS - 1);
  fs.writeFileSync(file(paths, "thr_forged"), JSON.stringify({ sessionId: "thr_other", lastSeen: new Date(NOW).toISOString() }));
  assert.deepEqual(listCodexSessions(paths, NOW), [
    { sessionId: CODEX, runtime: "codex", state: "reachable-probable", name: "codex-89abcdef", cwd: "/work/repo", kind: "codex" },
  ]);
  assert.equal(codexSessionName(CODEX), "codex-89abcdef");
  assert.equal(fs.existsSync(file(paths, "thr_old")), false, "pruned after 7 days");
  assert.equal(fs.existsSync(file(paths, "thr_idle")), true, "kept until retention ends");
  assert.deepEqual(listCodexSessions(paths, NOW, 2 * CODEX_ACTIVE_MS).map((s) => s.sessionId), [CODEX, "thr_idle"]);
});

test("the daemon listing adds Codex sessions, and the undeliverable check keeps their messages", async (t) => {
  const paths = setup(t);
  recordCodexSession(paths, CODEX, "/work/repo", NOW);
  const claude = [{ sessionId: "s-1", status: "idle", name: "review" }];
  const list = () => listSessions({ paths, now: () => NOW, findClaude: () => "/bin/claude", exec: async () => JSON.stringify(claude) });
  assert.deepEqual((await list()).map((s) => [s.sessionId, s.runtime, s.name]), [["s-1", "claude-code", "review"], [CODEX, "codex", "codex-89abcdef"]]);
  assert.deepEqual((await listSessions({ paths, now: () => NOW, findClaude: () => null })).map((s) => s.sessionId), [CODEX]);
  await assert.rejects(listSessions({ paths, now: () => NOW, findClaude: () => "/bin/claude", exec: async () => { throw new Error("boom"); } }));

  const received = NOW - UNDELIVERABLE_AFTER_MS - 1;
  const ids = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000a3"];
  ids.forEach((messageId, n) => storeMessage(paths.inbox, { messageId, from: { nodeId: "00000000-0000-4000-8000-0000000000cc", session: "b" },
    toSession: [CODEX, "codex-89abcdef", "gone"][n], text: "hi", createdAt: new Date(0).toISOString() }, received));
  await recordingSessions(paths, list, () => {}, () => NOW)();
  assert.deepEqual(ids.map((id) => getMessage(paths.inbox, id)?.state), ["accepted", "accepted", "accepted"]);
  assert.deepEqual(readLocalSessions(paths).map((s) => s.name), ["review", "codex-89abcdef"]);
});

test("codex names use the random tail of the id; a name two live sessions share addresses neither", (t) => {
  const paths = nodePaths(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-names-")));
  t.after(() => fs.rmSync(path.dirname(paths.dir), { recursive: true, force: true }));
  writeLocalSessions(paths, [], NOW);
  // Two UUIDv7 thread ids started in the same minute share their first 8 characters.
  const A = "01a0db01-0000-7000-8000-00000000aaaa";
  const B = "01a0db01-1111-7000-8000-00000000bbbb";
  assert.equal(codexSessionName(A), "codex-0000aaaa");
  recordCodexSession(paths, A, "/w", NOW);
  assert.deepEqual(codexSessionRefs(paths, A, NOW), { refs: [A, "codex-0000aaaa", "codex-01a0db01"], ambiguous: [] }, "legacy name while unique");
  recordCodexSession(paths, B, "/w", NOW);
  assert.deepEqual(codexSessionRefs(paths, A, NOW), { refs: [A, "codex-0000aaaa"], ambiguous: ["codex-01a0db01"] });
  assert.deepEqual(codexSessionRefs(paths, B, NOW), { refs: [B, "codex-0000bbbb"], ambiguous: ["codex-01a0db01"] });
});

test("Codex aliases defer to exact all-runtime ids and reject cross-runtime name collisions", (t) => {
  const paths = setup(t);
  const sessionId = "01a0db01-0000-7000-8000-00000000aaaa";
  const alias = codexSessionName(sessionId);
  recordCodexSession(paths, sessionId, "/w", NOW);

  writeLocalSessions(paths, [
    { sessionId, runtime: "codex", state: "active", name: alias },
    { sessionId: "claude-one", runtime: "claude-code", state: "idle", name: alias },
  ], NOW);
  assert.deepEqual(codexSessionRefs(paths, sessionId, NOW),
    { refs: [sessionId, "codex-01a0db01"], ambiguous: [alias] });

  writeLocalSessions(paths, [
    { sessionId, runtime: "codex", state: "active", name: alias },
    { sessionId: alias, runtime: "claude-code", state: "idle", name: "claude-exact" },
  ], NOW);
  assert.deepEqual(codexSessionRefs(paths, sessionId, NOW),
    { refs: [sessionId, "codex-01a0db01"], ambiguous: [] }, "an exact id owns the generated alias");
});

test("Codex aliases fail closed when the all-runtime snapshot is missing or invalid", (t) => {
  const paths = setup(t);
  const sessionId = "01a0db01-0000-7000-8000-00000000aaaa";
  const aliases = [codexSessionName(sessionId), "codex-01a0db01"];
  recordCodexSession(paths, sessionId, "/w", NOW);

  assert.deepEqual(codexSessionRefs(paths, sessionId, NOW), { refs: [sessionId], ambiguous: aliases });

  fs.writeFileSync(paths.sessions, JSON.stringify({ sessions: "unknown" }));
  assert.deepEqual(codexSessionRefs(paths, sessionId, NOW), { refs: [sessionId], ambiguous: aliases });

  for (const sessions of [
    [{ sessionId: "", runtime: "codex", state: "active" }],
    [{ sessionId: "other", runtime: "", state: "active" }],
    [{ sessionId: "other", runtime: "claude-code", state: "idle", name: "bad\nname" }],
  ]) {
    fs.writeFileSync(paths.sessions, JSON.stringify({ sessions }));
    assert.deepEqual(codexSessionRefs(paths, sessionId, NOW), { refs: [sessionId], ambiguous: aliases });
  }

  fs.writeFileSync(paths.sessions, "{");
  assert.deepEqual(codexSessionRefs(paths, sessionId, NOW), { refs: [sessionId], ambiguous: aliases });
});

test("a Codex intercom run is listed with its own kind, a requested task as codex-task (issue #198)", (t) => {
  const paths = setup(t);
  const task = (n: number, sessionId: string, local?: TaskRecord["local"]): TaskRecord => ({
    taskId: `00000000-0000-4000-8000-00000000000${n}`, runtime: "codex", name: `task-0000000${n}`, cwd: "/w", permissionMode: "auto",
    state: "running", startedAt: new Date(NOW).toISOString(), deadline: new Date(NOW + 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(), sessionId, ...(local ? { local } : {}) });
  writeTask(paths, task(1, "019a0000-0000-7000-8000-000000000001"), NOW);
  writeTask(paths, task(2, "019a0000-0000-7000-8000-000000000002", "intercom"), NOW);
  writeTask(paths, task(3, "019a0000-0000-7000-8000-000000000003", "resume"), NOW);
  assert.deepEqual(listCodexTaskSessions(paths, NOW).map((s) => [s.name, s.kind]),
    [["task-00000001", "codex-task"], ["task-00000002", "codex-intercom"], ["task-00000003", "codex-task"]]);
});

// Issue #408, PR 1: the hook event is idle evidence.
test("each hook event writes lastEvent and lastEventAt, Stop also lastStopAt, and an input without one keeps them", (t) => {
  const paths = setup(t);
  const at = (ms: number) => new Date(ms).toISOString();
  recordCodexSession(paths, CODEX, "/work/repo", NOW, "default", "SessionStart");
  assert.deepEqual(readJson(file(paths, CODEX)), { sessionId: CODEX, cwd: "/work/repo", lastSeen: at(NOW), runtime: "codex",
    permissionMode: "default", lastEvent: "SessionStart", lastEventAt: at(NOW) });
  recordCodexSession(paths, CODEX, "/work/repo", NOW + 1000, undefined, "UserPromptSubmit");
  assert.deepEqual([readCodexSession(paths, CODEX)?.lastEvent, readCodexSession(paths, CODEX)?.lastEventAt,
    readCodexSession(paths, CODEX)?.lastStopAt], ["UserPromptSubmit", at(NOW + 1000), undefined]);
  recordCodexSession(paths, CODEX, "/work/repo", NOW + 2000, undefined, "Stop");
  assert.deepEqual(readCodexSession(paths, CODEX), { sessionId: CODEX, cwd: "/work/repo", lastSeen: at(NOW + 2000), runtime: "codex",
    permissionMode: "default", lastEvent: "Stop", lastEventAt: at(NOW + 2000), lastStopAt: at(NOW + 2000) });
  for (const event of [undefined, "Notification", 7]) {
    recordCodexSession(paths, CODEX, "/work/repo", NOW + 3000, undefined, event);
    const record = readCodexSession(paths, CODEX);
    assert.deepEqual([record?.lastSeen, record?.lastEvent, record?.lastEventAt, record?.lastStopAt],
      [at(NOW + 3000), "Stop", at(NOW + 2000), at(NOW + 2000)], String(event));
  }
  recordCodexSession(paths, CODEX, "/work/repo", NOW + 4000, undefined, "UserPromptSubmit");
  assert.deepEqual([readCodexSession(paths, CODEX)?.lastEvent, readCodexSession(paths, CODEX)?.lastStopAt],
    ["UserPromptSubmit", at(NOW + 2000)], "a later event keeps the last Stop time");
});

test("a refresh changes only the event of an existing record and never creates one", (t) => {
  const paths = setup(t);
  assert.equal(refreshCodexEvent(paths, CODEX, "PostToolUse", NOW), false);
  assert.equal(fs.existsSync(file(paths, CODEX)), false, "no record is created");
  recordCodexSession(paths, CODEX, "/work/repo", NOW, "default", "Stop");
  const before = readCodexSession(paths, CODEX);
  assert.equal(refreshCodexEvent(paths, CODEX, "PostToolUse", NOW + 5000), true);
  assert.deepEqual(readCodexSession(paths, CODEX), { ...before, lastEvent: "PostToolUse", lastEventAt: new Date(NOW + 5000).toISOString() });
  fs.writeFileSync(file(paths, CODEX), JSON.stringify({ sessionId: "another", runtime: "codex", lastSeen: new Date(NOW).toISOString() }));
  assert.equal(refreshCodexEvent(paths, CODEX, "PostToolUse", NOW), false, "a record of another session is left alone");
  assert.equal(refreshCodexEvent(paths, "../escape", "PostToolUse", NOW), false);
});

test("idleEvidence: only an ended Stop at least idleAfterMs ago of a session seen within the active window is idle", () => {
  const stopAt = NOW - CODEX_IDLE_AFTER_MS;
  const stopped: CodexSessionRecord = { sessionId: CODEX, runtime: "codex", lastSeen: new Date(stopAt).toISOString(),
    lastEvent: "Stop", lastEventAt: new Date(stopAt).toISOString(), lastStopAt: new Date(stopAt).toISOString(), lastStopEnded: true };
  assert.equal(CODEX_IDLE_AFTER_MS, 90_000);
  assert.equal(idleEvidence(stopped, NOW), true, "a Stop exactly idleAfterMs ago");
  assert.equal(idleEvidence(null, NOW), false, "no record");
  const { lastEvent: _event, ...older } = stopped;
  assert.equal(idleEvidence(older, NOW), false, "a record without lastEvent is unknown");
  const { lastStopEnded: _ended, ...unmarked } = stopped;
  assert.equal(idleEvidence(unmarked, NOW), false, "a Stop not marked as ended is unknown");
  assert.equal(idleEvidence({ ...stopped, lastStopEnded: "yes" as unknown as true }, NOW), false, "only true marks a Stop as ended");
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"] as const) {
    assert.equal(idleEvidence({ ...stopped, lastEvent: event }, NOW), false, event);
  }
  assert.equal(idleEvidence({ ...stopped, lastStopAt: undefined }, NOW), false, "Stop without a stop time");
  assert.equal(idleEvidence({ ...stopped, lastStopAt: "not a time" }, NOW), false, "unreadable stop time");
  assert.equal(idleEvidence(stopped, NOW - 1), false, "stopped less than idleAfterMs ago");
  assert.equal(idleEvidence(stopped, NOW, CODEX_IDLE_AFTER_MS + 1), false, "a longer idle threshold");
  assert.equal(idleEvidence(stopped, NOW + 60_000, 120_000), true, "a policy threshold within bounds");
  for (const bad of [29_999, 3_600_001, Number.NaN, 90_000.5]) assert.equal(idleEvidence(stopped, NOW, bad), false, `threshold ${bad}`);
  assert.equal(idleEvidence(stopped, NOW + 3_600_000, 3_600_000), true, "the upper bound");
  assert.equal(idleEvidence({ ...stopped, lastStopAt: new Date(NOW - 30_000).toISOString() }, NOW, 30_000), true, "the lower bound");
  assert.equal(idleEvidence(stopped, stopAt + CODEX_ACTIVE_MS), true, "seen exactly at the end of the active window");
  assert.equal(idleEvidence(stopped, stopAt + CODEX_ACTIVE_MS + 1), false, "not seen within the active window");
  assert.equal(idleEvidence({ ...stopped, lastSeen: "not a time" }, NOW), false, "unreadable lastSeen");
});

// Fable review of PR 1, point 1, and of PR 2, M1: a Stop is idle evidence
// only once the hook marks it as ended, so a failed mark or a blocking
// continuation leaves it unknown. Every hook event clears the mark.
test("a Stop is idle only once marked as ended, and every hook event clears the mark", (t) => {
  const paths = setup(t);
  const later = NOW + 10 * CODEX_IDLE_AFTER_MS;
  assert.equal(markStopEnded(paths, CODEX), false, "no record to mark");
  assert.equal(fs.existsSync(file(paths, CODEX)), false, "no record is created");
  recordCodexSession(paths, CODEX, "/work/repo", NOW, "default", "Stop");
  assert.equal(readCodexSession(paths, CODEX)?.lastStopEnded, undefined, "a Stop starts without the mark");
  assert.equal(idleEvidence(readCodexSession(paths, CODEX), later), false, "an unmarked Stop is not idle");
  assert.equal(markStopEnded(paths, CODEX), true);
  assert.equal(readCodexSession(paths, CODEX)?.lastStopEnded, true);
  assert.equal(idleEvidence(readCodexSession(paths, CODEX), later), true, "an ended Stop is idle");
  recordCodexSession(paths, CODEX, "/work/repo", NOW + 1000, undefined, undefined);
  assert.equal(readCodexSession(paths, CODEX)?.lastStopEnded, true, "an input without an event keeps it");
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"] as const) {
    markStopEnded(paths, CODEX);
    recordCodexSession(paths, CODEX, "/work/repo", NOW + 2000, undefined, event);
    assert.equal(readCodexSession(paths, CODEX)?.lastStopEnded, undefined, `${event} clears it`);
  }
  markStopEnded(paths, CODEX);
  assert.equal(refreshCodexEvent(paths, CODEX, "PostToolUse", NOW + 3000), true);
  assert.equal(readCodexSession(paths, CODEX)?.lastStopEnded, undefined, "a PostToolUse refresh clears it");
  assert.equal(markStopEnded(paths, "../escape"), false);
});

// Fable review of PR 2, L4: a refresh replaces the event fields as a whole, so
// it clears exactly what recordCodexSession clears for the same event.
test("a refresh clears the event fields its event clears, as recordCodexSession does", (t) => {
  const paths = setup(t);
  recordCodexSession(paths, CODEX, "/work/repo", NOW, "default", "Stop");
  markStopEnded(paths, CODEX);
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const) {
    markStopEnded(paths, CODEX);
    const before = readCodexSession(paths, CODEX)!;
    refreshCodexEvent(paths, CODEX, event, NOW + 1000);
    const refreshed = readCodexSession(paths, CODEX);
    fs.writeFileSync(file(paths, CODEX), JSON.stringify(before));
    recordCodexSession(paths, CODEX, before.cwd, NOW + 1000, undefined, event);
    assert.deepEqual({ ...refreshed, lastSeen: undefined }, { ...readCodexSession(paths, CODEX), lastSeen: undefined }, event);
    assert.equal(refreshed?.lastStopEnded, undefined, event);
  }
});
