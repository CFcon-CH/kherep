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

// Issue #215. Every check is driven through runDoctor against a synthetic
// host: config directory, runtime config files and checkout in a temp dir.
const NODE_ID = "00000000-0000-4000-8000-0000000000aa";
const LIVE_PID = 4242;
const HOOKS = (repo: string) => path.join(repo, "modules", "control-plane", "node");

interface Host { root: string; paths: NodePaths; repo: string; deps: DoctorDeps; pem: string }

function host(t: test.TestContext): Host {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(path.join(root, "config"));
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE_ID, name: "synthetic",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: ["node.status"],
    wake: { enabled: true, sessions: ["build"] }, sessions: { enabled: true, workspaceRoots: ["/synthetic/work"], runtimes: ["claude"] } }));
  const repo = path.join(root, "checkout");
  fs.mkdirSync(HOOKS(repo), { recursive: true });
  for (const hook of ["deliver-hook.mts", "wake-hook.mts"]) fs.writeFileSync(path.join(HOOKS(repo), hook), "");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "9.8.7" }));
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", ".").status, 0);
  const tree = git("write-tree").stdout.trim();
  const committed = git("-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-m", "fixture");
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(git("update-ref", "HEAD", committed.stdout.trim()).status, 0);
  fs.writeFileSync(daemonStateFile(paths), JSON.stringify({ pid: LIVE_PID, startedAt: "2026-10-04T10:00:00.000Z",
    connectedAt: "2026-10-04T10:00:01.000Z", source: captureSourceIdentity(repo) }));
  writeLocalSessions(paths, [], Date.parse("2026-10-04T12:00:00.000Z"));
  // Issue #441: the last directory shows this node's queue at the control plane empty.
  writeDirectory(paths, { nodes: [{ nodeId: NODE_ID, name: "synthetic", status: "online",
    intake: { lastAcceptedAt: null, oldestQueuedAt: null, queued: 0 } }], sessions: [], fetchedAt: "2026-10-04T11:59:30.000Z" });
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  fs.mkdirSync(claude);
  fs.mkdirSync(codex);
  writeHooks(claude, codex, repo);
  writeIntercomHost(paths, claude, codex, root);
  const deps: DoctorDeps = {
    paths, repoRoot: repo, claudeConfigDir: claude, codexHome: codex, now: () => Date.parse("2026-10-04T12:00:00.000Z"),
    pidAlive: (pid) => pid === LIVE_PID,
    fetch: async () => Response.json({ ok: true, service: "kherep-control", version: "9.8.7", commit: null, remoteMcp: true }),
    find: (name) => (name === "claude" ? "/synthetic/bin/claude" : null),
    versionOf: async (name) => (name === "claude" ? "2.1.300 (Claude Code)" : null),
  };
  return { root, paths, repo, deps, pem: fs.readFileSync(paths.privateKey, "utf8") };
}

// As the installers and runtimes write them: Claude settings JSON and Codex TOML strings.
function writeHooks(claudeDir: string, codexDir: string, repo: string, codexRepo = repo): void {
  const command = (hook: string, extra: string) => `node "${path.join(HOOKS(repo), hook)}"${extra}`;
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: "command", command: command("deliver-hook.mts", "") },
    { type: "command", command: command("wake-hook.mts", " --timeout 86400"), asyncRewake: true }] }] } }, null, 2)
    .replace(/\//g, "\\/")); // settings.json may spell "/" as "\/" (seen on a live host, 2026-10-04)
  const codexCommand = `"/usr/bin/node" "${path.join(HOOKS(codexRepo), "deliver-hook.mts")}" "--runtime" "codex"`;
  fs.writeFileSync(path.join(codexDir, "config.toml"), `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(codexCommand)}\n`);
}

