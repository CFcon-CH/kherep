import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listenerDir, listenerLock, listenerScope, isPlainSessionId } from "./autonomy.mts";
import { nodePaths } from "./config.mts";
import { addLocalSession } from "./exchange-sessions.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { checkWakeReadiness } from "./wake-readiness.mts";
import { readWakeSnapshot } from "./wake-snapshot.mts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const row = (sessionId = "ordinary", state = "idle-loaded") => ({ sessionId, runtime: "claude-code", state });
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake snapshot synthetic "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const write = (sessions: unknown[], extra = {}) => writeJsonAtomic(paths.sessions,
    { updatedAt: new Date(NOW - 1000).toISOString(), sessions, unseen: [], ...extra });
  const check = () => checkWakeReadiness(paths, { version: 1, allowedCommands: [], wake: { enabled: true, sessions: ["*"] } }, () => true, NOW) as any;
  return { paths, write, check };
}

test("A provisional resume row preserves other observed sessions", t => {
  const f = fixture(t);
  f.write([row("ordinary", "idle")]);
  addLocalSession(f.paths, { sessionId: "resumed", name: "synthetic" });
  const result = f.check();
  assert.equal(result.observedIdle, 1, "valid idle observation survives provisional insertion");
  assert.equal(result.snapshot.incompleteRows, 1);
  assert.equal(result.snapshot.completeness, "partial");
  const stored = JSON.parse(fs.readFileSync(f.paths.sessions, "utf8"));
  assert.equal(stored.updatedAt, new Date(NOW - 1000).toISOString());
  assert.deepEqual(stored.unseen, []);
  assert.deepEqual(stored.sessions.at(-1), { sessionId: "resumed", name: "synthetic", state: "unknown" }, "the row a resume writes carries no runtime");
});

test("a snapshot without unseen metadata does not claim its coverage is untruncated", t => {
  const f = fixture(t);
  writeJsonAtomic(f.paths.sessions, { updatedAt: new Date(NOW - 1000).toISOString(), sessions: [row()] });
  const result = f.check();
  assert.equal(result.snapshot.truncated, "unknown");
  assert.equal(result.snapshot.completeness, "unknown");
});

test("a resume into a home without a listing names the missing timestamp", t => {
  const f = fixture(t);
  addLocalSession(f.paths, { sessionId: "resumed", name: "synthetic" });
  const result = f.check();
  assert.equal(result.snapshot.reasonCode, "missing-timestamp");
  assert.equal(result.observedIdle, "unknown");
  assert.equal(result.ok, false);
  writeJsonAtomic(f.paths.sessions, { unseen: 5, sessions: [] });
  assert.equal(f.check().snapshot.reasonCode, "invalid-envelope", "a corrupt envelope stays corrupt without a timestamp too");
});

test("B canonical idle-loaded contributes listener evidence", t => {
  const f = fixture(t);
  f.write([row()]);
  fs.mkdirSync(listenerDir(f.paths));
  writeJsonAtomic(listenerLock(f.paths, "ordinary"), { token: "synthetic", pid: 4242, startedAt: NOW - 1000, event: "Stop" });
  writeJsonAtomic(listenerScope(f.paths, "ordinary"), { token: "synthetic", listed: true });
  const result = f.check();
  assert.equal(result.observedIdle, 1, "canonical idle-loaded is observed idle");
  assert.equal(result.liveListedListeners.verified, 1);
  f.write([row("ordinary", "unknown")]);
  assert.equal(f.check().observedIdle, 0, "a live pid and listener cannot prove idle");
});

test("C dotted identity cannot poison the snapshot or enter a filename", t => {
  const f = fixture(t);
  f.write([row("ordinary", "idle"), row("display.id", "idle")]);
  const reads: string[] = [];
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: any[]) => { reads.push(String(args[0])); return Reflect.apply(read, fs, args); });
  const result = f.check();
  assert.equal(result.observedIdle, 2, "dotted display identity does not erase valid rows");
  assert.equal(result.liveListedListeners.unsupported, 1);
  assert.equal(reads.some(file => file.includes("display.id")), false);
  assert.equal(isPlainSessionId("display.id"), false);
});

test("D malformed row and truncated listing preserve uncertainty", t => {
  const f = fixture(t);
  f.write([row("ordinary", "idle"), { sessionId: "../unsafe", runtime: "claude-code", state: "idle" }], { unseen: ["*"] });
  const result = f.check();
  assert.equal(result.observedIdle, 1, "malformed row cannot erase a valid observation");
  assert.equal(result.snapshot.rejectedRows, 1);
  assert.equal(result.snapshot.truncated, true);
  assert.equal(result.snapshot.completeness, "partial");
  assert.deepEqual(result.snapshot.unseenRuntimes, ["*"]);
  assert.equal(result.snapshot.countScope, "observed-valid-rows");
});

test("the clock is sampled after the snapshot read, so a file just read is not future-dated", t => {
  const f = fixture(t);
  let clock = NOW;
  const { snapshot } = readWakeSnapshot(f.paths, () => clock, { read: () => {
    clock = NOW + 500;
    return JSON.stringify({ updatedAt: new Date(NOW + 400).toISOString(), sessions: [], unseen: [] });
  } });
  assert.equal(snapshot.reasonCode, "observed");
  assert.equal(snapshot.status, "fresh");
  assert.equal(snapshot.ageSeconds, 0);
});

test("a listed row in unknown state is a state fact, not a coverage gap", t => {
  const f = fixture(t);
  f.write([row("a", "idle"), row("b", "unknown")]);
  const result = f.check();
  assert.equal(result.snapshot.completeness, "complete");
  assert.equal(result.snapshot.incompleteRows, 0);
  assert.equal(result.observedIdle, 1);
});

test("pin: rows past the cap mark the listing truncated and are not read", t => {
  const f = fixture(t);
  f.write(Array.from({ length: 513 }, (_, i) => row(`s${i}`, "idle")));
  const result = f.check();
  assert.equal(result.snapshot.truncated, true);
  assert.equal(result.snapshot.completeness, "partial");
  assert.equal(result.observedIdle, 512);
});

test("pin: a row without state is incomplete, not rejected", t => {
  const f = fixture(t);
  f.write([{ sessionId: "x", runtime: "claude-code" }, row()]);
  const result = f.check();
  assert.equal(result.snapshot.incompleteRows, 1);
  assert.equal(result.snapshot.rejectedRows, 0);
  assert.equal(result.observedIdle, 1);
});

for (const [reason, input] of [
  ["invalid-json", "not json"], ["invalid-envelope", JSON.stringify({ sessions: [], updatedAt: "not a date" })],
  ["missing-timestamp", JSON.stringify({ sessions: [] })],
  ["future-timestamp", JSON.stringify({ sessions: [], updatedAt: new Date(NOW + 1).toISOString() })],
  ["stale", JSON.stringify({ sessions: [], updatedAt: new Date(NOW - 120001).toISOString() })],
  ["missing", null], ["io-error", "EACCES"],
] as const) test(`E read failures retain their reason: ${reason}`, t => {
  const f = fixture(t);
  if (input !== null) fs.writeFileSync(f.paths.sessions, input);
  if (reason === "io-error") {
    const read = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (...args: any[]) => {
      if (args[0] === f.paths.sessions) throw Object.assign(new Error("synthetic"), { code: "EACCES" });
      return Reflect.apply(read, fs, args);
    });
  }
  const result = f.check();
  assert.equal(result.snapshot.reasonCode, reason, "snapshot failure classification");
  assert.equal(result.observedIdle, "unknown");
  assert.equal(result.ok, false);
});
