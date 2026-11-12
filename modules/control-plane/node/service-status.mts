import { pidAlive, readDaemonState, type DaemonState } from "./daemon-state.mts";
import { compareSourceIdentity } from "./daemon-source.mts";
import { SERVICE_DRAIN_BLOCKED, describeServiceDrain, type ServiceOwnerProbe } from "./service-drain.mts";
import type { NodePaths } from "./config.mts";
import { servicePlatform } from "./service-platform.mts";
import { readServiceCandidate, serviceRoot, snapshotDigests, type ServiceCandidate, type ServiceReceipt } from "./service-records.mts";
import { candidateInPlace, recordedPriorBackup, sameBinding, SERVICE_STAGES } from "./service-transaction-support.mts";
import { configuredDefinitionDigest } from "./service-configured-digest.mts";
import type { NativeServiceSnapshot, ServiceBinding } from "./service-types.mts";
import { readServiceLastFailure } from "./service-last-failure.mts";

// `service status`, managed and unmanaged. Moved from service-cli.mts for the 250-line budget (#582).
type Paths = NodePaths;
export interface StatusDependencies {
  adapterFor?: typeof servicePlatform;
  readState?: (paths: Paths) => DaemonState | null;
  alive?: (pid: unknown) => boolean;
  ownerProbe?: ServiceOwnerProbe;
  readCandidate?: (paths: Paths) => ServiceCandidate | null;
  configuredDigest?: (binding: ServiceBinding) => string | null;
}
const SERVICE_STAGE_SET = new Set<string>(SERVICE_STAGES);
// #838 (c): the node at a glance. off: no live recorded daemon; drain-blocked: the daemon lives but a stale or
// unverifiable service drain blocks new session admissions; running otherwise. Shared with doctor's managedService.
export type ServiceNodeState = "running" | "off" | "drain-blocked";
export const serviceNodeState = (daemonAlive: boolean, drain: ReturnType<typeof describeServiceDrain>): ServiceNodeState =>
  !daemonAlive ? "off" : drain === "stale" || drain === "unknown" ? "drain-blocked" : "running";
// #838 A4: display only; an unreadable record is "invalid" and changes nothing else in the report.
const lastFailureReport = (paths: Paths) => {
  const record = readServiceLastFailure(paths);
  return record ? { lastFailure: record === "invalid" ? "invalid" : (({ version: _version, ...shown }) => shown)(record) } : {};
};
type Configured = "receipt" | "candidate" | "unknown";
function classifyConfigured(receipt: ServiceReceipt, pending: ServiceCandidate | null, digest: string | null): Configured {
  if (digest === null) return "unknown";
  if (digest === receipt.definitionDigest) return "receipt";
  return pending && sameBinding(pending.binding, receipt.binding) && digest === pending.definitionDigest ? "candidate" : "unknown";
}
const UNATTESTED = {
  darwin: {
    receipt: "the configured plist matches the receipt but its loaded LaunchAgent could not be attested; reload launchd from the plist (launchctl bootout, then bootstrap), see docs/INSTALLATION.md",
    candidate: "the configured plist matches the recorded candidate but its loaded LaunchAgent could not be attested; reload launchd from the plist (launchctl bootout, then bootstrap), then rollback or upgrade, see docs/INSTALLATION.md",
    unknown: "the configured service definition matches no recorded definition; do not reload it, see docs/INSTALLATION.md",
  },
  win32: "the Scheduled Task could not be read back; inspect the task before re-registering it, see docs/INSTALLATION.md",
} as const;
const CANDIDATE = "kherep-node service upgrade --source <clean checkout> activates it over the failed candidate; kherep-node service rollback restores the receipt's definition";
const CANDIDATE_UNKNOWN = {
  darwin: "the recorded candidate is loaded without a running process; upgrade and rollback refuse it; unload it by hand (launchctl bootout), then run kherep-node service rollback, see docs/INSTALLATION.md",
  win32: "the recorded candidate task is in an unknown state; upgrade and rollback refuse it; stop the task by hand, then run kherep-node service rollback, see docs/INSTALLATION.md",
} as const;
// #677: the stopped service no longer runs its daemon, whose process lives on; both verbs refuse until it ends.
const OUTLIVED = {
  darwin: "the previous daemon is no longer loaded by launchd but its process still runs; upgrade and rollback refuse until it ends; end that process by hand, then run kherep-node service upgrade --source <clean checkout>, see docs/INSTALLATION.md",
  win32: "the Scheduled Task is stopped but its daemon process still runs; upgrade and rollback refuse until it ends; end that process by hand, then run kherep-node service upgrade --source <clean checkout>, see docs/INSTALLATION.md",
} as const;
// #582 (A2 P2-C): a failed install left its candidate loaded under the label and no receipt; only a repeated install completes it.
const INSTALL_REPEAT = "a recorded install candidate is loaded without a receipt; repeat kherep-node service install with the same --workspace and --service-name, without --adopt, see docs/INSTALLATION.md";
const LEGACY_RECOVERY = "unrecorded task drift requires a receipt-bound backup and an exact verified candidate checkout; the fixed CLI supports kherep-node service rollback --recover --backup <backup-id> --source <candidate-clean-checkout>; stop on any source, ownership, task or security conflict, see docs/INSTALLATION.md";
const priorState = (paths: Paths, record: ServiceCandidate, receipt: ServiceReceipt | null): "recorded" | "unbound" | "none" =>
  !record.backupId ? "none" : recordedPriorBackup(paths, record, receipt) ? "recorded" : "unbound";
