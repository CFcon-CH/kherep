import type { DaemonState } from "./daemon-state.mts";
import type { SourceIdentity } from "./daemon-source.mts";
import { lifecycleDefaults, type LifecycleDependencies } from "./service-lifecycle.mts";
import type { NodePaths } from "./config.mts";
import { readServiceBackup, snapshotDigests, type ServiceBackup, type ServiceCandidate, type ServiceReceipt } from "./service-records.mts";
import {
  FAILED_WRITE_SNAPSHOT, STOP_NOT_ISSUED, isStopCode, stopCode, type FailedServiceWrite, type NativeServiceSnapshot, type ServiceBinding, type StopCode,
} from "./service-types.mts";

export const SERVICE_STAGES = ["stop", "prove-stopped", "write", "verify", "start", "health", "settle", "receipt"] as const;
export type ServiceStage = typeof SERVICE_STAGES[number];

// #582 (A2 P1-A): the selector names the service; the binding adds the node executable and log path an adoption rewrites.
export const sameSelector = (left: ServiceBinding, right: ServiceBinding): boolean => left.serviceName === right.serviceName
  && left.taskPath === right.taskPath && left.platform === right.platform && left.workspace === right.workspace
  && left.configRoot === right.configRoot;
export const sameBinding = (left: ServiceBinding, right: ServiceBinding): boolean => sameSelector(left, right)
  && left.nodeExecutable === right.nodeExecutable && left.logFile === right.logFile;
export const exact = (left: Buffer, right: Buffer): boolean => left.equals(right);

export function failedWriteSnapshot(cause: unknown): NativeServiceSnapshot | undefined {
  if (!(cause instanceof Error)) return undefined;
  const snapshot = (cause as FailedServiceWrite)[FAILED_WRITE_SNAPSHOT];
  return snapshot && Buffer.isBuffer(snapshot.definition) && Buffer.isBuffer(snapshot.security) ? snapshot : undefined;
}

export interface ServiceTransactionResult { serviceName: string; taskPath?: string; platform: string; source: SourceIdentity; backupId?: string; recovery?: string }

export function receiptFor(binding: ServiceBinding, snapshot: NativeServiceSnapshot, now: string, backup?: ServiceBackup): ServiceReceipt {
  return { version: 1, binding, ...snapshotDigests(snapshot), activatedAt: now, ...(backup ? { previousBackup: backup.id } : {}) };
}

// Issue #472: success is reported only after the native service and its daemon are re-read as settled.
export async function assertSettled(input: LifecycleDependencies, binding: ServiceBinding, expected: NativeServiceSnapshot,
  daemon: DaemonState | undefined, shouldRun: boolean): Promise<NativeServiceSnapshot> {
  const snapshot = await input.adapter.read(binding);
  if (!snapshot) throw new Error("managed service definition disappeared after activation");
  if (!exact(snapshot.definition, expected.definition) || !exact(snapshot.security, expected.security)) {
    throw new Error("managed service definition changed during activation");
  }
  if (!shouldRun) return snapshot;
  if (snapshot.running !== true) throw new Error("managed service is not running after activation");
  if (daemon) {
    const recorded = lifecycleDefaults(input).readState(input.paths);
    if ((snapshot.pid !== undefined && snapshot.pid !== daemon.pid) || recorded?.pid !== daemon.pid
      || recorded.startedAt !== daemon.startedAt || recorded.disconnectedAt) {
      throw new Error("managed service process does not match the recorded daemon");
    }
  }
  return snapshot;
}

// #472: a stop counts as issued unless the adapter tagged its failure as raised before any native effect.
export const stopNotIssued = (stage: ServiceStage, cause: unknown): boolean =>
  stage === "stop" && (cause as { code?: unknown } | null)?.code === STOP_NOT_ISSUED;

export function recoveryBlocker(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("RECOVERY_") ? code : "RECOVERY_STEP_FAILED";
}

type ServiceFailure<C extends string> = Error & { code: C; recovery: string; stage: ServiceStage; blocker?: string; stopCode?: StopCode };

// #677: the stop reason of a failed stop or stop proof travels on the failure itself, also when no candidate record is written.
export const stageStopCode = (stage: ServiceStage, cause: unknown): StopCode | undefined =>
  stage === "stop" || stage === "prove-stopped" ? stopCode(cause) : undefined;

// #677: an allowlisted stop failure that says the stopped daemon's family was not proven gone; never read from a message.
export function stopFamilyUnproven(cause: unknown): boolean {
  const value = cause as { code?: unknown; familyUnproven?: unknown } | null;
  return typeof value === "object" && value !== null && isStopCode(value.code) && value.familyUnproven === true;
}

export function serviceFailure<C extends string>(code: C, cause: unknown, recovery: string, stage: ServiceStage,
  blocker?: string, failedStop?: StopCode): ServiceFailure<C> {
  const fallback = code === "SERVICE_ROLLBACK_FAILED" ? "managed service rollback failed" : "managed service activation failed";
  const error = new Error(cause instanceof Error ? cause.message : fallback) as ServiceFailure<C>;
  error.code = code;
  error.recovery = recovery;
  error.stage = stage;
  if (blocker) error.blocker = blocker;
  if (failedStop) error.stopCode = failedStop;
  return error;
}

// #582: a candidate record is used only while the definition in place is exactly the recorded one, under the same binding.
export function candidateInPlace(pending: ServiceCandidate | null, existing: NativeServiceSnapshot | null, binding: ServiceBinding): pending is ServiceCandidate {
  if (!pending || !existing || !sameBinding(pending.binding, binding)) return false;
  const digests = snapshotDigests(existing);
  return digests.definitionDigest === pending.definitionDigest && digests.securityDigest === pending.securityDigest;
}

// Key-order independent JSON: a receipt written by another writer must still compare equal to its parsed round trip.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);

// #582 (review P2-5): the recorded prior is trusted only when it is the receipt's own definition and names this receipt.
// A missing or corrupt backup is "unbound" (A2 P2-B): the callers refuse with their fixed texts, the read error is never printed.
export function recordedPriorBackup(paths: NodePaths, pending: ServiceCandidate, receipt: ServiceReceipt | null)
  : { backup: ServiceBackup; snapshot: NativeServiceSnapshot } | null {
  if (!pending.backupId) return null;
  let prior: { backup: ServiceBackup; snapshot: NativeServiceSnapshot };
  try { prior = readServiceBackup(paths, pending.backupId); } catch { return null; }
  const bound = receipt
    ? prior.backup.definitionDigest === receipt.definitionDigest && prior.backup.securityDigest === receipt.securityDigest
      && canonical(prior.backup.priorReceipt) === canonical(receipt)
    : prior.backup.priorReceipt === undefined;
  if (pending.version === 2 && pending.recoveryBackupId) {
    if (!receipt || canonical(pending.receiptAnchor) !== canonical(receipt)
      || !pending.recoveryBinding || !sameBinding(pending.recoveryBinding, receipt.binding)) return null;
    try {
      const safety = readServiceBackup(paths, pending.recoveryBackupId).backup;
      if (canonical(safety.priorReceipt) !== canonical(receipt)
        || canonical(safety.priorSource) !== canonical(pending.recoveryBinding.source)) return null;
    } catch { return null; }
  }
  return bound ? prior : null;
}
