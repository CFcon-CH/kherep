import { automaticReplyDecision } from "./reply-admission.mts";
import fs from "node:fs";
import { blockerDiagnostic, type BlockerCode, type MessageDiagnostic } from "../protocol-diagnostics.mts";
import type { MessageProgressCode } from "../protocol-messages.mts";
import { livenessAdmissionVerdict, sessionVerdict } from "./session-lifecycle.mts";
import path from "node:path";

import { bypassesPermissions, takeTurn, type Budget, type WakeGrant } from "./autonomy.mts";
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
import { progressRecords } from "./delivery-progress.mts";
import { getMessage, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { explicitlyListed, readPolicy, wakeAllowed, wakeBudget } from "./policy.mts";
import { DISPLAY_TTL_MS } from "./session-liveness.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { waitForServiceAdmission, type ServiceAdmission } from "./service-drain.mts";
import { listTasks } from "./task-records.mts";

// A separate namespace leaves legacy Queue cards/bindings untouched. An
// unreadable, partial or uncertain attempt is never interpreted as absent.
export { MAX_NATIVE_ATTEMPTS } from "./codex-native-attempts.mts";
const MAX_BATCH = 8;
const pending = new Map<string, Promise<void>>();
// Issue #919 (design D6): the last refusal per owner, shown by queueFor where it writes awaiting-user-turn,
// so one writer vocabulary holds and the progress does not flip between rounds.
interface NativeBlocker { code: MessageProgressCode; detail?: BlockerCode; observedState?: MessageDiagnostic["observedState"] }
const blockers = new Map<string, NativeBlocker & { at: number; ids: Set<string> }>();
const storeFull = new Set<string>();
const notIdle = (observedState: MessageDiagnostic["observedState"]): NativeBlocker => ({ code: "awaiting-user-turn", detail: "target-not-idle", observedState });
const runtimePending: NativeBlocker = { code: "awaiting-user-turn", detail: "runtime-pending" };
function budgetBlocker(budget: Exclude<Budget, "ok">): NativeBlocker {
  switch (budget) {
    case "exhausted": return { code: "budget-exhausted" };
    case "spacing": return { code: "retry-pending", detail: "turn-spacing" };
    case "locked": return { code: "retry-pending", detail: "budget-lock-unavailable" };
  }
}
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
  const key = path.join(deps.paths.dir, owner);
  if (deps.policy.wake?.nativeQueue !== true) {
    blockers.delete(key);
    return;
  }
  if (pending.has(key)) return;
  const fingerprint = busyPolicyFingerprint(deps.policy);
  const work = nativeLane.then(() => new Promise<void>((resolve) => { setImmediate(resolve); }))
    .then(() => waitForServiceAdmission(deps.paths,
      admission => produce(deps, owner, messageIds, fingerprint, grant, admission, log), { probe: deps.serviceOwner }))
    .catch(() => { log("kherep-node: native Codex Queue outcome unavailable; original intake remains pending"); })
    .finally(() => { pending.delete(key); });
  pending.set(key, work);
  nativeLane = work;
}

type Admitted = { ids: string[]; budget: ReturnType<typeof wakeBudget> } | { blocker: NativeBlocker | null };
function admitted(deps: RunnerDeps, owner: string, messageIds: string[], fingerprint: string, grant?: WakeGrant): Admitted {
  const now = deps.now?.() ?? Date.now();
  const target = { runtime: "codex", sessionId: owner };
  const liveness = livenessAdmissionVerdict(deps.paths, target, "queue", now, undefined, deps.livenessAuthority);
  if (liveness === null) return { blocker: notIdle(sessionVerdict(deps.paths, target, now).state) };
  const policy = readPolicy(deps.paths.policy, true);
  const session = readCodexSession(deps.paths, owner);
  const seen = Date.parse(session?.lastSeen ?? "");
  // Refusals queueFor reports itself (wake-disabled, permission-restricted) or that last one round store no cause.
  if (!readConfig(deps.paths.config) || !policy || busyPolicyFingerprint(policy) !== fingerprint
    || !policy.wake || !policy.wake.nativeQueue || busyWakeDisabled(deps.paths)) return { blocker: null };
  if (!session || session.sessionId !== owner || !Number.isFinite(seen) || seen > now) return { blocker: notIdle("unknown") };
  // Issue #919 (D1): past the 12 h hook window only with fresh in-process idle-loaded holder evidence.
  if (now - seen > CODEX_ACTIVE_MS && liveness.state !== "idle-loaded") return { blocker: notIdle(liveness.state) };
  if (listTasks(deps.paths).some((task) => task.sessionId === owner)) return { blocker: null };
  if (bypassesPermissions(session.permissionMode)
    || (session.permissionMode === undefined && !explicitlyListed(policy, [owner]))) return { blocker: null };
  if (!wakeAllowed(policy, [owner])) {
    const refused = { blocker: { code: "wake-not-authorized" as const } };
    if (grant !== "codexApp" || !policy.wake.codexApp) return refused;
    const home = deps.codex?.home ?? codexHome();
    // Both a reachable TUI and an unresolved marker exclude automatic App
    // authorization. Full-id policy authorization remains independent of it.
    if (fs.existsSync(tuiMarker(home, owner))) return refused;
    // In-window threads only (#919, amendment A1): a stale thread is never the current app session.
    const live = listCodexSessions(deps.paths, now).map((record) => record.sessionId);
    if (currentCodexApp(deps.paths, live, home) !== owner) return refused;
  }
  const ids = messageIds.filter((id) => {
    const record = getMessage(deps.paths.inbox, id);
    return record?.messageId === id && record.toSession === owner && record.state === "accepted"
      && automaticReplyDecision(record).allowed;
  });
  return ids.length ? { ids: [...new Set(ids)], budget: wakeBudget(policy) } : { blocker: null };
}

