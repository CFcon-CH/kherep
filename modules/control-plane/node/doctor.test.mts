import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { daemonStateFile } from "./daemon-state.mts";
import { captureSourceIdentity } from "./daemon-source.mts";
import { runDoctor, type DoctorDeps } from "./doctor.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";

import { host, writeHooks, LIVE_PID, HOOKS, NODE_ID } from "./doctor-fixture.mts";

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
    snapshot: { status: "fresh", reasonCode: "observed", rejectedRows: 0, incompleteRows: 0, unseenRuntimes: [], truncated: false, countScope: "observed-valid-rows", completeness: "complete", updatedAt: "2026-10-04T12:00:00.000Z", ageSeconds: 0 },
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

// Issue #890 (retirement R3): wake.codexFork is still read without error but
// starts no fork. A written section, valid, malformed or an opt-out, is
// reported as retired and never fails the check; session ids stay out of the
// report, and a policy without it reports as before.
test("the policy check reports a written codexFork section as retired, not as a failure", async (t) => {
  const h = host(t);
  const owner = "01a0db74-0000-7000-8000-000000000001";
  const check = async (wake: Record<string, unknown>) => {
    fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake }));
    return (await runDoctor(h.deps)).checks.policy;
  };
  const fork = (codexFork: unknown) => check({ enabled: true, sessions: ["build"], codexFork });
  for (const codexFork of [{ enabled: true, sessions: [owner] }, { enabled: true, sessions: ["*"] }, { enabled: false }, "yes"]) {
    const policy = await fork(codexFork);
    assert.deepEqual([policy.ok, policy.wake], [true, { enabled: true, sessions: ["build"], codexApp: false, replies: false,
      nativeQueue: false, codexFork: "retired" }], JSON.stringify(codexFork));
    assert.equal(policy.detail, undefined, "a retired section is no failure detail");
    assert.equal(JSON.stringify(policy).includes(owner), false, "session ids stay out of the report");
  }
  let policy = await check({ enabled: false, codexFork: { enabled: true, sessions: [owner] } });
  assert.deepEqual([policy.ok, policy.wake], [true, { enabled: false, codexFork: "retired" }]);
  policy = await check({ enabled: true, sessions: ["build"] });
  assert.deepEqual([policy.ok, Object.hasOwn(policy.wake as object, "codexFork")], [true, false]);
});

// Issue #889: messaging.resumeClosed is still read without error but no longer
// acts. A written key is reported as retired, never as a failure; a policy
// without it reports as before.
test("the policy check reports a written messaging.resumeClosed as retired, not as a failure", async (t) => {
  const h = host(t);
  const check = async (messaging: Record<string, unknown>) => {
    fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], messaging }));
    return (await runDoctor(h.deps)).checks.policy;
  };
  const accept = [{ session: "*", from: ["*"] }];
  let policy = await check({ accept, resumeClosed: true });
  assert.deepEqual([policy.ok, policy.messagingRules, policy.resumeClosed], [true, 1, "retired"]);
  assert.equal(policy.detail, undefined, "a retired key is no failure detail");
  policy = await check({ accept, resumeClosed: "yes" });
  assert.deepEqual([policy.ok, policy.resumeClosed], [true, "retired"]);
  policy = await check({ accept });
  assert.deepEqual([policy.ok, Object.hasOwn(policy, "resumeClosed")], [true, false]);
});
