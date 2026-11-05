#!/usr/bin/env node
// Issue #507, part 2. live-hook-integrity.mts --trigger <source>, the re-check
// guard-dispatch.mts starts: plain lines instead of the SessionStart JSON, the
// heartbeat only after a fully proven run, and one writer at a time through the
// hook runtime's coordination (a second one is not admitted while it is busy).
//
// Same sandbox as live-hook-integrity.test.mts: a throwaway home and a fixture
// checkout in one mkdtemp tree, HOME, USERPROFILE and CLAUDE_HOME pointed at it.
// Neither the real ~/.claude nor the real checkout is read or written.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

import { initialize, openDatabase } from "../kherep/hook-runtime/coordinator-db.mts";
import { coordinated, entryFor, HOOK, installIntegrity } from "./integrity-sandbox.mts";
import { ABSOLUTE_PATH } from "./lib/denial-journal.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-hook-trigger-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const GOOD = "export const enforces = true;\n";
let seq = 0;

interface Box { claude: string; hooks: string; repoHooks: string; cwd: string; cache: string }
interface Run { status: number | null; stdout: string; stderr: string; pid?: number }

// A home wiring commit-guard.mts, its live bytes, and the versioned copy.
function sandbox(live: string | null = GOOD, repo: string | null = GOOD): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const claude = path.join(root, "home", ".claude");
  const cwd = path.join(root, "ws", "Work");
  const box = { claude, hooks: path.join(claude, "hooks"), repoHooks: path.join(cwd, "kherep", "claude", "hooks"), cwd,
    cache: path.join(claude, ".cache", "hook-integrity") };
  fs.mkdirSync(box.hooks, { recursive: true });
  fs.mkdirSync(box.repoHooks, { recursive: true });
  installIntegrity(box.hooks);
  if (live !== null) fs.writeFileSync(path.join(box.hooks, "commit-guard.mts"), live);
  if (repo !== null) fs.writeFileSync(path.join(box.repoHooks, "commit-guard.mts"), repo);
  const hooks = { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: coordinated("node ~/.claude/hooks/commit-guard.mts") }] }] };
  fs.writeFileSync(path.join(claude, "settings.user.json"), JSON.stringify({ hooks }));
  return box;
}

const options = (box: Box) => ({
  input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: box.cwd.replace(/\\/g, "/") }),
  env: { ...process.env, HOME: path.dirname(box.claude), USERPROFILE: path.dirname(box.claude), CLAUDE_HOME: box.claude,
    KHEREP_WORKSPACE: box.cwd },
});
const args = (box: Box): string[] => {
  declareCopy(path.join(import.meta.dirname, HOOK), path.join(box.hooks, HOOK));
  return [entryFor(box.hooks), "writer", path.join(box.hooks, HOOK), "--trigger", "guard-dispatch"];
};

