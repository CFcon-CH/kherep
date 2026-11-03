import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MESSAGE_PROGRESS_CODES } from "../protocol-messages.mts";
import { audit, listenerDir, takeTurn, wakeAudit, type AutonomyAction } from "./autonomy.mts";
import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import {
  admitForkReply, FORK_PROGRESS, RELAY_MAX_AGE_MS, relayRefusal, type ForkAdmissionDeps, type ForkRefusal,
} from "./codex-fork-admission.mts";
import { advanceForkAttempt, claimForkAttempt, forkAttemptsPath, type ForkAttempt } from "./codex-fork-attempts.mts";
import { CODEX_ACTIVE_MS, markStopEnded, recordCodexSession, refreshCodexEvent } from "./codex-sessions.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { MAX_REPLY_DEPTH, readJson, storeMessage, writeJsonAtomic } from "./inbox.mts";
import { readPolicy } from "./policy.mts";
import type { Readiness } from "./runtime-readiness.mts";
import { writeTask } from "./task-records.mts";

// Issue #408, PR 2: the guards of design section 2.4 as one decision with a
// reason code. The turn budget is spent only when every other guard passed.
// Nothing here starts a process; nothing on a live path calls admission yet.

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const OTHER = "01a0db74-0000-7000-8000-000000000002";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const MSG = "00000000-0000-4000-8000-000000000001";
const NOW = Date.UTC(2026, 9, 16, 12);
const STOP = NOW - 10 * 60_000;

interface Fixture { paths: NodePaths; work: string; deps: ForkAdmissionDeps; fingerprint: string; policy: Record<string, any> }

function fixture(t: test.TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fork-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(path.join(root, "work"));
  const work = fs.realpathSync.native(path.join(root, "work"));
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "node-a", publicKey: "x", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  const policy = { version: 1, allowedCommands: [], messaging: { accept: [{ session: "*", from: ["*"] }] },
    wake: { enabled: true, sessions: ["*"], codexFork: { enabled: true, sessions: [OWNER] } },
    sessions: { enabled: true, runtimes: ["codex"], workspaceRoots: [work] } };
  fs.writeFileSync(paths.policy, JSON.stringify(policy));
  recordCodexSession(paths, OWNER, work, STOP, "default", "Stop");
  markStopEnded(paths, OWNER);
  storeMessage(paths.inbox, { messageId: MSG, from: { nodeId: PEER, session: "build" }, toSession: OWNER, text: "synthetic question",
    createdAt: new Date(STOP).toISOString() }, STOP);
  return { paths, work, policy, fingerprint: busyPolicyFingerprint(readPolicy(paths.policy)!),
    deps: { paths, now: () => NOW, platform: "darwin", postToolHook: () => true } };
}

const turns = (f: Fixture): unknown => readJson(path.join(listenerDir(f.paths), `${OWNER}.turns.json`));
const admit = (f: Fixture) => admitForkReply(f.deps, OWNER, MSG, f.fingerprint);
function rewritePolicy(f: Fixture, change: (policy: Record<string, any>) => void, refresh = true): void {
  change(f.policy);
  fs.writeFileSync(f.paths.policy, JSON.stringify(f.policy));
  if (refresh) f.fingerprint = busyPolicyFingerprint(readPolicy(f.paths.policy)!);
}
function patchMessage(f: Fixture, change: Record<string, unknown>): void {
  const file = path.join(f.paths.inbox, `${MSG}.json`);
  writeJsonAtomic(file, { ...readJson<object>(file), ...change });
}
function patchSession(f: Fixture, change: Record<string, unknown>): void {
  const file = path.join(f.paths.codexSessions, `${OWNER}.json`);
  writeJsonAtomic(file, { ...readJson<object>(file), ...change });
}
const readiness = (verdict: { ready: boolean; cause?: string } | null): Readiness =>
  ({ peek: () => (verdict ? { ...verdict, at: NOW } : null) }) as unknown as Readiness;

test("an idle opted-in owner with an accepted exact-addressed message is admitted and spends one turn", (t) => {
  const f = fixture(t);
  assert.deepEqual(admit(f), { ok: true, cwd: f.work });
  assert.equal(turns(f),null,"pure eligibility cannot book a turn; the scheduler books the common group");
});

test("an owner listed in uppercase in codexFork.sessions is opted in (L3)", (t) => {
  const f = fixture(t);
  rewritePolicy(f, (p) => { p.wake.codexFork.sessions = [OWNER.toUpperCase()]; });
  assert.deepEqual(admit(f), { ok: true, cwd: f.work });
});

