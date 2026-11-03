import type { NodePaths } from "./config.mts";
import type { CandidateWriter } from "./service-candidate-record.mts";
import { pidAlive as defaultPidAlive, readDaemonState as defaultReadDaemonState, type DaemonState } from "./daemon-state.mts";
import { captureSourceIdentity, compareSourceIdentity, type SourceIdentity } from "./daemon-source.mts";
import { serviceAdmissionsIdle, type ServiceOwnerProbe } from "./service-drain.mts";
import { issueServiceLaunchPermit } from "./service-launch-permit.mts";
import {
  isStopCode, stopCode, type NativeServiceSnapshot, type ServiceAdapter, type ServiceBinding, type ServiceClock, type ServiceStopContext,
  type ServiceStopProof, type StopCode,
} from "./service-types.mts";

export interface LifecycleDependencies {
  paths: NodePaths;
  adapter: ServiceAdapter;
  readDaemonState?: (paths: NodePaths) => DaemonState | null;
  pidAlive?: (pid: unknown) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: ServiceClock; // #677: the stop proof's monotonic clock; by default performance.now with `sleep`
  timeoutMs?: number;
  stopTimeoutMs?: number;
  now?: () => string;
  verifySource?: (identity: SourceIdentity) => boolean;
  reportAdmissionWait?: (message: string) => void;
  writeCandidate?: CandidateWriter;
  ownerProbe?: ServiceOwnerProbe;
  captureSource?: typeof captureSourceIdentity;
}

// launchd ExitTimeOut (60 s) plus a margin: a daemon may wait ~50 s for a probe before it exits (#472).
export const STOP_TIMEOUT_MS = 75_000;
// The default poll deadline, also of the admission wait: the health stage waits this long for the new daemon's
// authenticated connection, which no longer waits for the start maintenance (#581).
export const HEALTH_TIMEOUT_MS = 30_000;
// The health wait of restorePrior: the prior source may predate #581 and run its start maintenance before connect.
export const ROLLBACK_HEALTH_TIMEOUT_MS = 180_000;
const exact = (left: Buffer, right: Buffer): boolean => left.equals(right);
const recoveryError = (code: string, message: string): Error & { code: string } => Object.assign(new Error(message), { code });
// #582: the candidate is still loaded under the label; writing other bytes now would leave launchd and the file apart.
export type CandidateLoadedError = Error & { code: "RECOVERY_CANDIDATE_LOADED"; stopCode: StopCode };
const candidateLoaded = (stopFailure: Error | undefined): CandidateLoadedError => Object.assign(
  new Error(`candidate service is still loaded; its stop ${stopFailure ? `failed: ${stopFailure.message}` : "reported success"}`),
  { code: "RECOVERY_CANDIDATE_LOADED" as const, stopCode: stopCode(stopFailure) });
const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
// The message of every stop proof that ran out of time; `stopCode` maps it to STOP_UNPROVEN_TIMEOUT.
export const STOP_PROOF_TIMEOUT_MESSAGE = "managed service verification timed out";

export function sourceMatches(expected: SourceIdentity, actual: SourceIdentity | undefined): boolean {
  return compareSourceIdentity(expected, actual).status === "match";
}

export function lifecycleDefaults(deps: LifecycleDependencies) {
  return { adapter: deps.adapter, readState: deps.readDaemonState ?? defaultReadDaemonState, alive: deps.pidAlive ?? defaultPidAlive,
    sleep: deps.sleep ?? wait, timeout: deps.timeoutMs ?? HEALTH_TIMEOUT_MS,
    clock: deps.clock ?? { now: () => performance.now(), sleep: deps.sleep ?? wait },
    stopTimeout: deps.stopTimeoutMs ?? deps.timeoutMs ?? STOP_TIMEOUT_MS, now: deps.now ?? (() => new Date().toISOString()),
    verifySource: deps.verifySource ?? ((identity: SourceIdentity) => {
      try { return sourceMatches(identity, captureSourceIdentity(identity.root, false)); } catch { return false; }
    }) };
}

async function poll<T>(timeout: number, sleep: (ms: number) => Promise<void>, check: () => Promise<T | null>,
  timeoutMessage = () => STOP_PROOF_TIMEOUT_MESSAGE): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value !== null) return value;
    await sleep(100);
  } while (Date.now() <= deadline);
  throw new Error(timeoutMessage());
}

// #677: the generic stop proof, today's loop on the stop proof's clock: no poll starts after the deadline.
export async function pollStopped(pid: number, proof: ServiceStopProof): Promise<void> {
  do {
    if (!proof.alive(pid)) return;
    await proof.clock.sleep(100);
  } while (proof.clock.now() <= proof.deadline);
  throw new Error(STOP_PROOF_TIMEOUT_MESSAGE);
}