function run(box: Box): Run {
  const result = spawnSync(process.execPath, args(box), { ...options(box), encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function start(box: Box): Promise<Run> {
  return new Promise((resolve, reject) => {
    const { input, env } = options(box);
    const child = spawn(process.execPath, args(box), { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, pid: child.pid }));
    child.stdin.end(input);
  });
}

const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const beat = (box: Box): Record<string, unknown> | null => JSON.parse(read(path.join(box.cache, "heartbeat.json")) ?? "null");
const journal = (box: Box): Record<string, unknown>[] => (read(path.join(box.cache, "incidents.jsonl")) ?? "")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const guardText = (box: Box): string | null => read(path.join(box.hooks, "commit-guard.mts"));
const lines = (run: Run): string[] => run.stdout.split(/\r?\n/).filter(Boolean);

// The second writer's fate: admitted after the first ended, or refused while it was busy.
const admittedOrBusy = (result: Run): boolean =>
  result.status === 0 || (result.status === 1 && /not admitted: busy/.test(result.stderr));

test("healthy: one plain summary line, heartbeat with trigger guard-dispatch, no journal", () => {
  const box = sandbox();
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(result), ["all 1 files OK (0 restored), heartbeat refreshed"]);
  assert.equal(beat(box)?.trigger, "guard-dispatch");
  assert.equal(beat(box)?.files, 1);
  assert.deepEqual(journal(box), []);
});

test("a 0-byte guard: restored with proof, journalled with the trigger, heartbeat written", () => {
  const box = sandbox("");
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  const [finding, summary] = lines(result);
  const sha = crypto.createHash("sha256").update(GOOD).digest("hex");
  assert.match(String(finding), /^commit-guard\.mts: 0 bytes .* -> RESTORED from the repo, verified at the target/);
  assert.ok(String(finding).includes(sha.slice(0, 12)), finding);
  assert.equal(summary, "all 1 files OK (1 restored), heartbeat refreshed");
  assert.equal(guardText(box), GOOD);
  const [entry] = journal(box);
  assert.equal(entry?.trigger, "guard-dispatch");
  assert.equal(entry?.restoreProven, true);
  assert.equal(beat(box)?.trigger, "guard-dispatch");
});

test("an unchecked file: the finding and heartbeat not written, earlier heartbeat untouched", () => {
  const box = sandbox(null);
  fs.mkdirSync(path.join(box.hooks, "commit-guard.mts"));
  fs.mkdirSync(box.cache, { recursive: true });
  fs.writeFileSync(path.join(box.cache, "heartbeat.json"), "planted\n");
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  const out = lines(result);
  assert.match(String(out[0]), /commit-guard\.mts: UNCHECKED/);
  assert.equal(out[1], "heartbeat not written (commit-guard.mts is unchecked)");
  assert.equal(read(path.join(box.cache, "heartbeat.json")), "planted\n");
});

test("an unproven restore: NOT restored and heartbeat not written", () => {
  const box = sandbox("", null);
  const result = run(box);
  assert.match(lines(result)[0] ?? "", /NOT restored/);
  assert.equal(lines(result)[1], "heartbeat not written (commit-guard.mts is not restored)");
  assert.equal(beat(box), null);
});

test("no wired file: no lock, no heartbeat, no cache directory", () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.claude, "settings.user.json"), JSON.stringify({ hooks: {} }));
  const result = run(box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^heartbeat not written \(no hook file is wired\)$/m);
  assert.equal(fs.existsSync(path.join(box.claude, ".cache")), false);
});

// Issue #564: the trigger output reaches the dispatcher's notice; no line names a path or carries Node's message.
test("a deleted own lib and unreadable settings: lines with codes and no path", () => {
  const box = sandbox();
  // No versioned copy either: since issue #576 the source is named inside the checkout.
  fs.rmSync(path.join(box.hooks, "lib", "hook-syntax.mts"));
  const deleted = lines(run(box));
  assert.match(String(deleted[0]), /^own import lib\/hook-syntax\.mts cannot be loaded \(ERR_MODULE_NOT_FOUND\); nothing was verified this session -> NOT restored \(versioned source claude\/hooks\/lib\/hook-syntax\.mts unreadable \(ENOENT\)\)/);
  const bare = sandbox();
  fs.rmSync(path.join(bare.claude, "settings.user.json"));
  const unread = lines(run(bare));
  assert.ok(unread.includes("no live settings could be read in this home, so WHICH hooks are wired is UNKNOWN here"), unread.join("\n"));
  for (const line of [...deleted, ...unread]) {
    assert.doesNotMatch(line, ABSOLUTE_PATH, line);
    assert.ok(!line.includes(TMP), line);
  }
});

test("while another writer holds the hooks directory: not admitted, nothing checked or written", async () => {
  const box = sandbox("");
  const opened = await openDatabase(box.hooks);
  initialize(opened.conn);
  opened.conn.exec("BEGIN EXCLUSIVE");
  let result: Run;
  try { result = run(box); } finally { opened.conn.exec("ROLLBACK"); opened.conn.close(); }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not admitted: busy/);
  assert.equal(result.stdout, "");
  assert.equal(guardText(box), "", "nothing was restored");
  assert.equal(beat(box), null);
  assert.deepEqual(journal(box), []);
});

test("two runs started together: one repairs, the other is admitted after it or refused, one journal entry", async () => {
  const box = sandbox("");
  const runs = await Promise.all([start(box), start(box)]);
  for (const result of runs) assert.ok(admittedOrBusy(result), JSON.stringify(result));
  assert.equal(journal(box).length, 1);
  assert.equal(guardText(box), GOOD);
  assert.equal(beat(box)?.trigger, "guard-dispatch");
  assert.deepEqual(fs.readdirSync(box.cache).sort(), ["heartbeat.json", "incidents.jsonl"]);
});

test("four runs started together converge on the versioned bytes with one repair", async () => {
  const box = sandbox("");
  const runs = await Promise.all([start(box), start(box), start(box), start(box)]);
  for (const result of runs) assert.ok(admittedOrBusy(result), JSON.stringify(result));
  assert.equal(guardText(box), GOOD);
  assert.equal(journal(box).length, 1, "exclusion: exactly one run repaired");
  assert.equal(beat(box)?.trigger, "guard-dispatch");
});
