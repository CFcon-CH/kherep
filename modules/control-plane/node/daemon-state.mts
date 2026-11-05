import path from "node:path";
import type { IntakeNumbers } from "./intake-diagnostics.mts";

import { isTaskRuntime, type TaskRuntime } from "../protocol-tasks.mts";
import type { NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import type { ProbeCause } from "./runtime-probe.mts";
import { freshReady, type Verdict } from "./runtime-readiness.mts";
import type { SourceIdentity } from "./daemon-source.mts";

// Liveness evidence for `kherep-node doctor` (issue #215): daemon.json beside
// node.json, written when the daemon starts and again after each
// authenticated connection, and with disconnectedAt when a connection closes
// (cleared by the next authentication). It holds a process id and timestamps,
// and per runtime the last readiness probe (issue #222): ready or not with the
// fixed cause code, and when it completed; never the probe's output.
export interface ProbeRecord { ready: boolean; cause?: ProbeCause; probedAt: string }
export interface DaemonServiceBinding { name: string; platform: "darwin" | "win32"; taskPath?: string }
// Issue #420: a Claude probe that the previous daemon's stop interrupted
// (install-pause.mts noticeInterruptedProbe): that daemon's pid, the probe
// start and when this daemon noticed it.
export interface InterruptedProbe { runtime: "claude"; pid: number | null; at: string; noticedAt: string }
export interface DaemonState {
  pid: number; startedAt: string; connectedAt?: string; disconnectedAt?: string;
  intake?: IntakeNumbers;
  source?: SourceIdentity; service?: DaemonServiceBinding; readiness?: Partial<Record<TaskRuntime, ProbeRecord>>;
  interruptedProbe?: InterruptedProbe;
}

export const daemonStateFile = (paths: NodePaths): string => path.join(paths.dir, "daemon.json");

// A ready Claude verdict ends an interrupted-probe record (issue #420).
export function withVerdict(state: DaemonState, runtime: TaskRuntime, verdict: Verdict): DaemonState {
  const probedAt = new Date(verdict.at).toISOString();
  const record: ProbeRecord = verdict.ready ? { ready: true, probedAt } : { ready: false, cause: verdict.cause, probedAt };
  return { ...state, readiness: { ...state.readiness, [runtime]: record },
    ...(runtime === "claude" && verdict.ready ? { interruptedProbe: undefined } : {}) };
}

// Issue #420: what a starting daemon takes over from the previous daemon.json.
// Its fresh ready verdicts (runtime-readiness.mts freshReady) stand in for the
// start-up probe, which otherwise runs at every restart, exactly when daemons
// are killed. Not Claude's while an interrupted probe is on record: that record
// stays, across restarts, until the next ready Claude verdict.
export function carriedOver(previous: DaemonState | null, noticed: InterruptedProbe | null, now: number):
  Pick<DaemonState, "readiness" | "interruptedProbe"> {
  const interruptedProbe = noticed ?? (typeof previous?.interruptedProbe?.at === "string" ? previous.interruptedProbe : undefined);
  const readiness: DaemonState["readiness"] = Object.fromEntries(Object.entries(previous?.readiness ?? {})
    .filter(([runtime, record]) => isTaskRuntime(runtime) && !(interruptedProbe && runtime === "claude") && freshReady(record, now)));
  return { ...(Object.keys(readiness).length > 0 ? { readiness } : {}), ...(interruptedProbe ? { interruptedProbe } : {}) };
}

export const readDaemonState = (paths: NodePaths): DaemonState | null => readJson<DaemonState>(daemonStateFile(paths));

// The previous daemon's record for carriedOver, null when missing or unreadable.
export function previousDaemonState(paths: NodePaths): DaemonState | null {
  try { return readDaemonState(paths); } catch { return null; }
}

// A failed write is logged and never stops the daemon.
export function recordDaemonState(paths: NodePaths, state: DaemonState, log: (line: string) => void): void {
  try {
    writeJsonAtomic(daemonStateFile(paths), state);
  } catch (error) {
    log(`kherep-node: daemon state not recorded: ${String(error)}`);
  }
}

// EPERM: the process exists but belongs to another user.
export function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
