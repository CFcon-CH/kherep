import fs from "node:fs";
import path from "node:path";

import { listenerDir, type ListenerLock } from "./autonomy.mts";
import { classifyBusyHintLock } from "./busy-hint-lock.mts";
import { FORK_ATTEMPT_STATES, forkAttempts, type ForkAttemptState } from "./codex-fork-attempts.mts";
import { CODEX_ACTIVE_MS, isCodexHookEvent, isCodexSessionId, type CodexHookEvent, type CodexSessionRecord } from "./codex-sessions.mts";
import { readConfig, type NodeConfig, type NodePaths } from "./config.mts";
import { diagnosticNumbers } from "./intake-diagnostics.mts";
import { readDaemonState } from "./daemon-state.mts";
import { captureSourceIdentity, compareSourceIdentity, type SourceIdentity } from "./daemon-source.mts";
import { readPrivateKey } from "./identity.mts";
import { readJson } from "./inbox.mts";
import { pruneCandidates, type PruneSkip } from "./listener-prune.mts";
import { readPolicy, wakeBudget, type NodePolicy, type WakeBudget } from "./policy.mts";
import { WAKE_MAX_WAIT_MS } from "./wake-hook.mts";
export { checkWakeReadiness } from "./wake-readiness.mts";

// The checks of `kherep-node doctor` that read only this node's config
// directory (issue #215). Details are fixed texts, ids, counts and times:
// never key material, tokens, error texts of a key parse or message bodies.
export interface Check { ok: boolean; detail?: string; [field: string]: unknown }

export function checkEnrollment(paths: NodePaths): { check: Check; config: NodeConfig | null } {
  let config: NodeConfig | null;
  try {
    config = readConfig(paths.config);
  } catch {
    return { check: { ok: false, enrolled: false, detail: "node.json is unreadable or invalid" }, config: null };
  }
  if (!config) return { check: { ok: false, enrolled: false, detail: "not enrolled; run kherep-node node onboard" }, config };
  let matches: boolean;
  try {
    matches = readPrivateKey(config.privateKeyFile).publicKey === config.publicKey;
  } catch {
    return { check: { ok: false, enrolled: true, nodeId: config.nodeId, keyReadable: false, detail: "private key is missing or unreadable" }, config };
  }
  return { check: { ok: matches, enrolled: true, nodeId: config.nodeId, keyReadable: true,
    ...(matches ? {} : { detail: "private key does not match the enrolled public key" }) }, config };
}

// ok: the recorded process runs and its last connection is authenticated.
function checkSource(recorded: SourceIdentity | undefined, repoRoot: string): Check {
  if (!recorded) return { ok: false, status: "unknown", detail: "the daemon did not record a startup source identity; restart it through the managed service" };
  try {
    const compared = compareSourceIdentity(recorded, captureSourceIdentity(repoRoot, false));
    if (compared.status === "match") return { ok: true, status: "match", running: recorded };
    if (compared.status === "mismatch") return { ok: false, status: "mismatch", reason: compared.reason, running: recorded,
      detail: "the running daemon loaded a different source than the invoking checkout" };
    return { ok: false, status: "unknown", running: recorded, detail: compared.reason };
  } catch {
    return { ok: false, status: "unknown", running: recorded, detail: "the invoking source identity could not be verified" };
  }
}

export function checkDaemon(paths: NodePaths, pidAlive: (pid: unknown) => boolean, repoRoot: string): Check {
  let state;
  try {
    state = readDaemonState(paths);
  } catch {
    return { ok: false, detail: "daemon.json is unreadable" };
  }
  if (!state) return { ok: false, alive: false, detail: "no daemon state; the daemon has not run since this version" };
  const alive = pidAlive(state.pid);
  const connectedAt = typeof state.connectedAt === "string" ? state.connectedAt : null;
  const disconnectedAt = typeof state.disconnectedAt === "string" ? state.disconnectedAt : null;
  const source = checkSource(state.source, repoRoot);
  let detail: string | undefined;
  if (!alive) detail = "the recorded daemon process is not running";
  else if (!connectedAt) detail = "the daemon has not authenticated since it started";
  else if (disconnectedAt) detail = "the daemon lost its connection and has not authenticated again";
  else if (!source.ok) detail = String(source.detail);
  return { ok: alive && connectedAt !== null && disconnectedAt === null && source.ok, pid: state.pid, alive, startedAt: state.startedAt,
    connectedAt, disconnectedAt, source, ...(diagnosticNumbers(state.intake) ? { intake: diagnosticNumbers(state.intake) } : {}), ...(detail ? { detail } : {}) };
}

