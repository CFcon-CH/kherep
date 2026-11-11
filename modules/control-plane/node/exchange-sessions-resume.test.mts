import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, type NodePaths } from "./config.mts";
import { addLocalSession, writeLocalSessions } from "./exchange-sessions.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { readSelectedLocalReferences } from "./message-reference.mts";
import { readWakeSnapshot } from "./wake-snapshot.mts";

// The row a resume inserts (issue #102) exists for the delivery hook of the first
// turn. It says nothing about listing coverage.
const NOW = Date.parse("2026-10-15T12:00:00Z");
const RESUMED = { sessionId: "resumed", name: "r" };
const ROW = { sessionId: "alpha", runtime: "claude-code", state: "idle-loaded" };
function home(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume row synthetic "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  return paths;
}
const stored = (paths: NodePaths) => JSON.parse(fs.readFileSync(paths.sessions, "utf8"));

test("a provisional resume row leaves an unrelated session reference bound", t => {
  const paths = home(t);
  writeLocalSessions(paths, [ROW], NOW);
  addLocalSession(paths, RESUMED);
  assert.equal(readSelectedLocalReferences(paths, [{ role: "to", ref: "alpha" }]).results[0].code, "BOUND");
  assert.deepEqual(stored(paths).unseen, []);
});

const EIGHT = ["a", "b", "c", "d", "e", "f", "g", "h"];
for (const [label, value] of [
  ["a null row", { sessions: [null] }],
  ["a numeric unseen", { unseen: 5, sessions: [] }],
  ["a string unseen", { unseen: "ab", sessions: [] }],
  ["eight unseen runtimes", { updatedAt: new Date(NOW).toISOString(), unseen: EIGHT, sessions: [ROW] }],
] as const) test(`addLocalSession keeps the file's own coverage markers beside ${label}`, t => {
  const paths = home(t);
  writeJsonAtomic(paths.sessions, value);
  addLocalSession(paths, RESUMED);
  const after = stored(paths);
  assert.deepEqual(after.unseen, "unseen" in value ? value.unseen : undefined);
  assert.equal(after.sessions.includes(null), false);
  assert.equal(after.sessions.at(-1).sessionId, "resumed");
  if (label === "eight unseen runtimes") {
    assert.equal(readWakeSnapshot(paths, NOW + 1000).snapshot.status, "fresh", "eight entries stay inside the envelope limit");
  }
});

// Issue #834: a resumed id already listed with a runtime is found through that row.
// A second row would share its id and make the whole population invalid.
const LISTED = { sessionId: "resumed", name: "r", runtime: "claude-code", state: "idle-loaded" };

test("a resume of a listed session leaves every reference on the node bound", t => {
  const paths = home(t);
  writeLocalSessions(paths, [ROW, LISTED], NOW);
  addLocalSession(paths, RESUMED);
  const results = readSelectedLocalReferences(paths, [{ role: "to", ref: "alpha" }, { role: "from", ref: "resumed" }]).results;
  assert.deepEqual(results.map(r => r.code), ["BOUND", "BOUND"]);
  const from = results[1];
  assert.equal(from.code === "BOUND" && from.owner.runtime, "claude-code");
});

test("a resume of a listed session adds no second row for its id", t => {
  const paths = home(t);
  writeLocalSessions(paths, [ROW, LISTED], NOW);
  const before = stored(paths).sessions;
  addLocalSession(paths, RESUMED);
  const after = stored(paths).sessions;
  assert.deepEqual(after, before);
  assert.equal(after.filter((s: { sessionId: string }) => s.sessionId === "resumed").length, 1);
});

test("a second resume of an unlisted session keeps one provisional row", t => {
  const paths = home(t);
  writeLocalSessions(paths, [ROW], NOW);
  addLocalSession(paths, RESUMED);
  addLocalSession(paths, RESUMED);
  const rows = stored(paths).sessions.filter((s: { sessionId: string }) => s.sessionId === "resumed");
  assert.equal(rows.length, 1);
  assert.equal("runtime" in rows[0], false);
});
