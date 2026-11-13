import fs from "node:fs";

import { codexHome } from "./codex-app.mts";
import { probeCodexHolders, type Holder, type HolderProbe, type HolderScan } from "./codex-holder-probe.mts";
import { probeCodexHoldersWindows } from "./codex-holder-probe-windows.mts";
import { CODEX_ACTIVE_MS, CODEX_RUNTIME, isCodexSessionId, readCodexSession, type CodexSessionRecord } from "./codex-sessions.mts";
import type { NodePaths } from "./config.mts";
import type { LivenessSource } from "./liveness-pass.mts";
import { readPolicy } from "./policy.mts";
import { validIdentity, type Observation, type ReasonCode, type SessionEvidence, type SessionTarget } from "./session-liveness.mts";

// Issue #706, Phase 2: the Codex liveness source, on nodes with
// wake.nativeQueue only. Per Codex thread, at probe time:
// - holder (native-holder): the one live codex process holding the thread's
//   rollout, as <pid>:<start>; absent only from a completed scan;
// - app (native-app): whether any codex process runs;
// - loaded (native-app): true while held (decision D1);
// - turn (native-turn): the delivery hook's record bound to that holder
//   (decision D2); the rollout is stat'ed, never opened.
// Every failure is UNKNOWN: never a positive, never an absence.

// Below the 60 s listing tick, so every tick observes once and the receipt
// (DISPLAY_TTL_MS) never lapses between ticks (design finding F1).
export const CODEX_LIVENESS_INTERVAL_MS = 50_000;
// An idle claim is refuted when the rollout was written this long after the
// turn boundary: a turn started that no hook recorded. ASSUMED from one
// measurement (task_complete about 150 ms after Stop).
export const IDLE_WRITE_SLACK_MS = 30_000;
const IDLE_SOURCES = new Set(["startup", "resume", "clear", "fork"]);

type Turn = Observation<"running" | "idle">;
const unknownAt = <T,>(observedAt: number, source: Observation<T>["source"], reasonCode: ReasonCode): Observation<T> =>
  ({ status: "unknown", observedAt, complete: false, source, reasonCode });
const valueAt = <T,>(observedAt: number, source: Observation<T>["source"], value: T): Observation<T> =>
  ({ status: "value", value, observedAt, complete: true, source, reasonCode: "observed" });

// The turn of a held thread from its hook record. rolloutMtimeMs: undefined
// when the held rollout could not be stat'ed, which refuses an idle claim.
export function turnFor(record: CodexSessionRecord | null, holder: Holder, rolloutMtimeMs: number | undefined, now: number): Turn {
  const unknown = (reason: ReasonCode): Turn => unknownAt(now, "native-turn", reason);
  if (!record) return unknown("missing");
  const eventAt = Date.parse(record.lastEventAt ?? "");
  if (!record.lastEvent || !Number.isFinite(eventAt)) return unknown("incomplete");
  if (eventAt > now) return unknown("future");
  // The event belongs to an earlier process of this thread.
  if (eventAt < holder.startMs) return unknown("incomplete");
  const idleSince = (boundary: number): Turn => {
    if (rolloutMtimeMs === undefined) return unknown("failed");
    return rolloutMtimeMs - boundary > IDLE_WRITE_SLACK_MS ? unknown("conflict") : valueAt(now, "native-turn", "idle");
  };
  switch (record.lastEvent) {
    case "UserPromptSubmit": case "PostToolUse": return valueAt(now, "native-turn", "running");
    case "Stop": {
      if (record.lastStopEnded !== true) return valueAt(now, "native-turn", "running");
      const stopAt = Date.parse(record.lastStopAt ?? "");
      return idleSince(Number.isFinite(stopAt) ? stopAt : eventAt);
    }
    case "SessionStart": return record.lastStartSource && IDLE_SOURCES.has(record.lastStartSource) ? idleSince(eventAt) : unknown("incomplete");
    // Interrupt: the runtime does not start a queued message on an interrupted
    // thread. SessionEnd: the thread is closing; a remaining holder stays reachable-probable.
    default: return unknown("incomplete");
  }
}

