import crypto from "node:crypto";
import path from "node:path";

import type { DaemonState } from "./daemon-state.mts";
import {
  acquireServiceLock, readServiceCandidate, readServiceReceipt, removeServiceCandidate, removeServiceReceipt, saveServiceBackup,
  serviceRoot, snapshotDigests, writeServiceReceipt, type ServiceCandidate,
} from "./service-records.mts";
import { captureCandidateBytes, failedCandidate, persistCandidate, restoreCandidateBytes } from "./service-candidate-record.mts";
import { pinServiceSource } from "./service-source.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { issueServiceLaunchPermit } from "./service-launch-permit.mts";
import {
  healthy, lifecycleDefaults, prepareStop, proveStopped, removeFresh, restorePrior, sourceMatches, verifyExact, verifyStopOwnership,
  type LifecycleDependencies,
} from "./service-lifecycle.mts";
import {
  assertSettled, candidateInPlace, exact, failedWriteSnapshot, receiptFor, recordedPriorBackup, recoveryBlocker, sameBinding, sameSelector,
  serviceFailure, stageStopCode, stopFamilyUnproven, stopNotIssued, type ServiceStage, type ServiceTransactionResult,
} from "./service-transaction-support.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";

export { readServiceReceipt } from "./service-records.mts";
// #582: rollbackManagedService moved to service-rollback.mts (line budget); the import sites keep this name.
export { rollbackManagedService } from "./service-rollback.mts";

type Dependencies = LifecycleDependencies;

