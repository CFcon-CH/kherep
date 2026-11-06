import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listenerDir } from "./autonomy.mts";
import { nodePaths } from "./config.mts";
import { runDoctor } from "./doctor.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { host } from "./doctor-fixture.mts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const DAY = 86400000;
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake budget synthetic "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeJsonAtomic(paths.policy, { version: 1, allowedCommands: [], wake: { enabled: true, sessions: ["*"] } });
  const doctor = () => runDoctor({ paths, repoRoot: root, claudeConfigDir: path.join(root, "claude"), codexHome: path.join(root, "codex"),
    now: () => NOW, pidAlive: () => false, find: () => null, versionOf: async () => null,
    fetch: async () => { throw new Error("network forbidden"); } });
  const ledger = (id: string, turns: unknown[]) => {
    fs.mkdirSync(listenerDir(paths), { recursive: true });
    writeJsonAtomic(path.join(listenerDir(paths), `${id}.turns.json`), { turns });
  };
  return { paths, doctor, ledger };
}

test("F doctor identifies a 100-of-100 owner and release time", async t => {
  const f = fixture(t);
  const turns = Array.from({ length: 100 }, (_, i) => NOW - DAY + 60000 + i * 60000);
  f.ledger("exhausted-owner", turns);
  f.ledger("unlisted-owner", []);
  writeJsonAtomic(f.paths.sessions, { updatedAt: new Date(NOW - 1000).toISOString(), unseen: [],
    sessions: [{ sessionId: "exhausted-owner", runtime: "claude-code", state: "unknown" }] });
  const before = fs.readFileSync(path.join(listenerDir(f.paths), "exhausted-owner.turns.json"), "utf8");
  const result = (await f.doctor()).checks.wakeBudget as any;
  assert.equal(result?.sessions?.[0]?.sessionId, "exhausted-owner", "doctor identifies the exhausted ledger owner");
  assert.equal(result.sessions[0].usedDay, 100);
  assert.equal(result.sessions[0].usedHour, 0);
  assert.equal(result.sessions[0].nextAvailableAt, new Date(turns[0] + DAY).toISOString());
  assert.equal(result.sessions[0].runtime, "claude-code");
  assert.equal(result.sessions[1].runtime, "unknown", "a row establishes only its own owner's runtime");
  assert.equal(result.status, "blocked");
  assert.equal(result.ok, true, "observed exhaustion is a successful diagnostic");
  assert.equal(fs.readFileSync(path.join(listenerDir(f.paths), "exhausted-owner.turns.json"), "utf8"), before);
});

test("G budget enumeration failure is not an empty result", async t => {
  const f = fixture(t);
  let result = (await f.doctor()).checks.wakeBudget as any;
  assert.equal(result?.coverage?.sourceStatus, "not-initialized", "missing directory has explicit coverage");
  assert.equal(result.ok, true);
  fs.mkdirSync(listenerDir(f.paths));
  result = (await f.doctor()).checks.wakeBudget;
  assert.equal(result.coverage.sourceStatus, "empty");
  assert.equal(result.status, "unknown");
  const readdir = fs.readdirSync;
  const mocked = t.mock.method(fs, "readdirSync", (...args: any[]) => {
    if (args[0] === listenerDir(f.paths)) throw Object.assign(new Error("synthetic"), { code: "EACCES" });
    return Reflect.apply(readdir, fs, args);
  });
  result = (await f.doctor()).checks.wakeBudget;
  assert.equal(result.coverage.sourceStatus, "unreadable");
  assert.equal(result.ok, false);
  mocked.mock.restore();
  f.ledger("unreadable", []);
  fs.writeFileSync(path.join(listenerDir(f.paths), "unreadable.turns.json"), "invalid");
  result = (await f.doctor()).checks.wakeBudget;
  assert.equal(result.coverage.unreadable, 1);
  assert.equal(result.coverage.completeness, "partial");
  assert.equal(result.ok, false);
  fs.rmSync(path.join(listenerDir(f.paths), "unreadable.turns.json"));
  f.ledger("000-exhausted", Array(100).fill(NOW - 7200000));
  for (let i = 0; i < 512; i++) f.ledger(`owner-${i}`, []);
  writeJsonAtomic(f.paths.sessions, { sessions: [], unseen: ["*"], updatedAt: new Date(NOW).toISOString() });
  result = (await f.doctor()).checks.wakeBudget;
  assert.equal(result.coverage.sourceStatus, "partial");
  assert.equal(result.coverage.inspected, 512);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.sessions.find((s: any) => s.sessionId === "000-exhausted").usedDay, 100);
});

test("a ledger with an unsupported filename is counted as uncovered and never opened", async t => {
  const f = fixture(t);
  f.ledger("a.b", Array.from({ length: 100 }, (_, i) => NOW - 7200000 - i));
  const opened: string[] = [];
  for (const method of ["openSync", "readFileSync"] as const) {
    const original = fs[method] as (...args: unknown[]) => unknown;
    t.mock.method(fs, method, (...args: unknown[]) => { opened.push(String(args[0])); return Reflect.apply(original, fs, args); });
  }
  const result = (await f.doctor()).checks.wakeBudget as any;
  assert.equal(result.coverage.unsupported, 1);
  assert.equal(result.coverage.sourceStatus, "ok");
  assert.equal(result.coverage.completeness, "partial");
  assert.equal(result.status, "partial");
  assert.equal(result.sessions.length, 0);
  assert.equal(result.ok, true, "an excluded filename is not a failed read");
  assert.equal(opened.some(file => file.includes("a.b.turns")), false);
});

test("a spacing hold stays on the owner's row and does not mark the budget blocked", async t => {
  const f = fixture(t);
  f.ledger("spaced", [NOW - 10_000]);
  const result = (await f.doctor()).checks.wakeBudget as any;
  assert.equal(result.status, "available");
  assert.equal(result.sessions[0].state, "blocked");
  assert.deepEqual(result.sessions[0].blockedBy, ["spacing"]);
  assert.equal(result.ok, true);
});

test("pin: with wake opted out the budget reads disabled and still shows the stored ledger", async t => {
  const f = fixture(t);
  writeJsonAtomic(f.paths.policy, { version: 1, allowedCommands: [], wake: { enabled: false } });
  f.ledger("owner", [NOW - 7200000]);
  const result = (await f.doctor()).checks.wakeBudget as any;
  assert.equal(result.status, "disabled");
  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 1);
});

test("observed exhaustion keeps overall doctor ok true; failed inspection fails doctor", async t => {
  const h = host(t);
  const now = h.deps.now!();
  fs.mkdirSync(listenerDir(h.paths), { recursive: true });
  const file = path.join(listenerDir(h.paths), "exhausted.turns.json");
  writeJsonAtomic(file, { turns: Array(100).fill(now - 7200000) });
  const blocked = await runDoctor(h.deps);
  assert.equal(blocked.checks.wakeBudget?.status, "blocked");
  assert.equal(blocked.ok, true);
  fs.writeFileSync(file, "invalid");
  const failed = await runDoctor(h.deps);
  assert.equal(failed.checks.wakeBudget.ok, false);
  assert.equal(failed.ok, false);
});