test("a healthy host passes every check and reports versions without secrets", async (t) => {
  const h = host(t);
  const report = await runDoctor({ ...h.deps,
    fetch: async () => Response.json({ ok: true, version: "9.8.7", commit: "0123abc", remoteMcp: true, token: "SYNTHETIC_SECRET" }) });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.version, "9.8.7");
  assert.deepEqual(report.checks.enrollment, { ok: true, enrolled: true, nodeId: NODE_ID, keyReadable: true });
  assert.deepEqual(report.checks.worker, { ok: true, reachable: true, status: 200, version: "9.8.7", commit: "0123abc", remoteMcp: true });
  assert.deepEqual(report.checks.policy.wake, { enabled: true, sessions: ["build"], codexApp: false, replies: false, nativeQueue: false });
  assert.deepEqual(report.checks.runtimes.claude, { installed: true, version: "2.1.300 (Claude Code)", configured: true, ready: "unknown" });
  assert.deepEqual(report.checks.hooks.claude, { present: true, deliver: 1, wake: 1, foreign: [], pointer: "missing", stable: 0, legacy: 2 });
  assert.deepEqual(report.checks.hooks.codex, { present: true, deliver: 1, wake: 0, foreign: [], pointer: "missing", stable: 0, legacy: 1 });
  assert.deepEqual(report.checks.listeners, { ok: true, live: 0, stale: 0, orphaned: 0 });
  assert.deepEqual(report.checks.wakeReadiness, {
    ok: true,
    snapshot: { status: "fresh", completeness: "complete", updatedAt: "2026-10-04T12:00:00.000Z", ageSeconds: 0 },
    wakeEnabled: true, observedIdle: 0, observedPolicyEligible: 0, observedExplicitRestartAuthorized: 0,
    observedMissingExplicitRestartAuthorization: 0,
    rememberedPermission: { allowed: 0, restricted: 0, unknown: 0 },
    liveListedListeners: { verified: 0, missing: 0, unreadable: 0, stale: 0, mismatched: 0 },
  });
  assert.equal((report.checks.daemon.source as { status: string }).status, "match");
  assert.deepEqual([report.checks.intercom.ok, report.checks.intercom.managed, report.checks.intercom.resolves], [true, true, "match"]);
  assert.deepEqual(report.checks.queueDrain, { ok: true, state: "empty", measured: true, fetchedAt: "2026-10-04T11:59:30.000Z",
    directoryAgeSeconds: 30, truncated: false, queued: 0, oldestQueuedAgeSeconds: null, lastAcceptedAgeSeconds: null, connection: "online",
    peers: { listed: 0, stalled: 0, waiting: 0, empty: 0, unknown: 0 } });
  const text = JSON.stringify(report);
  for (const secret of ["SYNTHETIC_SECRET", "PRIVATE KEY", h.pem.split("\n")[1]]) assert.equal(text.includes(secret), false);
});

test("without a session directory the control plane queue is unmeasured and the report fails (issue #441)", async (t) => {
  const h = host(t);
  fs.rmSync(h.paths.directory);
  const report = await runDoctor(h.deps);
  assert.deepEqual([report.ok, report.checks.queueDrain.ok, report.checks.queueDrain.measured], [false, false, false]);
  assert.match(String(report.checks.queueDrain.detail), /no directory\.json/);
});