// #677: the only stop-proof entry point, called right after `adapter.stop` returned. It computes the one deadline and
// hands it to the adapter's hook, which then replaces the generic poll; nothing runs after either of them.
export async function proveStopped(binding: ServiceBinding, expected: ServiceStopContext | undefined,
  deps: ReturnType<typeof lifecycleDefaults>): Promise<void> {
  if (expected === undefined) return;
  const proof = { alive: deps.alive, clock: deps.clock, deadline: deps.clock.now() + deps.stopTimeout };
  if (deps.adapter.proveStopped) return deps.adapter.proveStopped(binding, expected, proof);
  await pollStopped(expected.pid, proof);
}

export async function prepareStop(
  binding: ServiceBinding, expected: DaemonState | null, input: LifecycleDependencies, sourceRoot?: string,
): Promise<void> {
  const deps = lifecycleDefaults(input);
  let lastBlocker: string | undefined;
  const report = input.reportAdmissionWait ?? console.error;
  await poll(deps.timeout, deps.sleep, async () => serviceAdmissionsIdle(input.paths, input.ownerProbe, blocker => {
    const descriptor = `lease=${blocker.leaseId} pid=${blocker.pid} processStartedAt=${blocker.startedAt}`;
    if (descriptor !== lastBlocker) {
      lastBlocker = descriptor;
      report(`waiting for service admission: ${descriptor}`);
    }
  }) ? true : null, () => `managed service admission wait timed out${lastBlocker ? `; ${lastBlocker}` : ""}`);
  if (!expected) { await input.adapter.preflightStop(binding, undefined); return; }
  const current = deps.readState(input.paths);
  if (!current || current.pid !== expected.pid || current.startedAt !== expected.startedAt) {
    throw new Error("recorded daemon changed before the selected service could stop");
  }
  await input.adapter.preflightStop(binding, { pid: current.pid, startedAt: current.startedAt, ...(sourceRoot ? { sourceRoot } : {}) });
}

export async function verifyStopOwnership(
  binding: ServiceBinding, expected: DaemonState | null, input: LifecycleDependencies, sourceRoot?: string,
): Promise<void> {
  if (!expected) { await input.adapter.preflightStop(binding, undefined); return; }
  const deps = lifecycleDefaults(input);
  const current = deps.readState(input.paths);
  if (!current || current.pid !== expected.pid || current.startedAt !== expected.startedAt) {
    throw new Error("recorded daemon ownership changed before the selected service could stop");
  }
  const context = { pid: current.pid, startedAt: current.startedAt, ...(sourceRoot ? { sourceRoot } : {}) };
  if (deps.alive(current.pid)) {
    if (!await input.adapter.processOwned(current.pid, binding, current.startedAt, sourceRoot)) {
      throw new Error("recorded daemon ownership changed before the selected service could stop");
    }
  } else await input.adapter.preflightStop(binding, context);
}

export async function removeFresh(binding: ServiceBinding, input: LifecycleDependencies): Promise<void> {
  const deps = lifecycleDefaults(input);
  const candidate = deps.readState(input.paths);
  const native = await input.adapter.read(binding);
  try {
    if (candidate && deps.alive(candidate.pid)) {
      if (!native || !await input.adapter.processOwned(candidate.pid, binding, candidate.startedAt)) {
        throw new Error("new service process ownership cannot be verified");
      }
      await input.adapter.preflightStop(binding, { pid: candidate.pid, startedAt: candidate.startedAt });
      const context = { pid: candidate.pid, startedAt: candidate.startedAt };
      await input.adapter.stop(binding, context);
      await proveStopped(binding, context, deps);
    } else if (native) {
      await input.adapter.preflightStop(binding, undefined);
      if (native.running !== false) await input.adapter.stop(binding, undefined);
    }
  } catch (error) { // #582: a fresh candidate that stays loaded is reported, not removed from under launchd
    const remaining = await input.adapter.read(binding);
    if (remaining && remaining.running !== false) throw candidateLoaded(error as Error);
    throw error;
  }
  if (!native) return;
  await input.adapter.remove(binding);
  if (await input.adapter.read(binding)) throw new Error("new service removal could not be verified");
}

export async function healthy(binding: ServiceBinding, previous: ServiceStopContext | undefined, input: LifecycleDependencies,
  allowLegacyMarker = false): Promise<DaemonState> {
  const deps = lifecycleDefaults(input);
  return poll(deps.timeout, deps.sleep, async () => {
    const state = deps.readState(input.paths);
    if (!state || (state.pid === previous?.pid && state.startedAt === previous.startedAt) || !deps.alive(state.pid) || !state.connectedAt || state.disconnectedAt
      || !sourceMatches(binding.source, state.source)) return null;
    if (!allowLegacyMarker && (state.service?.name !== binding.serviceName || state.service.platform !== binding.platform
      || state.service.taskPath !== binding.taskPath)) return null;
    return await input.adapter.processOwned(state.pid, binding, state.startedAt) ? state : null;
  });
}

export async function verifyExact(
  adapter: ServiceAdapter, binding: ServiceBinding, expected: NativeServiceSnapshot,
): Promise<NativeServiceSnapshot> {
  const actual = await adapter.read(binding);
  if (!actual || !exact(actual.definition, expected.definition) || !exact(actual.security, expected.security)) {
    throw new Error("native service readback does not match the requested bytes");
  }
  return actual;
}