function mtime(file: string): number | undefined {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function record(paths: NodePaths, threadId: string): CodexSessionRecord | null | "malformed" {
  try {
    const value = readCodexSession(paths, threadId);
    if (value === null) return null;
    if (value.sessionId !== threadId || value.runtime !== CODEX_RUNTIME) return "malformed";
    return value;
  } catch {
    return "malformed";
  }
}

// The evidence of one Codex thread from a completed scan; undefined when the
// scan did not cover it (Windows candidates).
export function threadEvidence(paths: NodePaths, target: SessionTarget, scan: HolderScan): SessionEvidence | undefined {
  if (scan.probed && !scan.probed.has(target.sessionId)) return;
  const at = scan.at, held = scan.holders.get(target.sessionId) ?? [];
  const evidence: SessionEvidence = { runtime: target.runtime, sessionId: target.sessionId,
    app: valueAt(at, "native-app", scan.processes.length > 0 ? "present" : "absent") };
  // Issue #899: the thread's own query failed; never an absence.
  if (scan.failed?.has(target.sessionId)) return { ...evidence, holder: unknownAt(at, "native-holder", "failed") };
  if (held.length > 1) return { ...evidence, holder: unknownAt(at, "native-holder", "conflict") };
  if (held.length === 0) return { ...evidence, holder: valueAt(at, "native-holder", { present: false }) };
  const holder = held[0];
  const stored = record(paths, target.sessionId);
  return { ...evidence, holder: valueAt(at, "native-holder", { present: true, creationIdentity: holder.identity }),
    loaded: valueAt(at, "native-app", true),
    turn: stored === "malformed" ? unknownAt(at, "native-turn", "malformed") : turnFor(stored, holder, mtime(holder.file), at) };
}

// Windows candidates: recorded threads seen within CODEX_ACTIVE_MS, newest first.
function candidates(paths: NodePaths, threads: string[], now: number): string[] {
  return threads.flatMap(id => {
    const stored = record(paths, id);
    const seen = stored && stored !== "malformed" ? Date.parse(stored.lastSeen) : Number.NaN;
    return Number.isFinite(seen) && seen <= now && now - seen <= CODEX_ACTIVE_MS ? [{ id, seen }] : [];
  }).sort((a, b) => b.seen - a.seen).map(c => c.id);
}

// log: the daemon log; a probe problem is written only when it changes (issue #899).
export interface CodexLivenessOptions { paths: NodePaths; home?: string; probe?: HolderProbe; now?: () => number; platform?: NodeJS.Platform;
  log?: (line: string) => void }

const REASON_CHARS = 200;
// The last non-empty line of the failure, without paths. An execFile rejection
// (measured, Node 26) has no stderr property: its message is
// "Command failed: <cmd>\n<stderr>", and <cmd> carries the script with its
// base64 rollout paths, so that prefix is dropped first. PowerShell text is localised.
export function probeFailureReason(error: unknown): string {
  const { message, cmd, code } = (error ?? {}) as { message?: unknown; cmd?: unknown; code?: unknown };
  let text = typeof message === "string" ? message : String(error);
  const command = typeof cmd === "string" ? `Command failed: ${cmd}` : undefined;
  if (command && text.startsWith(command)) text = text.slice(command.length);
  const line = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) ?? (code === undefined ? "no reason" : `exit ${String(code)}`);
  return line.replace(/\S*(?:rollout-|[A-Za-z]:\\|\\\\|\/)\S*/g, "<path>").slice(0, REASON_CHARS);
}

// Thread ids have one fixed length, so sorting the rows sorts by thread.
const scanProblem = (scan: HolderScan): string => [...scan.failed ?? []].map(([id, reason]) => `${id}: ${reason}`).sort().join("; ");

// The platform's holder probe; Linux and others have none (UNKNOWN/unsupported).
function defaultProbe(platform: NodeJS.Platform): HolderProbe | undefined {
  if (platform === "darwin") return probeCodexHolders;
  if (platform === "win32") return probeCodexHoldersWindows;
  return undefined;
}

export function codexLivenessSource(options: CodexLivenessOptions): LivenessSource & { intervalMs: number } {
  const { paths, now = Date.now, platform = process.platform } = options;
  const probe = options.probe ?? defaultProbe(platform);
  let problem = "";
  const report = (next: string) => {
    if (next === problem) return;
    problem = next;
    options.log?.(next ? `kherep-node: codex holder probe failed: ${next}` : "kherep-node: codex holder probe recovered");
  };
  return { intervalMs: CODEX_LIVENESS_INTERVAL_MS, observe: async (targets, signal) => {
    const t = now();
    // Nodes without the native Queue run no probe and behave as before.
    if (readPolicy(paths.policy)?.wake?.nativeQueue !== true || !probe) return unknownAt(0, "unsupported", "unsupported");
    const threads = targets.filter(target => target.runtime === CODEX_RUNTIME && validIdentity(target) && isCodexSessionId(target.sessionId));
    let scan: HolderScan;
    try {
      scan = await probe(options.home ?? codexHome(), candidates(paths, [...new Set(threads.map(x => x.sessionId))], t), signal);
      signal.throwIfAborted();
      if (!Number.isFinite(scan.at) || scan.at < t || scan.at > now()) throw new Error("holder scan time out of range");
    } catch (error) {
      if (signal.aborted) return unknownAt(t, "native-holder", "aborted");
      report(`scan: ${probeFailureReason(error)}`);
      return unknownAt(t, "native-holder", "failed");
    }
    report(scanProblem(scan));
    const value = threads.flatMap(target => threadEvidence(paths, target, scan) ?? []);
    return valueAt(scan.at, "native-holder", value);
  } };
}