// Issue #706 (design F4), #919 (D6): a refusal is visible in `msg status` with an
// existing code and diagnostic, as for the Codex task resume (codex-wake.mts).
// Only ids without an attempt file carry it. Observational: a failed write changes no admission.
function park(deps: RunnerDeps, owner: string, messageIds: string[], blocker: NativeBlocker | null, now: number): void {
  const key = path.join(deps.paths.dir, owner);
  if (!blocker) {
    blockers.delete(key);
    return;
  }
  try {
    const dir = nativeAttemptDir(deps, owner);
    const ids = new Set(messageIds.filter((id) => absent(path.join(dir, `${id}.json`))));
    blockers.set(key, { ...blocker, at: now, ids });
    show(deps, blocker, messageIds.flatMap((id) => {
      const record = getMessage(deps.paths.inbox, id);
      return ids.has(id) && record?.messageId === id && record.toSession === owner && record.state === "accepted" ? [record] : [];
    }), now);
  } catch { /* observational only */ }
}

function show(deps: RunnerDeps, blocker: NativeBlocker, records: InboxRecord[], now: number): void {
  progressRecords(deps.paths, records, "waiting", blocker.code, now, undefined,
    blocker.detail ? blockerDiagnostic(blocker.detail, now, "target-progress", blocker.observedState) : undefined);
}

// queueFor's awaiting-user-turn write: the owner's refusal of the last 60 s for its parked ids, plain otherwise.
export function nativeParkedProgress(deps: RunnerDeps, owner: string, records: InboxRecord[], now: number): void {
  const blocker = blockers.get(path.join(deps.paths.dir, owner));
  const fresh = blocker && now - blocker.at <= DISPLAY_TTL_MS ? blocker : undefined;
  const parked = records.filter((record) => fresh?.ids.has(record.messageId));
  if (fresh) show(deps, fresh, parked, now);
  progressRecords(deps.paths, records.filter((record) => !parked.includes(record)), "waiting", "awaiting-user-turn", now);
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
  serviceAdmission: ServiceAdmission, log: (line: string) => void): Promise<void> {
  const stamp = (): number => deps.now?.() ?? Date.now();
  const file = (deps.codex?.findCodex ?? findCodex)();
  if (!file) return park(deps, owner, messageIds, runtimePending, stamp());
  const admission = admitted(deps, owner, messageIds, fingerprint, grant);
  if ("blocker" in admission) return park(deps, owner, messageIds, admission.blocker, stamp());
  const dir = nativeAttemptDir(deps, owner);
  ensureDir(dir);
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("invalid native attempt directory");
  const storedAttemptCount = fs.readdirSync(dir).length;
  const remainingCapacity = Math.max(0, MAX_NATIVE_ATTEMPTS - storedAttemptCount);
  const available = admission.ids.filter((id) => absent(path.join(dir, `${id}.json`)));
  const ids = available.slice(0, Math.min(MAX_BATCH, remainingCapacity));
  if (!ids.length) {
    // Risk R4: no existing blocker code fits a full attempt store; one log line per owner and process.
    if (available.length && !storeFull.has(dir)) {
      storeFull.add(dir);
      log("kherep-node: native Codex Queue attempt store is full; messages stay on CP intake");
    }
    return park(deps, owner, messageIds, null, stamp());
  }
  const producer = queueProducerIdentity(file, queueArgs(owner, ids.length), deps);
  if (producer.route !== "local" || producer.approvedFiles.length === 0) return park(deps, owner, messageIds, runtimePending, stamp());
  const now = stamp();
  if (!reserveNativeOwner(deps.paths, owner, ids)) return park(deps, owner, messageIds, null, now);
  const budget = takeTurn(deps.paths, owner, now, admission.budget);
  if (budget !== "ok") {
    releaseNativeOwner(deps.paths, owner, ids);
    return park(deps, owner, messageIds, budgetBlocker(budget), now);
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
  if ("blocker" in current || current.ids.length !== claimed.length) {
    settle("cancelled-before-submit");
    releaseNativeOwner(deps.paths, owner, ids);
    return park(deps, owner, messageIds, "blocker" in current ? current.blocker : null, stamp());
  }
  park(deps, owner, messageIds, null, now);
  try {
    const result = await runQueue({ ...deps, codex: { ...deps.codex,
      findCodex: () => file, home: producer.resolvedCodexHome } }, queueArgs(owner, claimed.length), producer, serviceAdmission);
    settle(result.queueId ? "submitted" : "uncertain", result.queueId);
  } catch { settle("uncertain"); return; }
  // Explicit processing ACK may have delivered content while native admission was in flight.
  // Cleanup failure must never overwrite the successfully persisted queue ID.
  await reconcile(deps, owner, serviceAdmission);
}
