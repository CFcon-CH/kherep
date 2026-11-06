import fs from "node:fs";

import {
  bypassesPermissions, isPlainSessionId, listenerLock, listenerScope, modeFile, type ListenerLock, type ListenerScope,
} from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { explicitlyListed, wakeAllowed, type NodePolicy } from "./policy.mts";
import { WAKE_MAX_WAIT_MS } from "./wake-hook.mts";

import { at, readWakeSnapshot, snapshotObject as object, type Clock, type WakeSession } from "./wake-snapshot.mts";
export { SESSION_SNAPSHOT_FRESH_MS } from "./wake-snapshot.mts";

type ReadResult<T> = { status: "ok"; value: T } | { status: "missing" | "unreadable" };

function readJson<T>(file: string, valid: (value: unknown) => value is T): ReadResult<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const value: unknown = JSON.parse(text);
    return valid(value) ? { status: "ok", value } : { status: "unreadable" };
  } catch {
    return { status: "unreadable" };
  }
}

function listenerLockRecord(value: unknown): value is ListenerLock {
  if (!object(value) || typeof value.token !== "string" || value.token.length === 0) return false;
  return Number.isSafeInteger(value.pid) && typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
    && (value.event === "Stop" || value.event === "UserPromptSubmit" || value.event === "SessionStart");
}

function listenerScopeRecord(value: unknown): value is ListenerScope {
  return object(value) && typeof value.token === "string" && value.token.length > 0 && typeof value.listed === "boolean";
}

function permissionModeRecord(value: unknown): value is { permissionMode: string } {
  return object(value) && typeof value.permissionMode === "string" && value.permissionMode.length > 0;
}

const ALLOWED_PERMISSION_MODES = new Set(["auto", "default", "acceptEdits", "plan", "dontAsk"]);

function disabledEvidence(snapshot: Record<string, unknown>, observedIdle: number | "unknown"): Record<string, unknown> & { ok: boolean } {
  return {
    ok: true, snapshot, wakeEnabled: false, observedIdle, observedPolicyEligible: 0, observedExplicitRestartAuthorized: 0,
    observedMissingExplicitRestartAuthorization: 0,
    rememberedPermission: { allowed: 0, restricted: 0, unknown: 0 },
    liveListedListeners: { verified: 0, missing: 0, unreadable: 0, stale: 0, mismatched: 0 },
    ...(observedIdle === "unknown" ? {
      detail: "wake is disabled; observed idle state is unknown and is not required for listener evidence",
    } : {}),
  };
}

// Read-only local evidence for Claude idle wake. Counts are deliberately
// aggregate: doctor exposes no listener token, policy path or session id.
export function checkWakeReadiness(paths: NodePaths, policy: NodePolicy | null,
  pidAlive: (pid: unknown) => boolean, now: Clock): Record<string, unknown> & { ok: boolean } {
  if (!policy) return { ok: false, snapshot: { status: "unknown" }, wakeEnabled: "unknown", observedIdle: "unknown",
    observedPolicyEligible: "unknown", observedExplicitRestartAuthorized: "unknown",
    detail: "wake listener evidence is unknown because policy is unreadable" };
  const wakeEnabled = policy.wake !== undefined;
  const { snapshot, sessions } = readWakeSnapshot(paths, now);
  if (snapshot.status !== "fresh") {
    if (!wakeEnabled) return disabledEvidence({ ...snapshot }, "unknown");
    const detail = snapshot.status === "missing" ? "no successful local session snapshot is available"
      : snapshot.status === "stale" ? "the local session snapshot is stale; observed idle state is unknown"
      : "the local session snapshot is unreadable; observed idle state is unknown";
    return { ok: false, snapshot, wakeEnabled, observedIdle: "unknown", observedPolicyEligible: "unknown",
      observedExplicitRestartAuthorized: "unknown", detail };
  }
  const idle = sessions.filter(s => s.runtime === "claude-code" && ["idle", "idle-loaded"].includes(s.state));
  if (!wakeEnabled) return disabledEvidence({ ...snapshot }, idle.length);
  const refs = (session: WakeSession) => [session.sessionId, ...(session.name ? [session.name] : [])];
  const eligible = idle.filter((session) => wakeAllowed(policy, refs(session)));
  const authorized = eligible.filter((session) => explicitlyListed(policy, refs(session)));
  const rememberedPermission = { allowed: 0, restricted: 0, unknown: 0 };
  const liveListedListeners = { verified: 0, missing: 0, unreadable: 0, stale: 0, mismatched: 0 };

  // Sampled before the lock reads: a lock created after it counts as stale, which
  // moves one count inside an ok check and never doctor's verdict.
  const observed = at(now);
  let unsupported = 0;
  for (const session of eligible) {
    if (!isPlainSessionId(session.sessionId)) {
      rememberedPermission.unknown++;
      unsupported++;
      continue;
    }
    const mode = readJson(modeFile(paths, session.sessionId), permissionModeRecord);
    if (mode.status !== "ok") rememberedPermission.unknown++;
    else if (bypassesPermissions(mode.value.permissionMode)) rememberedPermission.restricted++;
    else if (ALLOWED_PERMISSION_MODES.has(mode.value.permissionMode)) rememberedPermission.allowed++;
    else rememberedPermission.unknown++;

    const lock = readJson(listenerLock(paths, session.sessionId), listenerLockRecord);
    const scope = readJson(listenerScope(paths, session.sessionId), listenerScopeRecord);
    if (lock.status !== "ok") liveListedListeners[lock.status]++;
    else if (scope.status !== "ok") liveListedListeners[scope.status]++;
    else if (lock.value.token !== scope.value.token || scope.value.listed !== true) liveListedListeners.mismatched++;
    else if (!pidAlive(lock.value.pid) || observed < lock.value.startedAt || observed - lock.value.startedAt > WAKE_MAX_WAIT_MS) {
      liveListedListeners.stale++;
    } else liveListedListeners.verified++;
  }

  const missingExplicitRestartAuthorization = eligible.length - authorized.length;
  return {
    ok: true,
    snapshot,
    wakeEnabled, observedIdle: idle.length, observedPolicyEligible: eligible.length,
    observedExplicitRestartAuthorized: authorized.length,
    observedMissingExplicitRestartAuthorization: missingExplicitRestartAuthorization,
    rememberedPermission, liveListedListeners: { ...liveListedListeners, ...(unsupported ? { unsupported } : {}) },
    ...(missingExplicitRestartAuthorization > 0 ? {
      detail: "an idle eligible session lacks explicit restart authorization; add its exact id or unique name to wake.sessions before a missing-mode SessionStart can arm",
    } : {}),
  };
}
