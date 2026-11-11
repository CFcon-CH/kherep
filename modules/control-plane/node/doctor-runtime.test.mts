import { createIntakeDiagnostics } from "./intake-diagnostics.mts";
import { FakeClock } from "./connection-test-fixture.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listenerDir } from "./autonomy.mts";
import { advanceForkAttempt, claimForkAttempt, forkAttemptsPath } from "./codex-fork-attempts.mts";
import { CODEX_ACTIVE_MS, recordCodexSession } from "./codex-sessions.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { daemonStateFile } from "./daemon-state.mts";
import { captureSourceIdentity } from "./daemon-source.mts";
import { runDoctor, type DoctorDeps } from "./doctor.mts";
import { writeIntercomHost } from "./doctor-intercom-fixture.mts";
import { writeDirectory, writeLocalSessions } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { pinServiceSource } from "./service-source.mts";

import { host, writeHooks, LIVE_PID, HOOKS } from "./doctor-fixture.mts";

test("the runtime check fails without any runtime and when a configured runtime is missing or silent", async (t) => {
  const h = host(t);
  const runtimes = async (deps: Partial<DoctorDeps>) => (await runDoctor({ ...h.deps, ...deps })).checks.runtimes;
  assert.equal((await runtimes({ find: () => null })).ok, false);
  assert.equal((await runtimes({ versionOf: async () => null })).ok, false);
  fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], sessions: { enabled: true, workspaceRoots: ["/synthetic/work"], runtimes: ["claude", "codex"] } }));
  const missing = await runtimes({});
  assert.deepEqual([missing.ok, missing.codex], [false, { installed: false, version: null, configured: true, ready: "unknown" }]);
  fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
  assert.equal((await runtimes({ versionOf: async () => null })).ok, true);
});

// Issue #222: readiness comes from the running daemon's daemon.json only.
test("the runtime check reports the running daemon's readiness record and ignores a dead daemon's", async (t) => {
  const h = host(t);
  const probedAt = "2026-10-04T11:55:00.000Z";
  const write = (pid: number) => fs.writeFileSync(daemonStateFile(h.paths), JSON.stringify({ pid, startedAt: "2026-10-04T10:00:00.000Z",
    connectedAt: "2026-10-04T10:00:01.000Z", readiness: { claude: { ready: false, cause: "sign-in", probedAt } } }));
  write(LIVE_PID);
  const live = (await runDoctor(h.deps)).checks.runtimes;
  assert.deepEqual([live.ok, live.claude], [false, { installed: true, version: "2.1.300 (Claude Code)", configured: true,
    ready: false, cause: "sign-in", probedAt, aged: true }]);
  write(99);
  const dead = (await runDoctor(h.deps)).checks.runtimes;
  assert.deepEqual([dead.ok, (dead.claude as { ready: unknown }).ready], [true, "unknown"]);
});

// Issue #420: a Claude probe the last daemon stop interrupted is shown, and never fails the check.
test("the runtime check names a Claude probe the last daemon stop interrupted", async (t) => {
  const h = host(t);
  const at = "2026-10-04T11:58:00.000Z";
  fs.writeFileSync(daemonStateFile(h.paths), JSON.stringify({ pid: LIVE_PID, startedAt: "2026-10-04T11:59:00.000Z",
    interruptedProbe: { runtime: "claude", pid: 99, at, noticedAt: "2026-10-04T11:59:00.000Z" } }));
  const runtimes = (await runDoctor(h.deps)).checks.runtimes;
  assert.deepEqual([runtimes.ok, runtimes.claude], [true, { installed: true, version: "2.1.300 (Claude Code)", configured: true,
    ready: "unknown", lastStopInterruptedProbeAt: at }]);
});

test("the hook check fails for another checkout, for no hooks and for an unreadable file", async (t) => {
  const h = host(t);
  const claude = h.deps.claudeConfigDir as string;
  const codex = h.deps.codexHome as string;
  const other = path.join(h.root, "old-checkout");
  writeHooks(claude, codex, h.repo, other);
  const hooks = (await runDoctor(h.deps)).checks.hooks;
  assert.equal(hooks.ok, false);
  assert.deepEqual(hooks.codex, { present: true, deliver: 0, wake: 0, foreign: [path.join(HOOKS(other), "deliver-hook.mts")], pointer: "missing", stable: 0, legacy: 1 });
  fs.rmSync(path.join(claude, "settings.json"));
  fs.rmSync(path.join(codex, "config.toml"));
  const none = (await runDoctor(h.deps)).checks.hooks;
  assert.deepEqual([none.ok, none.detail], [false, "no delivery or wake hook is installed"]);
  fs.mkdirSync(path.join(claude, "settings.json"));
  assert.equal((await runDoctor(h.deps)).checks.hooks.detail, "a runtime configuration file is unreadable");
});