test("the daemon source is unknown when missing and fails when the invoking checkout advanced", async (t) => {
  const h = host(t);
  const base = JSON.parse(fs.readFileSync(daemonStateFile(h.paths), "utf8")) as Record<string, unknown>;
  fs.writeFileSync(daemonStateFile(h.paths), JSON.stringify({ ...base, source: undefined }));
  let daemon = (await runDoctor(h.deps)).checks.daemon;
  assert.deepEqual([daemon.ok, (daemon.source as { status: string }).status], [false, "unknown"]);
  assert.match(String(daemon.detail), /startup source identity/);

  const oldSource = captureSourceIdentity(h.repo);
  fs.writeFileSync(path.join(h.repo, "package.json"), JSON.stringify({ version: "9.8.8" }));
  const git = (...args: string[]) => spawnSync("git", ["-C", h.repo, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(git("add", ".").status, 0);
  const tree = git("write-tree").stdout.trim();
  const commit = git("-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-p", oldSource.commit, "-m", "advance");
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(git("update-ref", "HEAD", commit.stdout.trim()).status, 0);
  fs.writeFileSync(daemonStateFile(h.paths), JSON.stringify({ ...base, source: oldSource }));
  daemon = (await runDoctor(h.deps)).checks.daemon;
  assert.deepEqual([daemon.ok, (daemon.source as { status: string }).status], [false, "mismatch"]);
  assert.match(String(daemon.detail), /different source/);
});

test("enrollment fails without a node, without a readable key, with a foreign key or an invalid node.json", async (t) => {
  const h = host(t);
  fs.rmSync(h.paths.privateKey);
  let report = await runDoctor(h.deps);
  assert.deepEqual([report.ok, report.checks.enrollment.keyReadable], [false, false]);
  writePrivateKey(h.paths.privateKey, generateIdentity());
  report = await runDoctor(h.deps);
  assert.equal(report.checks.enrollment.ok, false);
  assert.match(String(report.checks.enrollment.detail), /does not match/);
  fs.writeFileSync(h.paths.config, "{");
  report = await runDoctor(h.deps);
  assert.deepEqual([report.checks.enrollment.ok, report.checks.worker.ok], [false, false]);
  fs.rmSync(h.paths.config);
  report = await runDoctor(h.deps);
  assert.equal(report.checks.enrollment.enrolled, false);
  assert.equal(report.checks.worker.detail, "needs an enrolled node");
});

test("the daemon check needs a recorded, running process whose last connection is authenticated", async (t) => {
  const h = host(t);
  const state = daemonStateFile(h.paths);
  fs.writeFileSync(state, JSON.stringify({ pid: 99, startedAt: "2026-10-04T10:00:00.000Z", connectedAt: "2026-10-04T10:00:01.000Z" }));
  assert.equal((await runDoctor(h.deps)).checks.daemon.alive, false);
  fs.writeFileSync(state, JSON.stringify({ pid: LIVE_PID, startedAt: "2026-10-04T10:00:00.000Z" }));
  const unconnected = (await runDoctor(h.deps)).checks.daemon;
  assert.deepEqual([unconnected.ok, unconnected.alive, unconnected.connectedAt], [false, true, null]);
  fs.writeFileSync(state, JSON.stringify({ pid: LIVE_PID, startedAt: "2026-10-04T10:00:00.000Z",
    connectedAt: "2026-10-04T10:00:01.000Z", disconnectedAt: "2026-10-04T11:00:00.000Z" }));
  const reconnecting = (await runDoctor(h.deps)).checks.daemon;
  assert.deepEqual([reconnecting.ok, reconnecting.disconnectedAt], [false, "2026-10-04T11:00:00.000Z"]);
  fs.writeFileSync(state, "{");
  assert.equal((await runDoctor(h.deps)).checks.daemon.detail, "daemon.json is unreadable");
  fs.rmSync(state);
  const report = await runDoctor(h.deps);
  assert.deepEqual([report.ok, report.checks.daemon.ok], [false, false]);
});

test("the Worker check fails when /health is unreachable, not 200 or not ok, and copies only known fields", async (t) => {
  const h = host(t);
  const worker = async (fetcher: typeof fetch) => (await runDoctor({ ...h.deps, fetch: fetcher })).checks.worker;
  assert.deepEqual(await worker(async () => { throw new Error("SYNTHETIC_NETWORK_DOWN"); }),
    { ok: false, reachable: false, detail: "the Worker did not answer /health" });
  assert.equal((await worker(async () => new Response("SYNTHETIC_BODY", { status: 503 }))).ok, false);
  const old = await worker(async () => Response.json({ ok: true, service: "kherep-control" }));
  assert.deepEqual([old.ok, old.version, old.remoteMcp], [true, null, null]);
  const notOk = await worker(async () => Response.json({ ok: false, version: 7 }));
  assert.deepEqual([notOk.ok, notOk.version], [false, null]);
});

test("the policy check fails on a malformed file and on a rejected wake section, and accepts the default", async (t) => {
  const h = host(t);
  fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: [] } }));
  let policy = (await runDoctor(h.deps)).checks.policy;
  assert.deepEqual([policy.ok, policy.wake], [false, { enabled: false, rejected: true }]);
  fs.writeFileSync(h.paths.policy, "not json");
  assert.equal((await runDoctor(h.deps)).checks.policy.ok, false);
  fs.rmSync(h.paths.policy);
  policy = (await runDoctor(h.deps)).checks.policy;
  assert.deepEqual([policy.ok, policy.source, policy.wake, policy.sessions],
    [true, "default", { enabled: true, sessions: ["*"], codexApp: true, replies: true, nativeQueue: false }, { enabled: false }]);
  assert.deepEqual([policy.wakeSource, policy.messagingSource, policy.messagingRules], ["default", "default", 1]);
});

