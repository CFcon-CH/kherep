import type { NodePaths } from "./config.mts";
import { readDaemonState } from "./daemon-state.mts";
import type { Check } from "./doctor-local.mts";
import { describeServiceDrain, type ServiceOwnerProbe } from "./service-drain.mts";
import { readServiceLastFailure } from "./service-last-failure.mts";
import { readServiceReceipt } from "./service-records.mts";
import { serviceNodeState, type ServiceNodeState } from "./service-status.mts";

// `kherep-node doctor` check managedService (#838 (c)): the node state `service status` reports, without a native
// read: off, drain-blocked or running, with the recovery text (#810: `service recover`). The last failure is shown, never judged: ok follows
// the node state alone. Codes, states, times and a commit only: no path, pid, label or native output.
const RECOVERY: Record<Exclude<ServiceNodeState, "running">, string> = {
  off: "the managed service's daemon is not running; kherep-node service status shows why; kherep-node service recover prints whether the installed service can be started again and, with --confirm, starts it, see docs/INSTALLATION.md",
  "drain-blocked": "a stale or unverifiable service drain blocks new session admissions; kherep-node service status shows why; kherep-node service recover --confirm reclaims a stale drain and restarts the installed service, see docs/INSTALLATION.md",
};

function shownLastFailure(paths: NodePaths): "invalid" | Record<string, unknown> | undefined {
  const record = readServiceLastFailure(paths);
  if (record === null) return undefined;
  if (record === "invalid") return "invalid";
  return { command: record.command, failedAt: record.failedAt, ...(record.stage ? { stage: record.stage } : {}),
    ...(record.stopCode ? { stopCode: record.stopCode } : {}), ...(record.recovery ? { recovery: record.recovery } : {}),
    ...(record.native ? { call: record.native.call, outcome: record.native.outcome } : {}) };
}

export function checkManagedService(paths: NodePaths, alive: (pid: unknown) => boolean, probe?: ServiceOwnerProbe): Check {
  let managed: boolean;
  try { managed = readServiceReceipt(paths) !== null; }
  catch { return { ok: false, managed: "unknown", detail: "the managed service receipt is unreadable, see docs/INSTALLATION.md" }; }
  if (!managed) return { ok: true, managed: false };
  let daemonAlive = false;
  try { const state = readDaemonState(paths); daemonAlive = Boolean(state && alive(state.pid)); } catch { daemonAlive = false; }
  const drain = describeServiceDrain(paths, probe);
  const node = serviceNodeState(daemonAlive, drain);
  const lastFailure = shownLastFailure(paths);
  return { ok: node === "running", managed: true, node, drain, ...(lastFailure ? { lastFailure } : {}),
    ...(node === "running" ? {} : { detail: RECOVERY[node] }) };
}
