import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, listenerScope, rememberMode } from "./autonomy.mts";
import { LISTING_FRESH_MS } from "./closed-delivery.mts";
import { closedNode, endedIntercom, SESSION } from "./closed-fixture.mts";
import type { NodePaths } from "./config.mts";
import { checkListeners } from "./doctor-local.mts";
import { readLocalSessions, writeLocalSessions } from "./exchange.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { KNOWN_RETENTION_MS, knownSessionsFile, markUnseen, rememberSessions } from "./known-sessions.mts";
import { PRUNE_MAX, pruneCandidates, pruneListenerState, STATE_RETENTION_MS } from "./listener-prune.mts";
import { sweepListeners } from "./listener-sweep.mts";
import { readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { setup, T0 } from "./wake-fixture.mts";

// Issue #474: the listener state files of a session that ended stay only while
// the node can still resume it; then the daemon's hourly pass removes them.

const DAY = 24 * 60 * 60_000;
const NOW = T0 + 30 * DAY;
const OLD = NOW - STATE_RETENTION_MS - 60_000;
const KINDS = ["mode", "turns", "scope", "stuck", "woke", "queued", "busy-hint", "busy-admission"];
const TASK = "7a5c0000-0000-4000-8000-000000000474";
const alive = (): boolean => false;

const dir = (paths: NodePaths): string => listenerDir(paths);
const age = (file: string, at: number): void => fs.utimesSync(file, at / 1000, at / 1000);
function put(paths: NodePaths, name: string, at: number = OLD, body: string = "{}"): string {
  fs.mkdirSync(dir(paths), { recursive: true });
  const file = path.join(dir(paths), name);
  fs.writeFileSync(file, name.includes(".turns.json") && body === "{}" ? '{"turns":[]}' : body);
  age(file, at);
  return file;
}
const names = (paths: NodePaths): string[] => fs.readdirSync(dir(paths)).sort();
const listed = (sessionId: string) => ({ sessionId, runtime: "claude-code", state: "idle" });
const task = (sessionId: string, state: TaskRecord["state"]): TaskRecord => ({ taskId: TASK, name: "task-7a5c0000", cwd: "/synthetic",
  permissionMode: "auto", state, startedAt: new Date(T0).toISOString(), deadline: new Date(NOW + DAY).toISOString(),
  updatedAt: new Date(T0).toISOString(), sessionId });

// A node at NOW whose fresh listing shows "listed" and whose known-sessions.json holds "known".
function node(t: test.TestContext): NodePaths {
  const { paths } = setup(t);
  rememberSessions(paths, [listed("known")], NOW - DAY);
  writeLocalSessions(paths, [listed("listed")], NOW);
  return paths;
}

test("the state files of a session the node no longer lists or knows go after the retention; a listing entry, a known entry, a lock, an in-flight lock, an active task or a young file keeps them", (t) => {
  const paths = node(t);
  const gone = KINDS.map((kind) => put(paths, `gone.${kind}.json`));
  for (const id of ["listed", "known", "locked", "delivering", "writing", "tasked", "young"]) put(paths, `${id}.mode.json`);
  put(paths, "young.turns.json", NOW - 60_000);
  put(paths, "locked.json", OLD, JSON.stringify({ token: "t", pid: 1001, startedAt: OLD, event: "Stop" }));
  put(paths, "delivering.deliver.lock");
  put(paths, `.writing.mode.json.${crypto.randomUUID()}.tmp`);
  writeTask(paths, task("tasked", "running"));
  put(paths, "odd.txt");
  put(paths, "x.json.bak");
  const before = names(paths).filter((name) => !name.startsWith("gone."));

  const candidates = pruneCandidates(paths, NOW);
  assert.ok(candidates instanceof Map);
  assert.deepEqual([...candidates.keys()], ["gone"]);
  assert.deepEqual(candidates.get("gone")?.sort(), gone.sort());
  assert.equal(checkListeners(paths, alive, NOW).orphaned, KINDS.length);
  assert.deepEqual(pruneListenerState(paths, { now: NOW }), { removed: KINDS.length, kept: 0, sessions: 1, failed: [] });
  assert.deepEqual(names(paths), before, "everything else stays, .queued.json of gone goes with the rest");
  assert.deepEqual(pruneCandidates(paths, NOW), new Map());
  assert.equal(checkListeners(paths, alive, NOW).orphaned, 0);
});

test("a stale, partial, missing or unreadable listing, or an unreadable known-sessions.json or task record, prunes nothing", (t) => {
  const cases: [string, (paths: NodePaths) => void][] = [
    ["listing-stale", (paths) => writeLocalSessions(paths, [], NOW - LISTING_FRESH_MS - 1)],
    ["listing-stale", (paths) => writeLocalSessions(paths, [], NOW + LISTING_FRESH_MS + 1)],
    ["listing-stale", (paths) => fs.rmSync(paths.sessions)],
    ["listing-partial", (paths) => writeLocalSessions(paths, markUnseen([], ["codex"]), NOW)],
    ["listing-unreadable", (paths) => fs.writeFileSync(paths.sessions, "{")],
    ["listing-unreadable", (paths) => fs.writeFileSync(paths.sessions, JSON.stringify({ sessions: [{ name: "no id" }], unseen: [],
      updatedAt: new Date(NOW).toISOString() }))],
    ["known-unreadable", (paths) => fs.writeFileSync(knownSessionsFile(paths), "{")],
    ["known-unreadable", (paths) => fs.writeFileSync(knownSessionsFile(paths), JSON.stringify({ sessions: [{ name: "no id" }] }))],
    ["tasks-unreadable", (paths) => { fs.mkdirSync(paths.tasks, { recursive: true }); fs.writeFileSync(path.join(paths.tasks, `${TASK}.json`), "{"); }],
  ];
  for (const [skipped, spoil] of cases) {
    const paths = node(t);
    put(paths, "gone.mode.json");
    spoil(paths);
    const before = names(paths);
    assert.deepEqual(pruneCandidates(paths, NOW), { skipped });
    assert.equal(checkListeners(paths, alive, NOW).orphaned, skipped);
    assert.deepEqual(pruneListenerState(paths, { now: NOW }), { skipped });
    assert.deepEqual(names(paths), before);
  }
  const paths = node(t);
  fs.writeFileSync(dir(paths), "not a directory");
  assert.deepEqual(pruneListenerState(paths, { now: NOW }), { skipped: "dir-unreadable" });
});

test("a file rewritten while the prune holds it aside is kept, with other or the same bytes, and an unfinished prune tombstone of any kind is linked back", (t) => {
  const paths = node(t);
  // The bytes rememberMode writes for "default".
  const body = `${JSON.stringify({ permissionMode: "default" }, null, 2)}\n`;
  const mode = put(paths, "gone.mode.json", OLD, body);
  const same = put(paths, "same.mode.json", OLD, body);
  put(paths, "gone.turns.json");
  const result = pruneListenerState(paths, { now: NOW, beforeTake: (file) => {
    if (file === mode) rememberMode(paths, "gone", "acceptEdits");
    // A resumed session remembering its unchanged mode: a new file with the same bytes.
    if (file === same) rememberMode(paths, "same", "default");
  } });
  assert.deepEqual(result, { removed: 0, kept: 3, sessions: 0, failed: [] });
  assert.deepEqual(names(paths), ["gone.mode.json", "gone.turns.json", "same.mode.json"], "the fresh sibling also retains the budget on its under-lock recheck");
  assert.deepEqual(JSON.parse(fs.readFileSync(mode, "utf8")), { permissionMode: "acceptEdits" });
  assert.equal(fs.readFileSync(same, "utf8"), body);
  assert.ok(Date.now() - fs.statSync(same).mtimeMs < STATE_RETENTION_MS, "the fresh file stays, not the old one");

  const tomb = put(paths, `.other.turns.json.${NOW - 2 * 60_000}-${crypto.randomUUID()}.tomb`, OLD, '{"turns":[]}');
  assert.deepEqual(sweepListeners(paths, { now: NOW }), { removed: 0, kept: 0, failed: [] });
  assert.equal(fs.existsSync(tomb), false);
  assert.equal(fs.readFileSync(path.join(dir(paths), "other.turns.json"), "utf8"), '{"turns":[]}');
});

test("a pass removes at most PRUNE_MAX files and the rest the next time", (t) => {
  const paths = node(t);
  const ids = Math.ceil((PRUNE_MAX + 1) / 2);
  for (let n = 0; n < ids; n++) for (const kind of ["mode", "turns"]) put(paths, `gone-${n}.${kind}.json`);
  const first = pruneListenerState(paths, { now: NOW });
  assert.ok(!("skipped" in first));
  assert.equal(first.removed, PRUNE_MAX);
  const second = pruneListenerState(paths, { now: NOW });
  assert.ok(!("skipped" in second));
  assert.deepEqual([second.removed, second.failed], [ids * 2 - PRUNE_MAX, []]);
  assert.deepEqual(names(paths), []);
});

test("a closed-session delivery whose intercom session ends keeps its listener state while the node can resume it and releases it after the retention; the sessions.json entry leaves with the next listing", async (t) => {
  const node = closedNode(t);
  const { task: intercom } = await endedIntercom(node);
  const id = intercom.sessionId!;
  const { paths } = node;
  // The daemon listed the intercom session while it ran.
  rememberSessions(paths, [{ sessionId: id, runtime: "claude-code", state: "idle" }], T0);
  rememberMode(paths, id, "auto");
  writeJsonAtomic(listenerScope(paths, id), { token: "t-intercom", listed: true });
  const files = [`${id}.mode.json`, `${id}.scope.json`, `${SESSION}.turns.json`].map((name) => path.join(dir(paths), name));
  assert.ok(fs.existsSync(files[2]), "closed delivery spent a turn of the closed target");
  for (const file of files) age(file, T0);
  const prune = (now: number) => pruneListenerState(paths, { now });

  // (a) The listing after the intercom session ended has no entry for it.
  assert.equal(readLocalSessions(paths).some((s) => s.sessionId === id), false);
  // (b) An hour later, with a fresh listing: nothing goes.
  writeLocalSessions(paths, [], T0 + 60 * 60_000);
  assert.deepEqual(prune(T0 + 60 * 60_000), { removed: 0, kept: 0, sessions: 0, failed: [] });
  assert.equal(checkListeners(paths, alive, T0 + 60 * 60_000).orphaned, 0);
  // Its files are old now, but known-sessions.json still holds both sessions.
  const later = T0 + KNOWN_RETENTION_MS + 60 * 60_000;
  writeLocalSessions(paths, [], later);
  assert.deepEqual(prune(later), { removed: 0, kept: 0, sessions: 0, failed: [] });
  // (c) The next listing drops both entries: the three files go, the task record stays.
  rememberSessions(paths, [], later);
  assert.equal(checkListeners(paths, alive, later).orphaned, 3);
  assert.deepEqual(prune(later), { removed: 2, kept: 1, sessions: 1, failed: [] });
  for (const file of files.slice(0, 2)) assert.equal(fs.existsSync(file), false, path.basename(file));
  assert.equal(fs.existsSync(files[2]), true, "protected v2 canonical budget stays with its marker");
  assert.equal(readTask(paths, intercom.taskId)?.state, "done");
  assert.equal(checkListeners(paths, alive, later).orphaned, 1);
});