// Issue #390: doctor says whether wake comes from the file or is the built-in
// default, and shows a file without a messaging section, which accepts nothing.
test("the policy check names the source of the wake and messaging sections", async (t) => {
  const h = host(t);
  const check = async (value: Record<string, unknown>) => {
    fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], ...value }));
    return (await runDoctor(h.deps)).checks.policy;
  };
  let policy = await check({});
  assert.deepEqual([policy.source, policy.wakeSource, policy.messagingSource], ["file", "default", "absent"]);
  assert.deepEqual([policy.wake, policy.messagingRules], [{ enabled: true, sessions: ["*"], codexApp: true, replies: true, nativeQueue: false }, 0]);
  policy = await check({ messaging: { accept: [{ session: "*", from: ["*"] }] } });
  assert.deepEqual([policy.messagingSource, policy.messagingRules], ["file", 1]);
  // Issue #429: the native Queue producer opt-in is a plain field, never a failure.
  policy = await check({ wake: { enabled: true, sessions: ["build"], nativeQueue: true } });
  assert.deepEqual([policy.ok, policy.wake], [true, { enabled: true, sessions: ["build"], codexApp: false, replies: false, nativeQueue: true }]);
  policy = await check({ wake: { enabled: false }, messaging: { accept: [] } });
  assert.deepEqual([policy.ok, policy.wakeSource, policy.messagingSource], [true, "file", "file"]);
  assert.deepEqual([policy.wake, policy.messagingRules], [{ enabled: false }, 0]);
});

// Issue #408: a written wake.codexFork section is printed with its effective
// values and a count of opted-in sessions, never their ids; a rejected one
// fails the check, while wake itself stays as written.
test("the policy check prints a written codexFork section and fails a rejected one", async (t) => {
  const h = host(t);
  const owner = "01a0db74-0000-7000-8000-000000000001";
  const check = async (codexFork: unknown) => {
    fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: ["build"], codexFork } }));
    return (await runDoctor(h.deps)).checks.policy;
  };
  let policy = await check({ enabled: true, sessions: [owner] });
  assert.deepEqual([policy.ok, (policy.wake as Record<string, unknown>).codexFork],
    [true, { enabled: true, sessions: 1, platforms: ["darwin"], idleAfterSeconds: 90, maxAnswerBytes: 4096 }]);
  assert.equal(JSON.stringify(policy).includes(owner), false, "session ids stay out of the report");
  policy = await check({ enabled: true, sessions: ["*"] });
  assert.deepEqual([policy.ok, (policy.wake as Record<string, unknown>).enabled, (policy.wake as Record<string, unknown>).codexFork],
    [false, true, { enabled: false, rejected: true }]);
  assert.match(String(policy.detail), /codexFork/);
  policy = await check({ enabled: false });
  assert.deepEqual([policy.ok, (policy.wake as Record<string, unknown>).codexFork], [true, { enabled: false }]);
});

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

test("the Codex session check counts recorded sessions by their last hook event, without session ids (issue #408)", async (t) => {
  const h = host(t);
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  assert.deepEqual((await runDoctor(h.deps)).checks.codexSessions, { ok: true, recorded: 0,
    lastEvent: { SessionStart: 0, UserPromptSubmit: 0, PostToolUse: 0, Stop: 0, unknown: 0 } });
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
    lastEvent: { SessionStart: 0, UserPromptSubmit: 1, PostToolUse: 0, Stop: 2, unknown: 1 } });
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