// Issue #445: through the stable launcher doctor runs from the service pin,
// while the installed hooks name the checkout the pin was made from.
test("the hook check accepts checkout hooks when doctor runs from a pin of the same commit", async (t) => {
  const h = host(t);
  const pin = pinServiceSource(h.repo, path.join(h.root, "service"));
  const hooks = (await runDoctor({ ...h.deps, repoRoot: pin.root })).checks.hooks;
  assert.equal(hooks.ok, true, JSON.stringify(hooks));
  assert.equal(hooks.checkout, pin.root);
  assert.equal((hooks.claude as { checkouts?: string[] }).checkouts?.length, 2);
  assert.equal((hooks.codex as { checkouts?: string[] }).checkouts?.length, 1);
});

test("the listener check counts live and stale listener locks only", async (t) => {
  const h = host(t);
  const dir = listenerDir(h.paths);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const lock = (name: string, pid: number, startedAt: number) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ token: "t", pid, startedAt, event: "Stop" }));
  lock("live-session.json", LIVE_PID, now - 1_000);
  lock("dead-session.json", 99, now - 1_000);
  lock("old-session.json", LIVE_PID, now - 2 * 86_400_000);
  lock("live-session.turns.json", LIVE_PID, now);
  assert.deepEqual((await runDoctor(h.deps)).checks.listeners, { ok: true, live: 1, stale: 2, orphaned: 0 });
  // Issue #474: with the fresh listing, a week-old state file of a session no listing names is orphaned.
  lock("gone-session.mode.json", LIVE_PID, now);
  const weekOld = (now - 8 * 86_400_000) / 1000;
  fs.utimesSync(path.join(dir, "gone-session.mode.json"), weekOld, weekOld);
  assert.deepEqual((await runDoctor(h.deps)).checks.listeners, { ok: true, live: 1, stale: 2, orphaned: 1 });
});

test("the listener check counts busy-hint locks that outlived their owner, without owner ids (issue #877)", async (t) => {
  const h = host(t);
  const dir = listenerDir(h.paths);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const lock = (n: number, content: string, mtime = now) => {
    const file = path.join(dir, `01a0db74-0000-7000-8000-00000000000${n}.busy-hint.json.lock`);
    fs.writeFileSync(file, content);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
  };
  const owner = (pid: number) => JSON.stringify({ version: 1, pid, startedAt: 1, token: "01a0db74-0000-7000-8000-0000000000ff" });
  lock(1, owner(LIVE_PID));
  lock(2, owner(99));
  lock(3, "", now - 120_000);
  lock(4, "", now - 1_000);
  lock(5, "synthetic unparseable lock");
  const listeners = (await runDoctor(h.deps)).checks.listeners;
  assert.deepEqual(listeners, { ok: true, live: 0, stale: 0, orphaned: 0,
    busyHintLocks: { live: 2, deadOwner: 1, emptyOld: 1, unverifiable: 1 } });
  assert.doesNotMatch(JSON.stringify(listeners), /01a0db74/);
});

test("the Codex session check counts recorded sessions by their last hook event, without session ids (issue #408)", async (t) => {
  const h = host(t);
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  assert.deepEqual((await runDoctor(h.deps)).checks.codexSessions, { ok: true, recorded: 0,
    lastEvent: { SessionStart: 0, UserPromptSubmit: 0, PostToolUse: 0, Stop: 0, Interrupt: 0, SessionEnd: 0, unknown: 0 } });
  const ids = ["019a0000-0000-7000-8000-0000000000a1", "019a0000-0000-7000-8000-0000000000a2", "019a0000-0000-7000-8000-0000000000a3",
    "019a0000-0000-7000-8000-0000000000a4", "019a0000-0000-7000-8000-0000000000a5"];
  recordCodexSession(h.paths, ids[0], "/synthetic/work", now - 1_000, "default", "Stop");
  recordCodexSession(h.paths, ids[1], "/synthetic/work", now - 2_000, "default", "Stop");
  recordCodexSession(h.paths, ids[2], "/synthetic/work", now, "default", "UserPromptSubmit");
  recordCodexSession(h.paths, ids[3], "/synthetic/work", now, "default");
  recordCodexSession(h.paths, ids[4], "/synthetic/work", now - CODEX_ACTIVE_MS - 1, "default", "Stop");
  const before = fs.readdirSync(h.paths.codexSessions).sort();
  const report = await runDoctor(h.deps);
  assert.deepEqual(report.checks.codexSessions, { ok: true, recorded: 4,
    lastEvent: { SessionStart: 0, UserPromptSubmit: 1, PostToolUse: 0, Stop: 2, Interrupt: 0, SessionEnd: 0, unknown: 1 } });
  assert.deepEqual(fs.readdirSync(h.paths.codexSessions).sort(), before, "doctor removes no record");
  for (const id of ids) assert.equal(JSON.stringify(report).includes(id), false);
});

test("kherep-node doctor prints JSON and exits 1 on a host that is not enrolled", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(import.meta.dirname, "cli.mts");
  const result = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, KHEREP_CONFIG_DIR: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, HOME: root, PATH: "" } });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as { ok: boolean; checks: Record<string, { ok: boolean; managed?: boolean }> };
  assert.deepEqual([report.ok, report.checks.enrollment.ok, report.checks.daemon.ok], [false, false, false]);
  // Issue #436: no managed service, so the intercom command cannot resolve a pin.
  assert.deepEqual([report.checks.intercom.ok, report.checks.intercom.managed], [false, false]);
});