const candidateReport = (paths: Paths, record: ServiceCandidate, receipt: ServiceReceipt | null) => ({
  commit: record.binding.source.commit, command: record.command, stage: SERVICE_STAGE_SET.has(record.stage ?? "") ? record.stage : "unknown",
  blocker: record.blocker, stopCode: record.stopCode, failedAt: record.failedAt, prior: priorState(paths, record, receipt) });
const readRecord = (paths: Paths, dependencies: StatusDependencies): ServiceCandidate | null | "invalid" => {
  try { return (dependencies.readCandidate ?? readServiceCandidate)(paths); } catch { return "invalid"; }
};

// #582 (A2 P2-C): no receipt. Without a record the node is unmanaged, as before, and no adapter is consulted. A record
// whose definition is attested in place reports the loaded candidate and the install-repeat text; a record that cannot
// be attested reports "unattested"; a stale or invalid record is reported and leaves ok to the unmanaged verdict.
export async function reportUnmanagedStatus(paths: Paths, dependencies: StatusDependencies): Promise<number> {
  const pending = readRecord(paths, dependencies);
  let report: Record<string, unknown> = { ok: true, managed: false };
  if (pending === "invalid") report = { ...report, candidate: "invalid" };
  else if (pending) {
    let native: NativeServiceSnapshot | null = null, attested = true;
    try { native = await (dependencies.adapterFor ?? servicePlatform)(serviceRoot(paths), pending.binding.platform).read(pending.binding); } catch { attested = false; }
    report = !attested ? { ok: false, managed: false, serviceName: pending.binding.serviceName, platform: pending.binding.platform, definition: "unattested", candidate: "unattested" }
      : candidateInPlace(pending, native, pending.binding)
        ? { ok: false, managed: false, serviceName: pending.binding.serviceName, platform: pending.binding.platform,
          ...(pending.binding.taskPath ? { taskPath: pending.binding.taskPath } : {}), running: native!.running,
          candidate: candidateReport(paths, pending, null), recovery: INSTALL_REPEAT }
        : { ...report, candidate: "stale" };
  }
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

export async function reportServiceStatus(paths: Paths, receipt: ServiceReceipt, dependencies: StatusDependencies): Promise<number> {
  const adapter = (dependencies.adapterFor ?? servicePlatform)(serviceRoot(paths), receipt.binding.platform);
  let native: NativeServiceSnapshot | null = null, attested = true;
  try { native = await adapter.read(receipt.binding); } catch { attested = false; }
  const pending = readRecord(paths, dependencies);
  const record = pending !== "invalid" && candidateInPlace(pending, native, receipt.binding) ? pending : null;
  const configured = attested ? undefined
    : classifyConfigured(receipt, pending === "invalid" ? null : pending, (dependencies.configuredDigest ?? configuredDefinitionDigest)(receipt.binding));
  const digests = native ? snapshotDigests(native) : null;
  const state = (dependencies.readState ?? readDaemonState)(paths);
  const definitionMatch = digests?.definitionDigest === receipt.definitionDigest && digests.securityDigest === receipt.securityDigest;
  const source = compareSourceIdentity(receipt.binding.source, state?.source);
  const alive = dependencies.alive ?? pidAlive;
  const startedAt = state ? Date.parse(state.startedAt) : Number.NaN;
  const connectedAt = state?.connectedAt ? Date.parse(state.connectedAt) : Number.NaN;
  const authenticated = Number.isFinite(startedAt) && Number.isFinite(connectedAt) && connectedAt >= startedAt && !state?.disconnectedAt;
  const bindingMatch = state?.service?.name === receipt.binding.serviceName && state.service.platform === receipt.binding.platform
    && state.service.taskPath === receipt.binding.taskPath;
  let ownership = false;
  if (native?.running === true && state && authenticated && bindingMatch && source.status === "match" && alive(state.pid)) {
    try { ownership = await adapter.processOwned(state.pid, receipt.binding, state.startedAt); } catch { ownership = false; }
  }
  const runtimeMatch = native?.running === true && authenticated && bindingMatch && ownership;
  // Issue #472: a drain left by a dead controller blocks admissions until an upgrade reclaims it.
  const drain = describeServiceDrain(paths, dependencies.ownerProbe);
  const staleDrain = drain === "stale" || drain === "unknown";
  const upgrade = "kherep-node service upgrade --source <clean checkout>";
  const installed = `(installed source ${receipt.binding.source.commit})`;
  const driftRecovery = receipt.binding.platform === "win32" && pending === null ? LEGACY_RECOVERY
    : "service definition drift is unbound; inspect the source and backup evidence, see docs/INSTALLATION.md";
  const recovery = !attested
    ? (receipt.binding.platform === "darwin" ? UNATTESTED.darwin[configured!] : UNATTESTED.win32)
    : drain === "unknown" ? "the service drain owner cannot be verified; inspect the service/drain owner file"
      : record ? (native?.running === "unknown" ? CANDIDATE_UNKNOWN[receipt.binding.platform] : CANDIDATE)
        : native?.running === false && state && alive(state.pid) && drain !== "active" ? OUTLIVED[receipt.binding.platform]
        : !definitionMatch ? driftRecovery
        : drain === "stale" ? `${upgrade} reclaims the stale drain ${installed}`
          : native?.running === false && (!state || !alive(state.pid)) ? `${upgrade} ${installed}` : undefined;
  // A2 P3-3: while unattested no record can be matched, so a present record is "unattested", never "stale".
  const candidate = record ? candidateReport(paths, record, receipt)
    : pending === "invalid" ? "invalid" : pending ? (attested ? "stale" : "unattested") : undefined;
  const daemonStart = receipt.binding.platform === "win32" && native?.running === true && staleDrain && (!state || !alive(state.pid))
    ? SERVICE_DRAIN_BLOCKED : undefined;
  const report = { ok: attested && definitionMatch === true && source.status === "match" && runtimeMatch && !staleDrain && !record, managed: true,
    node: serviceNodeState(Boolean(state && alive(state.pid)), drain), serviceName: receipt.binding.serviceName, platform: receipt.binding.platform,
    ...(receipt.binding.taskPath ? { taskPath: receipt.binding.taskPath } : {}), running: attested ? (native?.running ?? "unknown") : "unknown",
    definition: !attested ? "unattested" : native ? (definitionMatch ? "match" : "mismatch") : "missing",
    ...(attested || receipt.binding.platform !== "darwin" ? {} : { configured }), source: source.status,
    authentication: authenticated ? "connected" : state?.disconnectedAt ? "disconnected" : "unknown",
    ownership: ownership ? "match" : "unknown", drain, ...(daemonStart ? { daemonStart } : {}),
    ...(candidate ? { candidate } : {}), ...(recovery ? { recovery } : {}), ...lastFailureReport(paths) };
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}
