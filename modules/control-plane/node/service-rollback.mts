import type { DaemonState } from "./daemon-state.mts";
import {
  acquireServiceLock, readServiceBackup, readServiceCandidate, readServiceReceipt, removeServiceCandidate, removeServiceReceipt, saveServiceBackup,
  snapshotDigests, writeServiceReceipt, type ServiceCandidate,
} from "./service-records.mts";
import { captureCandidateBytes, failedCandidate, persistCandidate, restoreCandidateBytes } from "./service-candidate-record.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { issueServiceLaunchPermit } from "./service-launch-permit.mts";
import {
  healthy, lifecycleDefaults, prepareStop, proveStopped, restorePrior, ROLLBACK_HEALTH_TIMEOUT_MS, verifyExact, verifyStopOwnership,
  type LifecycleDependencies,
} from "./service-lifecycle.mts";
import {
  assertSettled, candidateInPlace, failedWriteSnapshot, recordedPriorBackup, recoveryBlocker, sameBinding, serviceFailure, stageStopCode, stopFamilyUnproven, stopNotIssued,
  type ServiceStage, type ServiceTransactionResult,
} from "./service-transaction-support.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";
import { recoverLegacyCandidate, type LegacyRecoveryOptions } from "./service-recovery.mts";

// #582: `service rollback` restores the receipt's definition, also over a recorded failed candidate (its bound prior
// backup replaces receipt.previousBackup). Moved from service-transaction.mts for the 250-line budget; re-exported there.
export async function rollbackManagedService(options: { binding: ServiceBinding; recover?: LegacyRecoveryOptions }, input: LifecycleDependencies): Promise<ServiceTransactionResult> {
  const release = acquireServiceLock(input.paths, input.ownerProbe);
  try {
    if (options.recover) await recoverLegacyCandidate(options.recover, input);
    return await rollbackLocked(options, input);
  } finally { release(); }
}