const CASES: [string, ForkRefusal, (f: Fixture) => void][] = [
  ["no codexFork section", "fork-off", (f) => rewritePolicy(f, (p) => { delete p.wake.codexFork; })],
  ["a malformed codexFork section", "fork-off", (f) => rewritePolicy(f, (p) => { p.wake.codexFork.sessions = ["*"]; })],
  ["an unreadable policy", "fork-off", (f) => fs.writeFileSync(f.paths.policy, "{")],
  ["no node enrollment", "fork-off", (f) => fs.rmSync(f.paths.config)],
  ["the kill switch", "kill-switch", (f) => fs.writeFileSync(path.join(f.paths.dir, "wake.disabled"), "")],
  ["a policy change since admission", "policy-changed", (f) => rewritePolicy(f, (p) => { p.wake.replies = true; }, false)],
  ["no session record", "not-recorded", (f) => fs.rmSync(path.join(f.paths.codexSessions, `${OWNER}.json`))],
  ["a record of another session", "not-recorded", (f) => patchSession(f, { sessionId: OTHER })],
  ["a session not seen within the active window", "not-recorded",
    (f) => patchSession(f, { lastSeen: new Date(NOW - CODEX_ACTIVE_MS - 1).toISOString() })],
  ["a lastSeen in the future", "not-recorded", (f) => patchSession(f, { lastSeen: new Date(NOW + 1).toISOString() })],
  ["a task session", "task-session", (f) => writeTask(f.paths, { taskId: "00000000-0000-4000-8000-0000000000f1", runtime: "codex",
    name: "task-000000f1", cwd: f.work, permissionMode: "auto", state: "running", startedAt: new Date(NOW).toISOString(),
    deadline: new Date(NOW + 60_000).toISOString(), updatedAt: new Date(NOW).toISOString(), sessionId: OWNER }, NOW)],
  ["a recorded bypassPermissions mode", "permission-mode", (f) => patchSession(f, { permissionMode: "bypassPermissions" })],
  ["a payload bypassPermissions mode over a recorded default", "permission-mode",
    (f) => { f.deps.payload = { permission_mode: "bypassPermissions" }; }],
  ["an unknown mode without an explicit wake.sessions entry", "permission-mode-unknown", (f) => patchSession(f, { permissionMode: undefined })],
  ["a payload whose mode is unknown over a recorded default", "permission-mode-unknown", (f) => { f.deps.payload = { permission_mode: 7 }; }],
  ["an owner not listed in codexFork.sessions", "not-opted-in",
    (f) => rewritePolicy(f, (p) => { p.wake.codexFork.sessions = [OTHER]; p.wake.codexApp = true; })],
  ["a platform not listed", "fork-disabled-platform", (f) => { f.deps.platform = "win32"; }],
  ["no PostToolUse delivery hook", "post-tool-hook-missing", (f) => { f.deps.postToolHook = () => false; }],
  ["a last event that is not a Stop", "fork-not-idle", (f) => { refreshCodexEvent(f.paths, OWNER, "PostToolUse", NOW - 60_000); }],
  ["a Stop more recent than idleAfterSeconds", "fork-not-idle",
    (f) => rewritePolicy(f, (p) => { p.wake.codexFork.idleAfterSeconds = 3600; })],
  ["a Stop not marked as ended (a continuation or a failed mark)", "fork-not-idle", (f) => patchSession(f, { lastStopEnded: undefined })],
  ["no message", "message-not-eligible", (f) => fs.rmSync(path.join(f.paths.inbox, `${MSG}.json`))],
  ["a message already offered", "message-not-eligible", (f) => patchMessage(f, { state: "offered" })],
  ["a message addressed by name", "message-not-eligible", (f) => patchMessage(f, { toSession: "codex-00000001" })],
  ["a task message", "message-not-eligible", (f) => patchMessage(f, { taskId: "00000000-0000-4000-8000-0000000000f1" })],
  // Issue #408, PR 4: msg send cannot answer the operator API either.
  ["a message from the operator API", "message-not-eligible", (f) => patchMessage(f, { from: { nodeId: "operator", session: "operator" } })],
  ["a reply at the depth limit", "depth-limit", (f) => patchMessage(f, { depth: MAX_REPLY_DEPTH })],
  ["an earlier failed attempt for the message", "attempt-exists", (f) => {
    claimForkAttempt(f.paths, { owner: OWNER, messageId: MSG, attemptedAt: NOW - 1, policyFingerprint: f.fingerprint, producer: {} });
    advanceForkAttempt(f.paths, OWNER, MSG, "launching", "failed", {}, NOW - 1);
  }],
  ["another attempt of the owner in flight", "fork-in-flight", (f) => claimForkAttempt(f.paths, { owner: OWNER,
    messageId: "00000000-0000-4000-8000-000000000002", attemptedAt: NOW - 1, policyFingerprint: f.fingerprint, producer: {} })],
  ["an unreadable attempt store", "attempts-unreadable", (f) => {
    fs.mkdirSync(forkAttemptsPath(f.paths, OWNER), { recursive: true });
    fs.writeFileSync(path.join(forkAttemptsPath(f.paths, OWNER), "00000000-0000-4000-8000-000000000002.json"), "{");
  }],
  ["sessions disabled", "cwd-refused", (f) => rewritePolicy(f, (p) => { p.sessions.enabled = false; })],
  ["codex not among the session runtimes", "cwd-refused", (f) => rewritePolicy(f, (p) => { p.sessions.runtimes = ["claude"]; })],
  ["a cwd outside the workspace roots", "cwd-refused", (f) => patchSession(f, { cwd: os.tmpdir() })],
  ["a record without cwd", "cwd-refused", (f) => patchSession(f, { cwd: undefined })],
  ["a pending readiness verdict", "runtime-pending", (f) => { f.deps.readiness = readiness(null); }],
  ["a failed readiness verdict", "runtime-not-ready", (f) => { f.deps.readiness = readiness({ ready: false, cause: "sign-in" }); }],
];

