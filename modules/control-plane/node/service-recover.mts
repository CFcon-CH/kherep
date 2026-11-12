import type { DaemonState } from "./daemon-state.mts";
import { beginServiceDrain, describeServiceDrain } from "./service-drain.mts";
import { issueServiceLaunchPermit } from "./service-launch-permit.mts";
import {
  healthy, lifecycleDefaults, prepareStop, proveStopped, ROLLBACK_HEALTH_TIMEOUT_MS, sourceMatches, verifyExact, verifyStopOwnership,
  type LifecycleDependencies,
} from "./service-lifecycle.mts";
import { acquireServiceLock, readServiceCandidate, readServiceReceipt, snapshotDigests, type ServiceReceipt } from "./service-records.mts";
import { serviceNodeState } from "./service-status.mts";
import { assertSettled, candidateInPlace, serviceFailure, stageStopCode, stopNotIssued, type ServiceStage } from "./service-transaction-support.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";

// #810 stage B: `kherep-node service recover`. Without --confirm it only reads and prints evidence. With --confirm it is a
// strict subset of `service upgrade` to the installed commit: no new source, no definition write, no receipt change. It
// starts only the receipt's exact definition, after upgrade's own drain, preflight and proof-carrying stop. Nothing here
// releases a retained drain automatically, and the display-only failure record (#838 A4) is never read or written.
export const RECOVER_REFUSALS = {
  DRAIN_ACTIVE: "another managed service transaction drains admissions; wait until it ends, then run kherep-node service recover again",
  DRAIN_UNKNOWN: "the service drain owner cannot be verified; inspect the service/drain owner file, see docs/INSTALLATION.md",
  DEFINITION_UNATTESTED: "the service definition could not be read back; kherep-node service status shows why, see docs/INSTALLATION.md",
  DEFINITION_MISSING: "the managed service definition is missing; recover starts only the receipt's definition, see docs/INSTALLATION.md",
  DEFINITION_DRIFT: "the service definition differs from its receipt; recover writes nothing; use kherep-node service rollback (on Windows also rollback --recover), see docs/INSTALLATION.md",
  CANDIDATE_IN_PLACE: "a recorded failed candidate is in place; kherep-node service upgrade --source <clean checkout> activates over it and kherep-node service rollback restores the receipt's definition",
  DEFINITION_INVALID: "the service definition does not validate against the receipt's binding; kherep-node service status shows why, see docs/INSTALLATION.md",
  RUNNING_UNKNOWN: "the service running state is unknown; kherep-node service status shows why, see docs/INSTALLATION.md",
  GENERATION_MISSING: "the receipt names no Windows supervisor generation, so no launch permit can be issued; use kherep-node service upgrade --source <clean checkout>",
  DAEMON_OUTLIVED: "the service is stopped but its recorded daemon still runs; end that process by hand first, see docs/INSTALLATION.md",
  DAEMON_UNRECORDED: "the service runs without a recorded daemon, so its stop cannot carry a proof; see docs/INSTALLATION.md",
  DAEMON_MISMATCH: "the recorded daemon does not match the managed service receipt; see docs/INSTALLATION.md",
  DAEMON_NOT_OWNED: "the service does not prove ownership of its live recorded daemon; see docs/INSTALLATION.md",
  NODE_RUNNING: "the node is running and no service drain blocks it; nothing to recover",
  SOURCE_UNVERIFIED: "the installed source pin cannot be verified; use kherep-node service upgrade --source <clean checkout>",
} as const;
export type RecoverRefusal = keyof typeof RECOVER_REFUSALS;

export interface RecoverEvidence {
  canRecover: boolean;
  view: Record<string, unknown>;
  native: NativeServiceSnapshot | null;
  state: DaemonState | null;
  drain: ReturnType<typeof describeServiceDrain>;
}