interface ActivateOptions {
  mode: "install" | "upgrade"; binding: ServiceBinding; sourceRoot?: string; adopt?: boolean; explicitServiceName?: boolean;
}
export async function activateManagedService(options: ActivateOptions, input: Dependencies): Promise<ServiceTransactionResult> {
  const release = acquireServiceLock(input.paths, input.ownerProbe);
  try {
    const deps = lifecycleDefaults(input);
    let binding = options.sourceRoot
      ? { ...options.binding, source: pinServiceSource(options.sourceRoot, serviceRoot(input.paths)).identity }
      : options.binding;
    if (binding.platform === "win32") binding = { ...binding, supervisorGeneration: crypto.randomUUID() };
    const receipt = readServiceReceipt(input.paths);
    const existing = await input.adapter.read(binding);
    if (options.mode === "upgrade" && !receipt) throw new Error("managed service receipt is missing; install or adopt first");
    if (options.mode === "install" && receipt) throw new Error("service is already managed; use service upgrade");
    if (receipt && !sameBinding(receipt.binding, binding)) throw new Error("managed service binding does not match the receipt");
    if (existing?.running === "unknown") throw new Error("selected service running state is unknown");
    const recordedBefore = deps.readState(input.paths);
    if (!existing && recordedBefore && deps.alive(recordedBefore.pid)) {
      throw new Error("a live daemon is already recorded; refusing to start a duplicate service");
    }
    if (existing?.running === false && recordedBefore && deps.alive(recordedBefore.pid)) {
      throw new Error("a live daemon remains outside the stopped selected service");
    }
    const digests = existing ? snapshotDigests(existing) : undefined;
    const receiptMatch = Boolean(receipt && digests && digests.definitionDigest === receipt.definitionDigest && digests.securityDigest === receipt.securityDigest);
    // #582: the record is consulted only while the receipt does not match (A2 P2-A); an invalid record then throws before any mutation.
    const pending = receiptMatch ? null : readServiceCandidate(input.paths);
    // #582 (A2 P1-A): an install record carries the node executable and log path the adoption rewrote; the repeated
    // install (same selector, no receipt) inherits them before the binding match, so the record is reachable on real hosts.
    if (!receipt && pending?.command === "install" && sameSelector(pending.binding, binding)) {
      binding = { ...binding, nodeExecutable: pending.binding.nodeExecutable, logFile: pending.binding.logFile };
    }
    const pendingMatch = !receiptMatch && candidateInPlace(pending, existing, binding);
    const previousCandidate = pendingMatch ? captureCandidateBytes(input.paths) : null;
    if (pendingMatch && options.adopt) throw new Error("a recorded failed candidate cannot be adopted; repeat the install without --adopt or run service rollback");
    let legacySourceRoot: string | undefined;
    if (existing && !receipt && !pendingMatch && options.adopt) {
      binding = { ...binding, nodeExecutable: await input.adapter.adoptionNode(existing, recordedBefore?.pid) };
      legacySourceRoot = await input.adapter.adoptionSourceRoot(existing, recordedBefore?.pid);
      const logFile = await input.adapter.adoptionLogFile(existing);
      if (binding.platform === "win32" && !logFile) throw new Error("Scheduled Task legacy log path is unavailable");
      if (logFile) binding = { ...binding, logFile };
    }
    if (receipt) {
      if (!existing) throw new Error("managed service definition is missing");
      if (!receiptMatch && !pendingMatch) throw new Error("managed service definition drifted from its receipt");
    } else if (existing && !pendingMatch && (!options.adopt || !options.explicitServiceName)) {
      throw new Error("an existing service requires explicit --service-name and --adopt");
    }
    if (receipt || pendingMatch) await input.adapter.validateManaged(existing!, pendingMatch ? pending.binding : receipt!.binding);
    const prior = pendingMatch ? recordedPriorBackup(input.paths, pending, receipt) : null;
    if (pendingMatch && pending.backupId && !prior) throw new Error("managed service candidate record does not bind to the receipt");

    let oldState: DaemonState | null = null;
    let oldBinding: ServiceBinding | undefined = pendingMatch ? pending.binding : receipt?.binding;
    if (existing) {
      oldState = recordedBefore;
      if ((receipt || pendingMatch) && existing.running === true && (!oldState?.source?.verified || !sourceMatches(oldBinding!.source, oldState.source)
        || oldState.service?.name !== oldBinding!.serviceName || oldState.service.platform !== oldBinding!.platform
        || oldState.service.taskPath !== oldBinding!.taskPath)) {
        throw new Error("running daemon does not match the managed service receipt");
      }
      if (!receipt && !pendingMatch && oldState?.source?.verified) {
        oldBinding = { ...binding, source: oldState.source, supervisorGeneration: undefined };
        if (path.resolve(oldState.source.root) !== path.resolve(legacySourceRoot!)) {
          throw new Error("legacy native source root does not match recorded daemon source");
        }
      }
      const provenanceRoot = oldBinding ? undefined : legacySourceRoot;
      if (existing.running === true) {
        if (!oldState || (!pendingMatch && (!oldState.connectedAt || oldState.disconnectedAt))) throw new Error("selected service does not own the recorded daemon");
        const selectedBinding = oldBinding ?? binding;
        const context = { pid: oldState.pid, startedAt: oldState.startedAt, ...(provenanceRoot ? { sourceRoot: provenanceRoot } : {}) };
        if (deps.alive(oldState.pid)) {
          if (!await input.adapter.processOwned(oldState.pid, selectedBinding, oldState.startedAt, provenanceRoot)) {
            throw new Error("selected service does not own the recorded daemon");
          }
        } else {
          try { await input.adapter.preflightStop(selectedBinding, context); }
          catch { throw new Error("selected service does not own the recorded daemon"); }
        }
      }
    }
    const definition = existing
      ? (receipt || pendingMatch)
        ? await input.adapter.retargeted(existing, binding)
        : await input.adapter.adopted(existing, binding, legacySourceRoot!)
      : await input.adapter.fresh(binding);
    const security = existing ? existing.security : await input.adapter.freshSecurity(binding);
    const backup = !existing ? undefined
      : pendingMatch ? prior?.backup
        : saveServiceBackup(input.paths, existing, { receipt, priorSource: oldBinding?.source, now: deps.now() });
    let endDrain = () => {};
    let clearLaunchPermit = () => {};
    let drainSafeToRelease = true;
    let mutationStarted = false;
    let stopIssued = false, priorStopProven = existing?.running === false, writeAttempted = false, stage: ServiceStage = "stop";
    let candidateSnapshot: NativeServiceSnapshot | undefined, candidatePersisted = false;
    let candidateRecord: ServiceCandidate = { version: 2, phase: "prepared", preparedAt: deps.now(), binding,
      ...snapshotDigests({ definition, security, running: false }), ...(backup ? { backupId: backup.id } : {}), command: options.mode };
    try {
      if (existing) {
        endDrain = beginServiceDrain(input.paths, input.ownerProbe);
        const runningState = existing.running === true ? oldState : null;
        await prepareStop(oldBinding ?? binding, runningState, input, oldBinding ? undefined : legacySourceRoot);
        await verifyExact(input.adapter, binding, existing);
        await verifyStopOwnership(oldBinding ?? binding, runningState, input, oldBinding ? undefined : legacySourceRoot);
        mutationStarted = true;
        const sourceRoot = oldBinding ? undefined : legacySourceRoot;
        if (existing.running === true) {
          stopIssued = true;
          const context = oldState ? { pid: oldState.pid, startedAt: oldState.startedAt, ...(sourceRoot ? { sourceRoot } : {}) } : undefined;
          await input.adapter.stop(oldBinding ?? binding, context);
          stage = "prove-stopped";
          await proveStopped(oldBinding ?? binding, context, deps);
          priorStopProven = true;
        }
      }
      mutationStarted = true;
      stage = "write";
      persistCandidate(input.paths, candidateRecord, input.writeCandidate);
      candidatePersisted = true;
      writeAttempted = true;
      await input.adapter.write(binding, definition, security);
      stage = "verify";
      const written = await input.adapter.read(binding);
      if (!written) throw new Error("managed service definition was not created");
      candidateSnapshot = written;
      if (existing && !exact(written.security, security)) throw new Error("native service security changed during write");
      await input.adapter.validateManaged(written, binding);
      candidateRecord = { ...candidateRecord, phase: "attested", ...snapshotDigests(written) };
      persistCandidate(input.paths, candidateRecord, input.writeCandidate);
      stage = "start";
      if (binding.platform === "win32") clearLaunchPermit = issueServiceLaunchPermit(input.paths, binding);
      await input.adapter.start(binding);
      stage = "health";
      const healthyState = await healthy(binding, oldState ?? undefined, input);
      stage = "settle";
      const active = await assertSettled(input, binding, written, healthyState, true);
      stage = "receipt";
      writeServiceReceipt(input.paths, receiptFor(binding, active, deps.now(), backup));
      const activated = readServiceReceipt(input.paths);
      if (!activated || JSON.stringify(activated) !== JSON.stringify(receiptFor(binding, active, activated.activatedAt, backup))) {
        throw new Error("managed service receipt persistence could not be verified");
      }
      removeServiceCandidate(input.paths);
      return { serviceName: binding.serviceName, ...(binding.taskPath ? { taskPath: binding.taskPath } : {}),
        platform: binding.platform, source: binding.source, ...(backup ? { backupId: backup.id } : {}) };
    } catch (cause) {
      if (!mutationStarted) throw cause;
      if (!writeAttempted && (cause as { code?: string }).code === "RECOVERY_RECORD_PERSISTENCE_FAILED") {
        drainSafeToRelease = !stopIssued;
        try { restoreCandidateBytes(input.paths, previousCandidate); } catch { drainSafeToRelease = false; }
        throw serviceFailure("SERVICE_ACTIVATION_FAILED", cause, "unknown", stage, "RECOVERY_RECORD_PERSISTENCE_FAILED", undefined,
          { writeAttempted, drainRetained: !drainSafeToRelease });
      }
      candidateSnapshot ??= failedWriteSnapshot(cause);
      if (stopNotIssued(stage, cause)) stopIssued = false;
      const familyUnproven = stopFamilyUnproven(cause);
      let recovery = "unknown", blocker: string | undefined;
      try {
        if (existing) await restorePrior({ binding, previous: existing, previousBinding: oldBinding,
          previousPid: oldState?.pid, previousIdentity: oldState ?? undefined, priorStopProven,
          deps: input, candidate: candidateSnapshot, priorStopIssued: stopIssued, familyUnproven });
        else await removeFresh(binding, input);
        if (receipt) writeServiceReceipt(input.paths, receipt); else removeServiceReceipt(input.paths);
        if (JSON.stringify(readServiceReceipt(input.paths)) !== JSON.stringify(receipt)) throw new Error("recovered receipt could not be verified");
        restoreCandidateBytes(input.paths, previousCandidate);
        recovery = "restored";
      } catch (error) {
        blocker = recoveryBlocker(error);
        if (candidatePersisted) {
          try {
            const native = await input.adapter.read(binding);
            if (previousCandidate && existing && native && exact(native.definition, existing.definition) && exact(native.security, existing.security)) {
              restoreCandidateBytes(input.paths, previousCandidate);
            } else failedCandidate(input.paths, candidateRecord, stage, blocker, error, deps.now(), input.writeCandidate);
          } catch { blocker = "RECOVERY_RECORD_PERSISTENCE_FAILED"; }
        }
      }
      // #472: keep the drain once a write was attempted or while a daemon told to stop is still alive (#677: or its family).
      if (recovery === "unknown" && (writeAttempted || familyUnproven || (stopIssued && deps.alive(oldState?.pid)))) drainSafeToRelease = false;
      throw serviceFailure("SERVICE_ACTIVATION_FAILED", cause, recovery, stage, blocker, stageStopCode(stage, cause),
        { writeAttempted, drainRetained: !drainSafeToRelease });
    } finally { clearLaunchPermit(); if (drainSafeToRelease) endDrain(); }
  } finally { release(); }
}