async function rollbackLocked(options: { binding: ServiceBinding }, input: LifecycleDependencies): Promise<ServiceTransactionResult> {
    const deps = lifecycleDefaults(input);
    const receipt = readServiceReceipt(input.paths);
    if (!receipt || !sameBinding(receipt.binding, options.binding)) throw new Error("rollback backup is unavailable for this service");
    const current = await input.adapter.read(receipt.binding);
    if (!current || current.running === "unknown") throw new Error("current managed service state cannot be verified");
    const currentDigests = snapshotDigests(current);
    const receiptMatch = currentDigests.definitionDigest === receipt.definitionDigest && currentDigests.securityDigest === receipt.securityDigest;
    // #582: the record is consulted only while the receipt does not match (A2 P2-A); an invalid record then throws before any mutation.
    const pending = receiptMatch ? null : readServiceCandidate(input.paths);
    const pendingMatch = !receiptMatch && candidateInPlace(pending, current, receipt.binding);
    const previousCandidate = pendingMatch ? captureCandidateBytes(input.paths) : null;
    if (!receiptMatch && !pendingMatch) throw new Error("current managed service drifted from its receipt");
    const currentBinding = pendingMatch ? pending.binding : receipt.binding;
    await input.adapter.validateManaged(current, currentBinding);
    const priorFound = pendingMatch ? recordedPriorBackup(input.paths, pending, receipt)
      : receipt.previousBackup ? readServiceBackup(input.paths, receipt.previousBackup) : null;
    if (!priorFound) throw new Error("rollback backup is unavailable for this service");
    const { backup, snapshot: previous } = priorFound;
    if (!backup.priorSource || !deps.verifySource(backup.priorSource)) throw new Error("previous source cannot be verified; rollback refused");
    const priorBinding = backup.priorReceipt?.binding
      ?? { ...options.binding, source: backup.priorSource, supervisorGeneration: undefined };
    const state = deps.readState(input.paths);
    if (current.running === false && state && deps.alive(state.pid)) throw new Error("a live daemon remains outside the stopped selected service");
    if (current.running === true && (!state || !deps.alive(state.pid)
      || !await input.adapter.processOwned(state.pid, currentBinding, state.startedAt))) throw new Error("current daemon ownership cannot be verified");
    const safety = saveServiceBackup(input.paths, current, { receipt, priorSource: currentBinding.source, now: deps.now() });
    let endDrain = () => {};
    let clearLaunchPermit = () => {};
    let drainSafeToRelease = true;
    let mutationStarted = false;
    let stopIssued = false, priorStopProven = current.running === false, writeAttempted = false, stage: ServiceStage = "stop";
    let previousSnapshot: NativeServiceSnapshot | undefined, candidatePersisted = false;
    let candidateRecord: ServiceCandidate = { version: 2, phase: "prepared", preparedAt: deps.now(), binding: priorBinding,
      ...snapshotDigests(previous), backupId: pendingMatch ? pending.backupId : safety.id, command: "rollback",
      recoveryBackupId: safety.id, recoveryBinding: currentBinding, receiptAnchor: receipt };
    // #472: a running node stays running even when the backup was taken from a stopped service.
    const shouldRun = current.running === true || previous.running === true;
    try {
      endDrain = beginServiceDrain(input.paths, input.ownerProbe);
      const runningState = current.running === true ? state : null;
      await prepareStop(currentBinding, runningState, input);
      await verifyExact(input.adapter, currentBinding, current);
      await verifyStopOwnership(currentBinding, runningState, input);
      mutationStarted = true;
      if (current.running === true) {
        stopIssued = true;
        const context = state ? { pid: state.pid, startedAt: state.startedAt } : undefined;
        await input.adapter.stop(currentBinding, context);
        stage = "prove-stopped";
        await proveStopped(currentBinding, context, deps);
        priorStopProven = true;
      }
      stage = "write";
      persistCandidate(input.paths, candidateRecord, input.writeCandidate);
      candidatePersisted = true;
      writeAttempted = true;
      await input.adapter.write(currentBinding, previous.definition, previous.security);
      stage = "verify";
      previousSnapshot = await verifyExact(input.adapter, currentBinding, previous);
      candidateRecord = { ...candidateRecord, phase: "attested", ...snapshotDigests(previousSnapshot) };
      persistCandidate(input.paths, candidateRecord, input.writeCandidate);
      let healthyState: DaemonState | undefined;
      if (shouldRun) {
        stage = "start";
        if (priorBinding.platform === "win32" && priorBinding.supervisorGeneration) {
          clearLaunchPermit = issueServiceLaunchPermit(input.paths, priorBinding);
        }
        await input.adapter.start(priorBinding);
        stage = "health";
        // #582 decision 5: the prior source may predate #581 and maintain its queue before it connects, as in restorePrior.
        healthyState = await healthy(priorBinding, state ?? undefined, { ...input, timeoutMs: input.timeoutMs ?? ROLLBACK_HEALTH_TIMEOUT_MS },
          !backup.priorReceipt);
      }
      stage = "settle";
      await assertSettled(input, currentBinding, previous, healthyState, shouldRun);
      stage = "receipt";
      if (backup.priorReceipt) writeServiceReceipt(input.paths, backup.priorReceipt); else removeServiceReceipt(input.paths);
      if (JSON.stringify(readServiceReceipt(input.paths)) !== JSON.stringify(backup.priorReceipt ?? null)) {
        throw new Error("managed service rollback receipt persistence could not be verified");
      }
      removeServiceCandidate(input.paths);
      return { serviceName: priorBinding.serviceName, ...(priorBinding.taskPath ? { taskPath: priorBinding.taskPath } : {}),
        platform: priorBinding.platform, source: priorBinding.source, backupId: backup.id };
    } catch (cause) {
      if (!mutationStarted) throw cause;
      if (!writeAttempted && (cause as { code?: string }).code === "RECOVERY_RECORD_PERSISTENCE_FAILED") {
        drainSafeToRelease = !stopIssued;
        try { restoreCandidateBytes(input.paths, previousCandidate); } catch { drainSafeToRelease = false; }
        throw serviceFailure("SERVICE_ROLLBACK_FAILED", cause, "unknown", stage, "RECOVERY_RECORD_PERSISTENCE_FAILED", undefined,
          { writeAttempted, drainRetained: !drainSafeToRelease });
      }
      previousSnapshot ??= failedWriteSnapshot(cause);
      if (stopNotIssued(stage, cause)) stopIssued = false;
      const familyUnproven = stopFamilyUnproven(cause);
      let recovery = "unknown", blocker: string | undefined;
      try {
        await restorePrior({ binding: priorBinding, previous: current, previousBinding: currentBinding,
          previousPid: state?.pid, previousIdentity: state ?? undefined, priorStopProven,
          deps: input, candidate: previousSnapshot, priorStopIssued: stopIssued, familyUnproven });
        writeServiceReceipt(input.paths, receipt);
        if (JSON.stringify(readServiceReceipt(input.paths)) !== JSON.stringify(receipt)) throw new Error("recovered receipt could not be verified");
        restoreCandidateBytes(input.paths, previousCandidate);
        recovery = "restored";
      } catch (error) {
        blocker = recoveryBlocker(error);
        if (candidatePersisted) {
          try {
            const native = await input.adapter.read(currentBinding);
            const digests = native && snapshotDigests(native);
            if (previousCandidate && digests?.definitionDigest === receipt.definitionDigest && digests.securityDigest === receipt.securityDigest) {
              restoreCandidateBytes(input.paths, previousCandidate);
            } else failedCandidate(input.paths, candidateRecord, stage, blocker, error, deps.now(), input.writeCandidate);
          } catch { blocker = "RECOVERY_RECORD_PERSISTENCE_FAILED"; }
        }
      }
      if (recovery === "unknown" && (writeAttempted || familyUnproven || (stopIssued && deps.alive(state?.pid)))) drainSafeToRelease = false;
      throw serviceFailure("SERVICE_ROLLBACK_FAILED", cause, recovery, stage, blocker, stageStopCode(stage, cause),
        { writeAttempted, drainRetained: !drainSafeToRelease });
    } finally { clearLaunchPermit(); if (drainSafeToRelease) endDrain(); }
}