test("the Codex fork attempt check counts attempts by state and unreadable owners, without ids or answers (issue #408)", async (t) => {
  const h = host(t);
  const states = { launching: 0, running: 0, completed: 0, declined: 0, failed: 0, uncertain: 0, superseded: 0 };
  assert.deepEqual((await runDoctor(h.deps)).checks.codexForkAttempts, { ok: true, states, unreadableOwners: 0 });
  assert.equal(fs.existsSync(path.join(h.paths.dir, "codex-fork-attempts")), false, "doctor creates no store");
  const owner = "019a0000-0000-7000-8000-0000000000b1", other = "019a0000-0000-7000-8000-0000000000b2";
  const message = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const claim = (who: string, n: number) => claimForkAttempt(h.paths, { owner: who, messageId: message(n), attemptedAt: 1,
    policyFingerprint: "a".repeat(64), producer: { route: "local" } });
  claim(owner, 1);
  claim(owner, 2);
  advanceForkAttempt(h.paths, owner, message(2), "launching", "running", {}, 2);
  advanceForkAttempt(h.paths, owner, message(2), "running", "completed", { answer: "synthetic private answer" }, 3);
  claim(other, 3);
  fs.writeFileSync(path.join(forkAttemptsPath(h.paths, other), `${message(3)}.json`), "{");
  const report = await runDoctor(h.deps);
  assert.deepEqual(report.checks.codexForkAttempts, { ok: false, states: { ...states, launching: 1, completed: 1 }, unreadableOwners: 1,
    detail: "a Codex fork attempt store cannot be read completely" });
  for (const secret of [owner, other, message(1), "synthetic private answer"]) assert.equal(JSON.stringify(report).includes(secret), false);
});

// Numeric daemon-side samples are advisory, never an extra readiness verdict.
test("doctor exposes only the fixed numeric intake snapshot", async t => {
  const h = host(t), clock = new FakeClock();
  const diagnostics = createIntakeDiagnostics({ clock, wall: () => 1000, pending: () => false, log: () => {} });
  const intake = diagnostics.snapshot(); diagnostics.stop();
  const file = daemonStateFile(h.paths), state = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...state, intake: { ...intake, arbitrary: "synthetic canary" } }));
  assert.deepEqual((await runDoctor(h.deps)).checks.daemon.intake, intake);
  fs.writeFileSync(file, JSON.stringify({ ...state, intake: { ...intake, lagMs: "synthetic canary" } }));
  assert.equal((await runDoctor(h.deps)).checks.daemon.intake, undefined);
});

// The awaited probes take real time on a host; a listing or an autonomous turn can land during them.
test("a listing and a turn written during the awaited probes are not future-dated", async (t) => {
  const h = host(t);
  const T0 = h.deps.now!();
  let clock = T0;
  const report = await runDoctor({ ...h.deps, now: () => clock, versionOf: async () => {
    clock = T0 + 1000;
    writeLocalSessions(h.paths, [], T0 + 1000);
    fs.mkdirSync(listenerDir(h.paths), { recursive: true });
    fs.writeFileSync(path.join(listenerDir(h.paths), "owner.turns.json"), JSON.stringify({ turns: [T0 + 1000] }));
    return "2.1.300 (Claude Code)";
  } });
  const readiness = report.checks.wakeReadiness as any, budget = report.checks.wakeBudget as any;
  assert.equal(readiness.snapshot.status, "fresh", `snapshot reason ${readiness.snapshot.reasonCode}`);
  assert.equal(budget.sessions[0].ledgerStatus, "ok");
  assert.equal(budget.ok, true);
});

// No probe in between: doctor's own checks take time too, and each file is written just before its read.
test("a listing and a ledger written just before doctor reads them are judged by a clock sampled after the read", async (t) => {
  const h = host(t);
  const T0 = h.deps.now!();
  let clock = T0;
  const ledger = path.join(listenerDir(h.paths), "owner.turns.json");
  writeLocalSessions(h.paths, [], T0 + 400);
  fs.mkdirSync(listenerDir(h.paths), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ turns: [T0 + 400] }));
  for (const [method, file] of [["readFileSync", h.paths.sessions], ["openSync", ledger]] as const) {
    const original = fs[method] as (...args: unknown[]) => unknown;
    t.mock.method(fs, method, (...args: unknown[]) => {
      if (args[0] === file) clock = T0 + 500;
      return Reflect.apply(original, fs, args);
    });
  }
  const report = await runDoctor({ ...h.deps, now: () => clock });
  const readiness = report.checks.wakeReadiness as any, budget = report.checks.wakeBudget as any;
  assert.equal(readiness.snapshot.status, "fresh", `snapshot reason ${readiness.snapshot.reasonCode}`);
  assert.equal(budget.sessions[0].ledgerStatus, "ok");
  assert.equal(budget.ok, true);
});
