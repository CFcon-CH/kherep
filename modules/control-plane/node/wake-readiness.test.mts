import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listenerDir, listenerLock, listenerScope, rememberMode } from "./autonomy.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { checkWakeReadiness } from "./doctor-local.mts";
import { writeLocalSessions } from "./exchange.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { markUnseen } from "./known-sessions.mts";
import type { NodePolicy } from "./policy.mts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const LIVE_PID = 4242;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "SYNTHETIC_LISTENER_TOKEN_MUST_NOT_BE_REPORTED";

function check(paths: NodePaths, policy: NodePolicy | null): Record<string, unknown> {
  return checkWakeReadiness(paths, policy, (pid) => pid === LIVE_PID, NOW);
}

function fixture(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-wake-readiness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

function policy(sessions: string[]): NodePolicy {
  return { version: 1, allowedCommands: [], wake: { enabled: true, sessions } };
}

function snapshot(paths: NodePaths, sessions: Array<{ sessionId: string; state: string; name?: string }>, at = NOW - 1_000,
  unseen: string[] = []): void {
  const rows = sessions.map((session) => ({ ...session, runtime: "claude-code" }));
  writeLocalSessions(paths, markUnseen(rows, unseen), at);
}

function listener(paths: NodePaths, sessionId: string, options: { token?: string; scopeToken?: string; pid?: number; startedAt?: number } = {}): void {
  const token = options.token ?? TOKEN;
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  writeJsonAtomic(listenerScope(paths, sessionId), { token: options.scopeToken ?? token, listed: true, order: NOW - 2_000 });
  writeJsonAtomic(listenerLock(paths, sessionId), {
    token, pid: options.pid ?? LIVE_PID, startedAt: options.startedAt ?? NOW - 2_000, order: NOW - 2_000, event: "Stop",
  });
}

test("fresh idle state, exact restart authority, safe mode and matching live listener are reported separately", (t) => {
  const paths = fixture(t);
  snapshot(paths, [{ sessionId: A, name: "review", state: "idle" }, { sessionId: B, state: "busy" }]);
  rememberMode(paths, A, "default");
  listener(paths, A);
  const result = check(paths, policy([A]));
  assert.deepEqual(result, {
    ok: true,
    snapshot: { status: "fresh", reasonCode: "observed", rejectedRows: 0, incompleteRows: 0, unseenRuntimes: [], truncated: false, countScope: "observed-valid-rows", completeness: "complete", updatedAt: "2026-10-15T11:59:59.000Z", ageSeconds: 1 },
    wakeEnabled: true, observedIdle: 1, observedPolicyEligible: 1, observedExplicitRestartAuthorized: 1,
    observedMissingExplicitRestartAuthorization: 0,
    rememberedPermission: { allowed: 1, restricted: 0, unknown: 0 },
    liveListedListeners: { verified: 1, missing: 0, unreadable: 0, stale: 0, mismatched: 0 },
  });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("wildcard eligibility is not reported as explicit restart authority or listener readiness", (t) => {
  const paths = fixture(t);
  snapshot(paths, [{ sessionId: A, name: "review", state: "idle" }]);
  rememberMode(paths, A, "default");
  const result = check(paths, policy(["*"]));
  assert.deepEqual(result, {
    ok: true,
    snapshot: { status: "fresh", reasonCode: "observed", rejectedRows: 0, incompleteRows: 0, unseenRuntimes: [], truncated: false, countScope: "observed-valid-rows", completeness: "complete", updatedAt: "2026-10-15T11:59:59.000Z", ageSeconds: 1 },
    wakeEnabled: true, observedIdle: 1, observedPolicyEligible: 1, observedExplicitRestartAuthorized: 0,
    observedMissingExplicitRestartAuthorization: 1,
    rememberedPermission: { allowed: 1, restricted: 0, unknown: 0 },
    liveListedListeners: { verified: 0, missing: 1, unreadable: 0, stale: 0, mismatched: 0 },
    detail: "an idle eligible session lacks explicit restart authorization; add its exact id or unique name to wake.sessions before a missing-mode SessionStart can arm",
  });
});

test("a verified wildcard listener is observed without becoming restart-authorized or implying readiness", (t) => {
  const paths = fixture(t);
  snapshot(paths, [{ sessionId: A, name: "review", state: "idle" }]);
  rememberMode(paths, A, "default");
  listener(paths, A);
  const result = check(paths, policy(["*"]));
  assert.equal(result.observedPolicyEligible, 1);
  assert.equal(result.observedExplicitRestartAuthorized, 0);
  assert.deepEqual(result.liveListedListeners, { verified: 1, missing: 0, unreadable: 0, stale: 0, mismatched: 0 });
  assert.equal("ready" in result, false);
});

test("permission and listener evidence fail closed without exposing tokens", (t) => {
  const paths = fixture(t);
  snapshot(paths, [{ sessionId: A, state: "idle" }, { sessionId: B, state: "idle" }]);
  rememberMode(paths, A, "bypassPermissions");
  listener(paths, A);
  listener(paths, B, { scopeToken: "DIFFERENT_SYNTHETIC_TOKEN" });
  const result = check(paths, policy([A, B]));
  assert.deepEqual((result.rememberedPermission as Record<string, unknown>), { allowed: 0, restricted: 1, unknown: 1 });
  assert.deepEqual((result.liveListedListeners as Record<string, unknown>), { verified: 1, missing: 0, unreadable: 0, stale: 0, mismatched: 1 });
  assert.equal("ready" in result, false);
  assert.equal(JSON.stringify(result).includes("TOKEN"), false);
});

test("an unrecognized remembered permission string remains unknown", (t) => {
  const paths = fixture(t);
  snapshot(paths, [{ sessionId: A, state: "idle" }]);
  rememberMode(paths, A, "futureMode");
  listener(paths, A);
  const result = check(paths, policy([A]));
  assert.deepEqual(result.rememberedPermission, { allowed: 0, restricted: 0, unknown: 1 });
  assert.equal("ready" in result, false);
});

test("a missing listener is distinct from an unreadable listener source", (t) => {
  const missing = fixture(t);
  snapshot(missing, [{ sessionId: A, state: "idle" }]);
  rememberMode(missing, A, "default");
  assert.deepEqual((check(missing, policy([A])).liveListedListeners as Record<string, unknown>),
    { verified: 0, missing: 1, unreadable: 0, stale: 0, mismatched: 0 });

  const unreadable = fixture(t);
  snapshot(unreadable, [{ sessionId: A, state: "idle" }]);
  rememberMode(unreadable, A, "default");
  fs.mkdirSync(listenerLock(unreadable, A), { recursive: true });
  assert.deepEqual((check(unreadable, policy([A])).liveListedListeners as Record<string, unknown>),
    { verified: 0, missing: 0, unreadable: 1, stale: 0, mismatched: 0 });
});

test("missing, unreadable and stale snapshots report observed idle state as unknown", (t) => {
  const missing = fixture(t);
  assert.deepEqual(check(missing, policy([A])), {
    ok: false, snapshot: { status: "missing", reasonCode: "missing", completeness: "unknown", rejectedRows: "unknown", incompleteRows: "unknown", unseenRuntimes: "unknown", truncated: "unknown", countScope: "observed-valid-rows" }, wakeEnabled: true, observedIdle: "unknown",
    observedPolicyEligible: "unknown", observedExplicitRestartAuthorized: "unknown",
    detail: "no successful local session snapshot is available",
  });

  const unreadable = fixture(t);
  fs.mkdirSync(path.dirname(unreadable.sessions), { recursive: true });
  fs.writeFileSync(unreadable.sessions, "not json");
  assert.equal((check(unreadable, policy([A])).snapshot as { status: string }).status, "unreadable");
  assert.equal(check(unreadable, policy([A])).observedIdle, "unknown");

  const stale = fixture(t);
  snapshot(stale, [{ sessionId: A, state: "idle" }], NOW - 121_000);
  const result = check(stale, policy([A]));
  assert.deepEqual(result.snapshot, { status: "stale", reasonCode: "stale", completeness: "unknown", rejectedRows: "unknown", incompleteRows: "unknown", unseenRuntimes: "unknown", truncated: "unknown", countScope: "observed-valid-rows", updatedAt: "2026-10-15T11:57:59.000Z", ageSeconds: 121 });
  assert.equal(result.observedIdle, "unknown");
});

test("intentional wake opt-out remains a known disabled state", (t) => {
  const paths = fixture(t);
  snapshot(paths, [{ sessionId: A, state: "idle" }]);
  const result = check(paths, { version: 1, allowedCommands: [] });
  assert.deepEqual(result, {
    ok: true,
    snapshot: { status: "fresh", reasonCode: "observed", rejectedRows: 0, incompleteRows: 0, unseenRuntimes: [], truncated: false, countScope: "observed-valid-rows", completeness: "complete", updatedAt: "2026-10-15T11:59:59.000Z", ageSeconds: 1 },
    wakeEnabled: false, observedIdle: 1, observedPolicyEligible: 0, observedExplicitRestartAuthorized: 0,
    observedMissingExplicitRestartAuthorization: 0,
    rememberedPermission: { allowed: 0, restricted: 0, unknown: 0 },
    liveListedListeners: { verified: 0, missing: 0, unreadable: 0, stale: 0, mismatched: 0 },
  });

  const missing = fixture(t);
  assert.deepEqual(check(missing, { version: 1, allowedCommands: [] }), {
    ok: true, snapshot: { status: "missing", reasonCode: "missing", completeness: "unknown", rejectedRows: "unknown", incompleteRows: "unknown", unseenRuntimes: "unknown", truncated: "unknown", countScope: "observed-valid-rows" }, wakeEnabled: false, observedIdle: "unknown",
    observedPolicyEligible: 0, observedExplicitRestartAuthorized: 0, observedMissingExplicitRestartAuthorization: 0,
    rememberedPermission: { allowed: 0, restricted: 0, unknown: 0 },
    liveListedListeners: { verified: 0, missing: 0, unreadable: 0, stale: 0, mismatched: 0 },
    detail: "wake is disabled; observed idle state is unknown and is not required for listener evidence",
  });
});

test("snapshot completeness is preserved and legacy or partial listings never imply a total population", (t) => {
  const partial = fixture(t);
  snapshot(partial, [{ sessionId: A, state: "idle" }], NOW - 1_000, ["claude-code"]);
  const partialResult = check(partial, policy([A]));
  assert.equal((partialResult.snapshot as Record<string, unknown>).completeness, "partial");
  assert.equal(partialResult.observedIdle, 1);
  assert.equal("currentIdle" in partialResult, false);

  const legacy = fixture(t);
  fs.mkdirSync(path.dirname(legacy.sessions), { recursive: true });
  writeJsonAtomic(legacy.sessions, { updatedAt: new Date(NOW - 1_000).toISOString(),
    sessions: [{ sessionId: A, runtime: "claude-code", state: "idle" }] });
  const legacyResult = check(legacy, policy([A]));
  assert.equal((legacyResult.snapshot as Record<string, unknown>).completeness, "unknown");
  assert.equal(legacyResult.observedIdle, 1);
  assert.equal("currentIdle" in legacyResult, false);
});
