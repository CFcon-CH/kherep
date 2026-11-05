import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { advertisedCapabilities, isAllowed, loadPolicy } from "./policy.mts";
import { parseSessionsPolicy } from "./session-policy.mts";

const ROOT = path.resolve(os.tmpdir(), "ws");

function policyWith(t: test.TestContext, sessions: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-spol-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, allowedCommands: ["session.list"], ...(sessions === undefined ? {} : { sessions }) }));
  return loadPolicy(file);
}

test("sessions are off without a section, and the session commands are refused", (t) => {
  const policy = policyWith(t, undefined);
  assert.equal(policy.sessions, undefined);
  assert.equal(isAllowed(policy, "session.start"), false);
  assert.deepEqual(advertisedCapabilities(policy), ["session.list", "messaging.ack.v1", "messaging.progress.v2", "messaging.loop-brake.v1", "messaging.diagnostics.v1"]);
});

test("a malformed section turns sessions and delegation off, the rest of the policy stays", (t) => {
  for (const bad of [[], "yes", { enabled: true, workspaceRoots: ["relative/dir"] }, { enabled: true, workspaceRoots: [ROOT], maxConcurrent: 0 },
    { enabled: true, workspaceRoots: [ROOT], maxStartsPerDay: "10" }, { enabled: true, workspaceRoots: [ROOT], defaultPermissionMode: "bypassPermissions" },
    { enabled: true, workspaceRoots: [ROOT], delegate: 1 }]) {
    const policy = policyWith(t, bad);
    assert.equal(policy.sessions, undefined, JSON.stringify(bad));
    assert.deepEqual(policy.allowedCommands, ["session.list"]);
  }
  // No workspace root: nowhere to start a session.
  assert.equal(parseSessionsPolicy({ enabled: true })?.enabled, false);
});

test("an enabled section applies the operator caps, the listed runtimes and never bypassPermissions", (t) => {
  const policy = policyWith(t, { enabled: true, workspaceRoots: [ROOT], runtimes: ["claude", "codex", "gemini"],
    permissionModes: ["auto", "bypassPermissions", "acceptEdits"], maxConcurrent: 7, maxStartsPerDay: 50, maxRuntimeMinutes: 30 });
  assert.deepEqual(policy.sessions, {
    enabled: true, runtimes: ["claude", "codex"], workspaceRoots: [ROOT], permissionModes: ["auto", "acceptEdits"], defaultPermissionMode: "auto",
    maxConcurrent: 3, maxStartsPerDay: 10, maxRuntimeMinutes: 30, delegate: { request: false, accept: false }, ownTaskControl: false,
  });
  assert.equal(isAllowed(policy, "session.start"), true);
  assert.deepEqual(advertisedCapabilities(policy), ["session.list", "messaging.ack.v1", "messaging.progress.v2", "messaging.loop-brake.v1", "messaging.diagnostics.v1", "sessions.v1"]);
});

test("runtimes default to claude only; codex runs only where the policy lists it", (t) => {
  assert.deepEqual(policyWith(t, { enabled: true, workspaceRoots: [ROOT] }).sessions?.runtimes, ["claude"]);
  assert.deepEqual(policyWith(t, { enabled: true, workspaceRoots: [ROOT], runtimes: ["codex"] }).sessions?.runtimes, ["codex"]);
});

test("delegation is off by default and each side opts in separately", (t) => {
  const accept = policyWith(t, { enabled: true, workspaceRoots: [ROOT], delegate: { accept: true } });
  assert.deepEqual(advertisedCapabilities(accept), ["session.list", "messaging.ack.v1", "messaging.progress.v2", "messaging.loop-brake.v1", "messaging.diagnostics.v1", "sessions.v1",
    "sessions.delegate.accept.v1"]);
  // A node that only asks for tasks needs no sessions of its own.
  const request = policyWith(t, { delegate: { request: true } });
  assert.deepEqual(advertisedCapabilities(request), ["session.list", "messaging.ack.v1", "messaging.progress.v2", "messaging.loop-brake.v1", "messaging.diagnostics.v1", "sessions.delegate.request.v1"]);
  assert.equal(isAllowed(request, "session.start"), false);
  // accept without enabled sessions accepts nothing.
  assert.equal(policyWith(t, { enabled: false, workspaceRoots: [ROOT], delegate: { accept: true } }).sessions?.delegate.accept, false);
});

test("owner task control is default off and advertises only with enabled sessions", (t) => {
  const base = policyWith(t, { enabled: true, workspaceRoots: [ROOT], runtimes: ["codex"] });
  assert.equal(base.sessions?.ownTaskControl, false);
  assert.equal(advertisedCapabilities(base).includes("sessions.own-task-control.v1"), false);
  const enabled = policyWith(t, { enabled: true, workspaceRoots: [ROOT], runtimes: ["codex"], ownTaskControl: true });
  assert.equal(enabled.sessions?.ownTaskControl, true);
  assert.equal(advertisedCapabilities(enabled).includes("sessions.own-task-control.v1"), true);
  // Issue #240: an owner with task control also takes the reported task state in query results.
  assert.equal(advertisedCapabilities(enabled).includes("sessions.own-task-control.report.v1"), true);
  assert.equal(advertisedCapabilities(base).includes("sessions.own-task-control.report.v1"), false);
  const disabled = policyWith(t, { enabled: false, workspaceRoots: [ROOT], runtimes: ["codex"], ownTaskControl: true });
  assert.equal(disabled.sessions?.ownTaskControl, false);
  assert.equal(advertisedCapabilities(disabled).includes("sessions.own-task-control.v1"), false);
  const noRuntime = policyWith(t, { enabled: true, workspaceRoots: [ROOT], runtimes: [], ownTaskControl: true });
  assert.equal(advertisedCapabilities(noRuntime).includes("sessions.own-task-control.v1"), false);
});
