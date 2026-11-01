import fs from "node:fs";
import { livenessAdmission } from "./session-lifecycle.mts";
import path from "node:path";

import { bypassesPermissions, takeTurn, type WakeGrant } from "./autonomy.mts";
import { codexHome, currentCodexApp } from "./codex-app.mts";
import { findCodex } from "./codex-binary.mts";
import { busyPolicyFingerprint, busyWakeDisabled } from "./codex-busy-policy.mts";
import { tuiMarker } from "./codex-daemon.mts";
import { queueProducerIdentity } from "./codex-queue-context.mts";
import { queueArgs, runQueue } from "./codex-queue-run.mts";
import { MAX_NATIVE_ATTEMPTS, nativeAttemptsPath, nativeQueueInput } from "./codex-native-attempts.mts";
import { reserveNativeOwner, releaseNativeOwner } from "./codex-native-pending.mts";
import { reconcileNativeQueues } from "./codex-native-reconcile.mts";
import { CODEX_ACTIVE_MS, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { ensureDir, readConfig } from "./config.mts";
import { getMessage, MAX_REPLY_DEPTH, writeJsonAtomic } from "./inbox.mts";
import { explicitlyListed, readPolicy, wakeAllowed, wakeBudget } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { waitForServiceAdmission, type ServiceAdmission } from "./service-drain.mts";
import { listTasks } from "./task-records.mts";

// A separate namespace leaves legacy Queue cards/bindings untouched. An
// unreadable, partial or uncertain attempt is never interpreted as absent.
export { MAX_NATIVE_ATTEMPTS } from "./codex-native-attempts.mts";
const MAX_BATCH = 8;
const pending = new Map<string, Promise<void>>();
let nativeLane: Promise<void> = Promise.resolve();
export function nativeAttemptDir(deps: RunnerDeps, owner: string): string {
  return nativeAttemptsPath(deps.paths, owner);
}

export async function nativeQueueIdle(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
}

function reconcile(deps: RunnerDeps, owner: string, admission: ServiceAdmission): Promise<void> {
  return deps.codex?.reconcileQueue?.(owner, admission) ?? reconcileNativeQueues(deps.paths, owner, {}, admission);
}

// Recovery shares the bounded serial lane, but never reserves an enqueue slot.
export function scheduleNativeReconciliation(deps: RunnerDeps, owner: string, log: (line: string) => void): void {
  const key = `${path.join(deps.paths.dir, owner)}:reconcile`;
  if (pending.has(key)) return;
  const work = nativeLane.then(() => new Promise<void>((resolve) => { setImmediate(resolve); }))
    .then(() => waitForServiceAdmission(deps.paths, admission => reconcile(deps, owner, admission), { probe: deps.serviceOwner }))
    .catch(() => { log("kherep-node: native queue reconciliation pending"); })
    .finally(() => { pending.delete(key); });
  pending.set(key, work);
  nativeLane = work;
}

// Independent of the CP hint lane: a stalled CLI cannot delay publication.
// Off unless wake.nativeQueue is true (issue #429); the CP hint path is unchanged.
export function scheduleNativeQueue(deps: RunnerDeps, owner: string, messageIds: string[],
  grant: WakeGrant | undefined, log: (line: string) => void): void {
  if (deps.policy.wake?.nativeQueue !== true) return;
  const key = path.join(deps.paths.dir, owner);
  if (pending.has(key)) return;
  const fingerprint = busyPolicyFingerprint(deps.policy);
  const work = nativeLane.then(() => new Promise<void>((resolve) => { setImmediate(resolve); }))
    .then(() => waitForServiceAdmission(deps.paths,
      admission => produce(deps, owner, messageIds, fingerprint, grant, admission), { probe: deps.serviceOwner }))
    .catch(() => { log("kherep-node: native Codex Queue outcome unavailable; original intake remains pending"); })
    .finally(() => { pending.delete(key); });
  pending.set(key, work);
  nativeLane = work;
}

function admitted(deps: RunnerDeps, owner: string, messageIds: string[], fingerprint: string, grant?: WakeGrant):
  { ids: string[]; budget: ReturnType<typeof wakeBudget> } | null {
  const now = deps.now?.() ?? Date.now();
  if (livenessAdmission(deps.paths, { runtime: "codex", sessionId: owner }, "queue", now, undefined, deps.livenessAuthority) === null) return null;
  const policy = readPolicy(deps.paths.policy, true);
  const session = readCodexSession(deps.paths, owner);
  const seen = Date.parse(session?.lastSeen ?? "");
  if (!readConfig(deps.paths.config) || !policy || busyPolicyFingerprint(policy) !== fingerprint
    || !policy.wake || !policy.wake.nativeQueue || busyWakeDisabled(deps.paths) || !session || session.sessionId !== owner
    || !Number.isFinite(seen) || seen > now || now - seen > CODEX_ACTIVE_MS
    || listTasks(deps.paths).some((task) => task.sessionId === owner)) return null;
  if (bypassesPermissions(session.permissionMode)
    || (session.permissionMode === undefined && !explicitlyListed(policy, [owner]))) return null;
  if (!wakeAllowed(policy, [owner])) {
    if (grant !== "codexApp" || !policy.wake.codexApp) return null;
    const home = deps.codex?.home ?? codexHome();
    // Both a reachable TUI and an unresolved marker exclude automatic App
    // authorization. Full-id policy authorization remains independent of it.
    if (fs.existsSync(tuiMarker(home, owner))) return null;
    const live = listCodexSessions(deps.paths, now).map((record) => record.sessionId);
    if (currentCodexApp(deps.paths, live, home) !== owner) return null;
  }
  const ids = messageIds.filter((id) => {
    const record = getMessage(deps.paths.inbox, id);
    const depth = record?.depth ?? 0;
    return record?.messageId === id && record.toSession === owner && record.state === "accepted"
      && Number.isSafeInteger(depth) && depth >= 0 && depth < MAX_REPLY_DEPTH;
  });
  return ids.length ? { ids: [...new Set(ids)], budget: wakeBudget(policy) } : null;
}

function absent(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function produce(deps: RunnerDeps, owner: string, messageIds: string[], fingerprint: string, grant: WakeGrant | undefined,
  serviceAdmission: ServiceAdmission): Promise<void> {
  const file = (deps.codex?.findCodex ?? findCodex)();
  if (!file) return;
  const admission = admitted(deps, owner, messageIds, fingerprint, grant);
  if (!admission) return;
  const dir = nativeAttemptDir(deps, owner);
  ensureDir(dir);
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("invalid native attempt directory");
  const storedAttemptCount = fs.readdirSync(dir).length;
  const remainingCapacity = Math.max(0, MAX_NATIVE_ATTEMPTS - storedAttemptCount);
  const available = admission.ids.filter((id) => absent(path.join(dir, `${id}.json`)));
  const ids = available.slice(0, Math.min(MAX_BATCH, remainingCapacity));
  if (!ids.length) return;
  const producer = queueProducerIdentity(file, queueArgs(owner, ids.length), deps);
  if (producer.route !== "local" || producer.approvedFiles.length === 0) return;
  const now = deps.now?.() ?? Date.now();
  if (!reserveNativeOwner(deps.paths, owner, ids)) return;
  if (takeTurn(deps.paths, owner, now, admission.budget) !== "ok") {
    releaseNativeOwner(deps.paths, owner, ids);
    return;
  }
  const claimed: string[] = [];
  for (const messageId of ids) {
    try {
      fs.writeFileSync(path.join(dir, `${messageId}.json`), JSON.stringify({ version: 1, owner, messageId,
        attemptedAt: now, state: "attempted", producer }), { flag: "wx", mode: 0o600 });
      claimed.push(messageId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!claimed.length) return;
  const expectedInput = nativeQueueInput(owner, claimed.length);
  const settle = (state: string, queueId?: string): void => {
    for (const messageId of claimed) writeJsonAtomic(path.join(dir, `${messageId}.json`),
      { version: 1, owner, messageId, attemptedAt: now, state, producer,
        groupMessageIds: claimed, expectedInput,
        ...(queueId ? { queueId } : {}) });
  };
  const current = admitted(deps, owner, claimed, fingerprint, grant);
  if (!current || current.ids.length !== claimed.length) {
    settle("cancelled-before-submit");
    releaseNativeOwner(deps.paths, owner, ids);
    return;
  }
  try {
    const result = await runQueue({ ...deps, codex: { ...deps.codex,
      findCodex: () => file, home: producer.resolvedCodexHome } }, queueArgs(owner, claimed.length), producer, serviceAdmission);
    settle(result.queueId ? "submitted" : "uncertain", result.queueId);
  } catch { settle("uncertain"); return; }
  // Explicit processing ACK may have delivered content while native admission was in flight.
  // Cleanup failure must never overwrite the successfully persisted queue ID.
  await reconcile(deps, owner, serviceAdmission);
}