export interface RecoveryInput {
  binding: ServiceBinding;
  previous: NativeServiceSnapshot;
  previousBinding?: ServiceBinding;
  previousPid?: number;
  previousIdentity?: ServiceStopContext;
  priorStopProven?: boolean;
  deps: LifecycleDependencies;
  candidate?: NativeServiceSnapshot;
  priorStopIssued?: boolean;
  familyUnproven?: boolean; // #677: the stop proof could not show the previous daemon's family gone
}

export async function restorePrior(input: RecoveryInput): Promise<void> {
  const runtime = lifecycleDefaults(input.deps);
  let absenceProven = false;
  let stopFailure: Error | undefined;
  let overwritesLoaded = false;
  const candidateState = runtime.readState(input.deps.paths);
  const native = await input.deps.adapter.read(input.binding);
  if (native) {
    const candidateBytes = input.candidate && exact(native.definition, input.candidate.definition)
      && exact(native.security, input.candidate.security);
    const priorBytes = exact(native.definition, input.previous.definition) && exact(native.security, input.previous.security);
    overwritesLoaded = !priorBytes;
    if (!candidateBytes && !priorBytes) throw recoveryError("RECOVERY_SERVICE_CHANGED", "selected service changed during recovery");
    if (native.running === true && priorBytes && !candidateBytes && !input.priorStopIssued && candidateState
      && candidateState.pid === input.previousPid
      && (!input.previousIdentity || candidateState.startedAt === input.previousIdentity.startedAt) && runtime.alive(candidateState.pid)
      && await input.deps.adapter.processOwned(candidateState.pid, input.previousBinding ?? input.binding, candidateState.startedAt)) {
      await verifyExact(input.deps.adapter, input.binding, input.previous); // prior is live and untouched (#472)
      return;
    }
    const stoppedBinding = candidateBytes ? input.binding : (input.previousBinding ?? input.binding);
    if (candidateBytes && native.running !== false) {
      try {
        const context = candidateState && (candidateState.pid !== input.previousPid
          || (input.priorStopProven && input.previousIdentity && candidateState.startedAt !== input.previousIdentity.startedAt))
          ? { pid: candidateState.pid, startedAt: candidateState.startedAt } : undefined;
        await input.deps.adapter.preflightStop(input.binding, context);
        await input.deps.adapter.stop(input.binding, context);
        await proveStopped(input.binding, context, runtime);
        absenceProven = true;
      } catch (error) { stopFailure = error as Error; }
    } else if (native.running !== true) {
      try {
        await input.deps.adapter.preflightStop(stoppedBinding, undefined);
        if (native.running !== false) await input.deps.adapter.stop(stoppedBinding, undefined);
        if (!candidateState || candidateState.pid === input.previousPid || !runtime.alive(candidateState.pid)) {
          absenceProven = true;
        }
      } catch (error) { stopFailure = error as Error; }
    }
  }
  // #677: nothing is written or started while the previous daemon, or a family member it left, may still run.
  const unproven = stopFailure as { code?: unknown; familyUnproven?: unknown } | undefined;
  if (input.familyUnproven || (isStopCode(unproven?.code) && unproven?.familyUnproven === true)
    || (!input.priorStopProven && input.previousPid !== undefined && runtime.alive(input.previousPid))) {
    throw Object.assign(recoveryError("RECOVERY_ABSENCE_UNPROVEN", "previous daemon or candidate family may still run; recovery refused"),
      { stopCode: stopCode(stopFailure) });
  }
  // #582: the prior bytes are written only over nothing, over themselves, or over a candidate proven absent.
  if (overwritesLoaded && !absenceProven) {
    const remaining = await input.deps.adapter.read(input.binding);
    if (remaining && remaining.running !== false) throw candidateLoaded(stopFailure);
  }
  await input.deps.adapter.write(input.binding, input.previous.definition, input.previous.security);
  await verifyExact(input.deps.adapter, input.binding, input.previous);
  if (!absenceProven) throw recoveryError("RECOVERY_ABSENCE_UNPROVEN", "candidate absence cannot be verified for recovery");
  if (input.previous.running === true) {
    if (!input.previousBinding || !runtime.verifySource(input.previousBinding.source)) {
      throw recoveryError("RECOVERY_PRIOR_UNVERIFIED", "previous source or candidate absence cannot be verified for recovery");
    }
    const clearPermit = input.previousBinding.platform === "win32" && input.previousBinding.supervisorGeneration
      ? issueServiceLaunchPermit(input.deps.paths, input.previousBinding) : () => {};
    try {
      await input.deps.adapter.start(input.previousBinding);
      await healthy(input.previousBinding, undefined,
        { ...input.deps, timeoutMs: input.deps.timeoutMs ?? ROLLBACK_HEALTH_TIMEOUT_MS }, true);
    } finally { clearPermit(); }
  }
}