for (const [name, reason, arrange] of CASES) {
  test(`refused with ${reason}: ${name}; no turn is spent`, (t) => {
    const f = fixture(t);
    arrange(f);
    assert.deepEqual(admit(f), { ok: false, reason });
    assert.equal(turns(f), null);
  });
}

test("the turn budget is checked last: spacing and an exhausted budget refuse after every other guard passed", (t) => {
  const f = fixture(t);
  assert.equal(takeTurn(f.paths, OWNER, NOW - 1_000), "ok");
  assert.deepEqual(admit(f),{ok:true,cwd:f.work},"pure preflight does not claim or debit");
  rewritePolicy(f, (p) => { p.wake.budget = { perHour: 1 }; });
  assert.deepEqual(admit(f),{ok:true,cwd:f.work},"budget belongs to the actual shared scheduler");
  assert.deepEqual((turns(f) as {turns:number[]}).turns,[NOW-1000],"preflight never changes existing budget state");
});

test("an explicit wake.sessions entry admits an unknown permission mode", (t) => {
  const f = fixture(t);
  patchSession(f, { permissionMode: undefined });
  rewritePolicy(f, (p) => { p.wake.sessions = [OWNER]; });
  assert.deepEqual(admit(f), { ok: true, cwd: f.work });
});

test("every refusal maps to an existing waiting progress code", () => {
  const waiting: readonly string[] = MESSAGE_PROGRESS_CODES.waiting;
  for (const [, reason] of CASES) assert.ok(waiting.includes(FORK_PROGRESS[reason]), reason);
  assert.ok(waiting.includes(FORK_PROGRESS["budget-spacing"]) && waiting.includes(FORK_PROGRESS["budget-exhausted"]));
});

// Issue #408, PR 3: guards 10 to 12 refuse in the fork producer before admission;
// the message keeps waiting for the owner's next turn.
test("the producer's refusals before admission map to awaiting-user-turn", () => {
  for (const reason of ["fork-producer", "fork-mcp-unknown", "fork-features-unknown", "fork-relay-unsupported"] as const) {
    assert.equal(FORK_PROGRESS[reason], "awaiting-user-turn", reason);
  }
});

test("the fork audit actions are metadata lines like every other wake decision", (t) => {
  const f = fixture(t);
  const actions: AutonomyAction[] = ["fork", "fork-declined", "fork-failed", "fork-uncertain", "fork-superseded", "fork-not-idle",
    "fork-disabled-platform", "fork-relayed"];
  for (const action of actions) audit(f.paths, NOW, OWNER, [MSG], action);
  const lines = fs.readFileSync(wakeAudit(f.paths), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.action), actions);
  assert.deepEqual(Object.keys(lines[0]), ["ts", "sessionId", "messageIds", "action"]);
});