// The readiness record of a running daemon (issue #222), with a Claude probe
// its start found interrupted (issue #420). A dead daemon's record describes no
// running node, so it and an unreadable file give null.
export function daemonReadiness(paths: NodePaths, pidAlive: (pid: unknown) => boolean): Record<string, unknown> | null {
  try {
    const state = readDaemonState(paths);
    if (!state || !pidAlive(state.pid) || (!state.readiness && !state.interruptedProbe)) return null;
    return { ...state.readiness, ...(state.interruptedProbe ? { interruptedProbe: state.interruptedProbe } : {}) };
  } catch {
    return null;
  }
}

// The effective autonomous-turn budget in the policy's units: the defaults
// without a valid wake.budget (issue #259).
function budgetReport(policy: NodePolicy): Required<WakeBudget> {
  const { perHour, perDay, spacingMs } = wakeBudget(policy);
  return { perHour, perDay, spacingSeconds: spacingMs / 1000 };
}

// A wake section the parser rejected disables waking (fail closed); doctor
// reports it as a failure so the operator sees it (issue #390): wakeSource is
// "file" for a written section, else "default" (a file without it, or no file).
// messagingSource is "file" for a written section, "absent" for a file without
// one (nothing is accepted), and "default" for no file (DEFAULT_POLICY).
export function checkPolicy(file: string): { check: Check; policy: NodePolicy | null } {
  const policy = readPolicy(file);
  if (!policy) return { check: { ok: false, detail: "policy.json is unreadable or malformed; nothing is allowed" }, policy };
  type RawSections = { wake?: unknown; messaging?: unknown };
  let raw: RawSections | null = null;
  try {
    raw = readJson<RawSections>(file);
  } catch {
    // readPolicy accepted the file a moment ago; a race leaves raw null.
  }
  const wakeWritten = raw?.wake !== undefined;
  const wakeSource = wakeWritten ? "file" : "default";
  let messagingSource = "default";
  if (raw) messagingSource = raw.messaging !== undefined ? "file" : "absent";
  // Issue #889: a written messaging.resumeClosed is read but has no effect; reported, never a failure.
  const resumeClosedWritten = typeof raw?.messaging === "object" && raw.messaging !== null && Object.hasOwn(raw.messaging, "resumeClosed");
  // enabled false is the operator's explicit opt-out, not a rejected section.
  const optedOut = (raw?.wake as { enabled?: unknown } | null | undefined)?.enabled === false;
  const wakeRejected = wakeWritten && !policy.wake && !optedOut;
  // Issue #890: a written wake.codexFork, valid or not, is read but starts no fork; reported, never a failure.
  const forkWritten = typeof raw?.wake === "object" && raw.wake !== null && Object.hasOwn(raw.wake, "codexFork");
  const retiredFork = forkWritten ? { codexFork: "retired" } : {};
  const wake = policy.wake
    ? { enabled: true, sessions: policy.wake.sessions, codexApp: policy.wake.codexApp === true, replies: policy.wake.replies === true,
      nativeQueue: policy.wake.nativeQueue === true, ...retiredFork }
    : { enabled: false, ...(wakeRejected ? { rejected: true } : {}), ...retiredFork };
  const detail = wakeRejected ? "the wake section is malformed and waking is off" : undefined;
  return { check: { ok: !wakeRejected, source: raw ? "file" : "default", allowedCommands: policy.allowedCommands.length,
    messagingRules: policy.messaging?.accept.length ?? 0, messagingSource, ...(resumeClosedWritten ? { resumeClosed: "retired" } : {}), wake, wakeSource, wakeBudget: budgetReport(policy),
    sessions: policy.sessions?.enabled ? { enabled: true, runtimes: policy.sessions.runtimes } : { enabled: false },
    remoteMcp: policy.remoteMcp?.enabled === true, ...(detail ? { detail } : {}) }, policy };
}