// Read-only: native reads, the drain and daemon records, ownership and the pin. No lock, drain, permit or record is written.
export async function recoverEvidence(input: LifecycleDependencies, receipt: ServiceReceipt): Promise<RecoverEvidence> {
  const deps = lifecycleDefaults(input);
  const binding = receipt.binding;
  const drain = describeServiceDrain(input.paths, input.ownerProbe);
  const state = deps.readState(input.paths);
  const alive = Boolean(state && deps.alive(state.pid));
  let native: NativeServiceSnapshot | null = null, attested = true;
  try { native = await input.adapter.read(binding); } catch { attested = false; }
  const digests = native ? snapshotDigests(native) : null;
  const receiptMatch = digests?.definitionDigest === receipt.definitionDigest && digests.securityDigest === receipt.securityDigest;
  const facts: Record<string, unknown> = {
    definition: !attested ? "unattested" : !native ? "missing" : receiptMatch ? "match" : "mismatch",
    running: native?.running ?? "unknown", daemon: !state ? "unrecorded" : alive ? "alive" : "dead",
  };
  const refusal = await (async (): Promise<RecoverRefusal | undefined> => {
    if (drain === "active") return "DRAIN_ACTIVE";
    if (drain === "unknown") return "DRAIN_UNKNOWN";
    if (!attested) return "DEFINITION_UNATTESTED";
    if (!native) return "DEFINITION_MISSING";
    if (!receiptMatch) {
      // As in upgrade, the candidate record is consulted only while the receipt does not match.
      let pending = null;
      try { pending = readServiceCandidate(input.paths); } catch { facts.candidate = "invalid"; return "DEFINITION_DRIFT"; }
      if (candidateInPlace(pending, native, binding)) { facts.candidate = "in-place"; return "CANDIDATE_IN_PLACE"; }
      if (pending) facts.candidate = "stale";
      return "DEFINITION_DRIFT";
    }
    try { await input.adapter.validateManaged(native, binding); } catch { return "DEFINITION_INVALID"; }
    if (native.running === "unknown") return "RUNNING_UNKNOWN";
    if (binding.platform === "win32" && !binding.supervisorGeneration) return "GENERATION_MISSING";
    if (native.running === false && alive) return "DAEMON_OUTLIVED";
    if (native.running === true) {
      if (!state) return "DAEMON_UNRECORDED";
      if (!state.source?.verified || !sourceMatches(binding.source, state.source) || state.service?.name !== binding.serviceName
        || state.service.platform !== binding.platform || state.service.taskPath !== binding.taskPath) return "DAEMON_MISMATCH";
      if (alive) {
        // A live daemon is stopped only as upgrade stops it: connected, and owned by the selected service.
        let owned = false;
        if (state.connectedAt && !state.disconnectedAt) {
          try { owned = await input.adapter.processOwned(state.pid, binding, state.startedAt); } catch { owned = false; }
        }
        facts.ownership = owned ? "match" : "unknown";
        if (!owned) return "DAEMON_NOT_OWNED";
        if (drain === "none") return "NODE_RUNNING";
      }
    }
    const verified = deps.verifySource(binding.source);
    facts.source = verified ? "verified" : "unverified";
    return verified ? undefined : "SOURCE_UNVERIFIED";
  })();
  const plan = refusal ? [] : [...(drain === "stale" ? ["reclaim-drain"] : []), ...(native?.running === true ? ["stop"] : []),
    "start", "health", "release-drain"];
  const view = { ok: !refusal, action: "recover", confirmed: false, canRecover: !refusal,
    ...(refusal ? { reason: refusal, detail: RECOVER_REFUSALS[refusal] } : {}),
    serviceName: binding.serviceName, platform: binding.platform, ...(binding.taskPath ? { taskPath: binding.taskPath } : {}),
    installed: binding.source.commit, node: serviceNodeState(alive, drain), drain, ...facts, ...(refusal ? {} : { plan }) };
  return { canRecover: !refusal, view, native, state, drain };
}

export interface RecoverResult { recovered: boolean; view: Record<string, unknown> }

// --confirm. Under the service lock the evidence is read again; any refusal returns with nothing written or started.
export async function recoverManagedService(input: LifecycleDependencies): Promise<RecoverResult> {
  const release = acquireServiceLock(input.paths, input.ownerProbe);
  try {
    const receipt = readServiceReceipt(input.paths);
    if (!receipt) throw new Error("managed service receipt is missing; install or adopt first");
    const evidence = await recoverEvidence(input, receipt);
    if (!evidence.canRecover || !evidence.native) return { recovered: false, view: { ...evidence.view, confirmed: true, done: [] } };
    const { native, state } = evidence;
    const binding = receipt.binding;
    const deps = lifecycleDefaults(input);
    const reclaimed = evidence.drain === "stale";
    // Upgrade's rule: a stale drain is reclaimed, an active or unknown one refused (also inside beginServiceDrain).
    const endDrain = beginServiceDrain(input.paths, input.ownerProbe);
    const done: string[] = reclaimed ? ["reclaim-drain"] : [];
    const previous = state ? { pid: state.pid, startedAt: state.startedAt } : undefined;
    let clearPermit = () => {}, effect = false, keepDrain = true, stage: ServiceStage = "stop";
    try {
      const runningState = native.running === true ? state : null;
      await prepareStop(binding, runningState, input);
      await verifyExact(input.adapter, binding, native);
      await verifyStopOwnership(binding, runningState, input);
      if (native.running === true) {
        effect = true;
        await input.adapter.stop(binding, previous);
        stage = "prove-stopped";
        await proveStopped(binding, previous, deps);
        done.push("stop");
        await input.adapter.preflightStop(binding, undefined);
      }
      stage = "start";
      if (!deps.verifySource(binding.source)) throw new Error("installed source cannot be verified; recovery refused");
      if (binding.platform === "win32") clearPermit = issueServiceLaunchPermit(input.paths, binding);
      effect = true;
      await input.adapter.start(binding);
      done.push("start");
      stage = "health";
      // The installed source may predate #581 and maintain its queue before it connects, as in rollback.
      const healthyState = await healthy(binding, previous, { ...input, timeoutMs: input.timeoutMs ?? ROLLBACK_HEALTH_TIMEOUT_MS });
      stage = "settle";
      await assertSettled(input, binding, native, healthyState, true);
      keepDrain = false;
    } catch (cause) {
      // Before any native effect the drain goes back to how it was found: none stays none, a stale one stays held.
      if (!effect || stopNotIssued(stage, cause)) { keepDrain = reclaimed; throw cause; }
      throw serviceFailure("SERVICE_RECOVER_FAILED", cause, "unknown", stage, undefined, stageStopCode(stage, cause),
        { writeAttempted: false, drainRetained: true });
    } finally { clearPermit(); if (!keepDrain) endDrain(); }
    done.push("release-drain");
    const after = deps.readState(input.paths);
    const drain = describeServiceDrain(input.paths, input.ownerProbe);
    return { recovered: true, view: { ok: true, action: "recover", confirmed: true, serviceName: binding.serviceName, platform: binding.platform,
      ...(binding.taskPath ? { taskPath: binding.taskPath } : {}),
      source: { commit: binding.source.commit, digest: binding.source.digest, kind: binding.source.kind }, done,
      final: { running: true, node: serviceNodeState(Boolean(after && deps.alive(after.pid)), drain), drain } } };
  } finally { release(); }
}