// Issue #408, PR 4, design r3 section 2.3: the relay guards, one pure function
// for the sweep and the send gate, in their contract order. Every guard is
// broken at first and repaired in order; admission's attempt, cwd, readiness
// and budget clauses never apply, and nothing spends a turn.
test("relayRefusal returns its codes in order and never an admission-only code", (t) => {
  const f = fixture(t);
  const kill = path.join(f.paths.dir, "wake.disabled");
  const attempt = { version: 1, attemptId: "00000000-0000-4000-8000-0000000000a1", owner: OWNER, messageId: MSG,
    attemptedAt: NOW - RELAY_MAX_AGE_MS - 1, policyFingerprint: "x", producer: {}, state: "completed", updatedAt: NOW, forkId: "fork-a",
    answer: "Green." } as ForkAttempt;
  let capabilities: readonly string[] | null = null;
  const deps = { ...f.deps, workerCapabilities: () => capabilities };
  const task = (session: string) => writeTask(f.paths, { taskId: "00000000-0000-4000-8000-0000000000f1", runtime: "codex",
    name: "task-000000f1", cwd: f.work, permissionMode: "auto", state: "running", startedAt: new Date(NOW).toISOString(),
    deadline: new Date(NOW + 60_000).toISOString(), updatedAt: new Date(NOW).toISOString(), sessionId: session }, NOW);
  // Conditions that only admission refuses hold throughout.
  patchSession(f, { cwd: os.tmpdir() });
  deps.readiness = readiness(null);
  claimForkAttempt(f.paths, { owner: OWNER, messageId: "00000000-0000-4000-8000-000000000002", attemptedAt: NOW - 1,
    policyFingerprint: f.fingerprint, producer: {} });
  assert.equal(takeTurn(f.paths, OWNER, NOW - 1_000), "ok");
  const before = turns(f);
  const fork = f.policy.wake.codexFork;
  rewritePolicy(f, (p) => { delete p.wake.codexFork; }, false);
  fs.writeFileSync(kill, "");
  patchMessage(f, { state: "offered" });
  patchSession(f, { lastSeen: new Date(NOW + 1).toISOString(), permissionMode: "bypassPermissions", lastStopEnded: undefined });
  task(OWNER);
  deps.platform = "win32";
  deps.postToolHook = () => false;
  const repairs: [ForkRefusal | null, () => void][] = [
    ["fork-relay-stale", () => { attempt.attemptedAt = NOW - 1_000; }],
    ["fork-off", () => rewritePolicy(f, (p) => { p.wake.codexFork = { ...fork, sessions: [OTHER] }; }, false)],
    ["kill-switch", () => fs.rmSync(kill)],
    ["policy-changed", () => { attempt.policyFingerprint = busyPolicyFingerprint(readPolicy(f.paths.policy, true)!); }],
    ["not-opted-in", () => { rewritePolicy(f, (p) => { p.wake.codexFork.sessions = [OWNER]; }); attempt.policyFingerprint = f.fingerprint; }],
    ["fork-disabled-platform", () => { deps.platform = "darwin"; }],
    ["fork-relay-unsupported", () => { capabilities = ["messaging.proxy.v1"]; }],
    ["message-not-eligible", () => patchMessage(f, { state: "accepted" })],
    ["not-recorded", () => patchSession(f, { lastSeen: new Date(STOP).toISOString() })],
    ["task-session", () => task(OTHER)],
    ["permission-mode", () => patchSession(f, { permissionMode: undefined })],
    ["permission-mode-unknown", () => patchSession(f, { permissionMode: "default" })],
    ["post-tool-hook-missing", () => { deps.postToolHook = () => true; }],
    ["fork-not-idle", () => markStopEnded(f.paths, OWNER)],
    [null, () => {}],
  ];
  for (const [code, repair] of repairs) {
    assert.equal(relayRefusal(deps, OWNER, attempt, NOW), code);
    repair();
  }
  assert.deepEqual(turns(f), before, "no turn is spent");
  assert.equal(relayRefusal(deps, OWNER, { ...attempt, answer: "x".repeat(8_193) }, NOW), "policy-changed", "the answer bound");
});

test("guarded20 passes fork admission without changing owner, permissions or budget guards", (t) => {
  const f = fixture(t);
  patchMessage(f, { depth: 20, loop: { version: 1, threadId: MSG, depth: 20, generation: 0, ordinal: 21 } });
  assert.equal(admit(f).ok, true);
  const bad = fixture(t);
  patchMessage(bad, { depth: 20, loop: { version: 2, threadId: MSG, depth: 20, generation: 0, ordinal: 21 } });
  assert.deepEqual(admit(bad), { ok: false, reason: "depth-limit" });
  assert.equal(turns(bad), null);
});