// Issue #408: the Codex sessions recorded within CODEX_ACTIVE_MS, counted by
// their last hook event (idle evidence); unknown counts a record from an older
// hook. Read only: unlike listCodexSessions it removes nothing. Counts only;
// session ids stay out of the report.
export function checkCodexSessions(paths: NodePaths, now: number): Check {
  let names: string[];
  try {
    names = fs.readdirSync(paths.codexSessions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, detail: "the Codex session directory is unreadable" };
    names = [];
  }
  const lastEvent: Record<CodexHookEvent | "unknown", number> = { SessionStart: 0, UserPromptSubmit: 0, PostToolUse: 0, Stop: 0, Interrupt: 0, SessionEnd: 0, unknown: 0 };
  let recorded = 0;
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    let record: CodexSessionRecord | null = null;
    try { record = readJson<CodexSessionRecord>(path.join(paths.codexSessions, name)); } catch { /* not counted */ }
    if (!record || !isCodexSessionId(record.sessionId) || `${record.sessionId}.json` !== name) continue;
    if (!(now - Date.parse(record.lastSeen) <= CODEX_ACTIVE_MS)) continue;
    recorded++;
    lastEvent[isCodexHookEvent(record.lastEvent) ? record.lastEvent : "unknown"]++;
  }
  return { ok: true, recorded, lastEvent };
}

// Issue #408: the Codex fork reply attempts by state and the number of owners
// whose store cannot be read completely. Counts only: no ids, answers or reasons.
export function checkCodexForkAttempts(paths: NodePaths): Check {
  const root = path.join(paths.dir, "codex-fork-attempts");
  let owners: string[];
  try {
    owners = fs.readdirSync(root).filter((name) => !name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, detail: "the Codex fork attempt directory is unreadable" };
    owners = [];
  }
  const states = Object.fromEntries(FORK_ATTEMPT_STATES.map((state) => [state, 0])) as Record<ForkAttemptState, number>;
  let unreadable = 0;
  for (const owner of owners) {
    try {
      for (const attempt of forkAttempts(paths, owner)) states[attempt.state]++;
    } catch {
      unreadable++;
    }
  }
  return { ok: unreadable === 0, states, unreadableOwners: unreadable,
    ...(unreadable ? { detail: "a Codex fork attempt store cannot be read completely" } : {}) };
}

// The state files the daemon's next prune removes, or why it would skip (issue #474).
function orphanedFiles(paths: NodePaths, now: number): number | PruneSkip {
  const candidates = pruneCandidates(paths, now);
  return candidates instanceof Map ? [...candidates.values()].reduce((sum, files) => sum + files.length, 0) : candidates.skipped;
}

// Busy-hint owner locks and their reclaim gates by class (issue #877), present only when there are any.
const BUSY_HINT_LOCK = /^[0-9a-f-]{36}\.busy-hint\.json\.lock(?:\.reclaim\.lock){0,2}$/;
type BusyHintLockCounts = { live: number; deadOwner: number; emptyOld: number; unverifiable: number };
function busyHintLocks(dir: string, names: string[], pidAlive: (pid: unknown) => boolean, now: number):
  { busyHintLocks?: BusyHintLockCounts } {
  const counts: BusyHintLockCounts = { live: 0, deadOwner: 0, emptyOld: 0, unverifiable: 0 };
  const key = { live: "live", "dead-owner": "deadOwner", "empty-old": "emptyOld", unverifiable: "unverifiable" } as const;
  const locks = names.filter((name) => BUSY_HINT_LOCK.test(name));
  for (const name of locks) counts[key[classifyBusyHintLock(path.join(dir, name), now, pidAlive)]]++;
  return locks.length ? { busyHintLocks: counts } : {};
}

// Live: the lock's process runs and the lock is younger than the listener's
// longest wait. Orphaned is hygiene, never a fault, as is a busy-hint lock
// that outlived its owner. Counts only; session ids stay out of the report.
export function checkListeners(paths: NodePaths, pidAlive: (pid: unknown) => boolean, now: number): Check {
  let names: string[];
  try {
    names = fs.readdirSync(listenerDir(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, live: 0, stale: 0, orphaned: orphanedFiles(paths, now) };
    return { ok: false, detail: "the listener directory is unreadable" };
  }
  let live = 0;
  let stale = 0;
  for (const name of names.filter((entry) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(entry))) {
    let lock: ListenerLock | null = null;
    try { lock = readJson<ListenerLock>(path.join(listenerDir(paths), name)); } catch { /* counted as stale */ }
    if (lock && pidAlive(lock.pid) && now - lock.startedAt <= WAKE_MAX_WAIT_MS) live++;
    else stale++;
  }
  return { ok: true, live, stale, orphaned: orphanedFiles(paths, now), ...busyHintLocks(listenerDir(paths), names, pidAlive, now) };
}
