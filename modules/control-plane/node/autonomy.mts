import fs from "node:fs";
import path from "node:path";

import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { classifyExclusiveCreate, pauseSync } from "./lock-contention.mts";
import { DEFAULT_TURN_BUDGET, type TurnBudget } from "./policy.mts";

// Guards for autonomous turns (issue #31): model turns no user prompt started,
// that is a wake by the listener (wake-hook.mts) and a Stop continuation by the
// delivery hook (deliver-core.mts). Operator decisions of 2026-09-25:
// - one budget per session for both: at most TURNS_PER_HOUR per rolling hour,
//   TURNS_PER_DAY per rolling day and TURN_SPACING_MS between two; the node
//   policy's wake.budget may set other values within bounds (policy.mts
//   wakeBudget, issue #259);
// - a session in permission mode bypassPermissions is never driven
//   autonomously; its messages wait for the next user prompt.

export const TURNS_PER_HOUR = DEFAULT_TURN_BUDGET.perHour;
export const TURNS_PER_DAY = DEFAULT_TURN_BUDGET.perDay;
export const TURN_SPACING_MS = DEFAULT_TURN_BUDGET.spacingMs;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type AutonomyAction = "listener-timeout" | "wake" | "stuck-offer" | "budget" | "depth-limit" | "superseded" | "disabled" | "rearm"
  | "permission-mode" | "not-allowlisted" | "parent-gone" | "continue" | "continue-budget" | "continue-permission-mode"
  // codex-queue.mts: waking an interactive Codex session with `codex queue`.
  | "queue-failed" | "permission-mode-unknown" | "ambiguous-name" | "intercom" | "intercom-refused" | "intercom-failed" | "awaiting-user-turn"
  // codex-queue.mts: a Desktop-classified thread is a TUI on the shared app-server daemon (issue #268).
  | "tui-reachable"
  // wake-hook.mts at SessionStart: messages that arrived while no listener ran (issue #101).
  | "backlog"
  // wake-hook.mts: the policy file turned unreadable; the listener keeps its last good policy (issue #213).
  | "policy-unreadable"
  // codex-wake.mts: the runtime's readiness probe failed; the messages were refused (issue #197).
  | "runtime-not-ready"
  // codex-wake.mts: the policy refused the task's working directory; the messages wait (issue #244).
  | "cwd-refused"
  // wake-hook.mts: a headless run (claude -p) ended its listener before the first poll (issue #235).
  | "headless"
  // The Codex idle reply proxy (issue #408, codex-fork-reply.mts).
  | "fork" | "fork-declined" | "fork-failed" | "fork-uncertain" | "fork-superseded" | "fork-not-idle" | "fork-disabled-platform"
  // codex-fork-relay.mts: the fork's answer went to the outbox as a proxy answer (issue #408, PR 4).
  | "fork-relayed"
  // codex-fork-reply.mts: a refusal before the claim, once per owner, message and code (issue #444);
  // the admission code with the prefix fork-, the producer's own codes as they are (FORK_AUDIT).
  | "fork-off" | "fork-kill-switch" | "fork-policy-changed" | "fork-not-recorded" | "fork-task-session" | "fork-permission-mode"
  | "fork-permission-mode-unknown" | "fork-not-opted-in" | "fork-post-tool-hook-missing" | "fork-message-not-eligible" | "fork-depth-limit"
  | "fork-attempt-exists" | "fork-in-flight" | "fork-attempts-unreadable" | "fork-cwd-refused" | "fork-runtime-pending"
  | "fork-runtime-not-ready" | "fork-budget-spacing" | "fork-budget-exhausted"
  | "fork-producer" | "fork-mcp-unknown" | "fork-features-unknown" | "fork-relay-unsupported";

export const listenerDir = (paths: NodePaths): string => path.join(paths.dir, "listeners");
export const wakeAudit = (paths: NodePaths): string => path.join(paths.dir, "wake.jsonl");
export const listenerLock = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.json`);
const turnsFile = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.turns.json`);

// Session ids name files, so only a plain token is accepted.
export const isPlainSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export const bypassesPermissions = (permissionMode: unknown): boolean => permissionMode === "bypassPermissions";

// The permission mode the session's last UserPromptSubmit or Stop input
// reported. A SessionStart input carries none (measured on Claude Code
// 2.1.258), so the listener armed there falls back to it (issue #97).
export const modeFile = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.mode.json`);
export function rememberMode(paths: NodePaths, sessionId: string, permissionMode: unknown): void {
  if (typeof permissionMode !== "string" || !/^[A-Za-z-]{1,32}$/.test(permissionMode)) return;
  ensureDir(listenerDir(paths));
  writeJsonAtomic(modeFile(paths, sessionId), { permissionMode });
}
export const rememberedMode = (paths: NodePaths, sessionId: string): string | undefined =>
  readJson<{ permissionMode?: string }>(modeFile(paths, sessionId))?.permissionMode;

// Why a session not in wake.sessions may be woken: "codexApp" (codex-app.mts),
// "reply" and "task", a message of a task the session requested (wake.replies,
// wake-reply.mts).
export type WakeGrant = "codexApp" | "reply" | "task";

// One line per decision: ids, the action and any grant, never message text.
export function audit(paths: NodePaths, now: number, sessionId: string, messageIds: string[], action: AutonomyAction,
  grant?: WakeGrant): void {
  ensureDir(paths.dir);
  fs.appendFileSync(wakeAudit(paths), `${JSON.stringify({ ts: new Date(now).toISOString(), sessionId, messageIds, action,
    ...(grant ? { grant } : {}) })}\n`, { mode: 0o600 });
}

// "spacing": the last turn is too recent; "exhausted": an hour or day window is
// full; "locked": another process held the budget too long, so the turn is
// denied rather than counted blind.
export type Budget = "ok" | "spacing" | "exhausted" | "locked";

// The listener and the delivery hooks run as separate processes, so the
// read-modify-write of the turns file is serialised by a lock file made with
// exclusive create. A lock older than BUDGET_LOCK_STALE_MS belongs to a process
// that died holding it and is removed. Two processes can both judge one lock
// stale; the loser of that rare race is told "locked" at worst. A create failing
// with EPERM, EACCES or EBUSY (Windows delete pending, issue #602) uses one of
// the LOCK_ATTEMPTS and is never taken for a stale lock.
export const BUDGET_LOCK_STALE_MS = 5_000;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 10;

function withBudgetLock(file: string, body: () => Budget): Budget {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      const outcome = classifyExclusiveCreate(error);
      if (outcome === "other") return "locked";
      if (outcome === "retry") {
        pauseSync(LOCK_RETRY_MS);
        continue;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > BUDGET_LOCK_STALE_MS) fs.rmSync(lock, { force: true });
        else pauseSync(LOCK_RETRY_MS);
      } catch {
        // released meanwhile: try again
      }
      continue;
    }
    let closing = false;
    try {
      fs.writeFileSync(fd, String(process.pid));
      closing = true;
      fs.closeSync(fd);
    } catch {
      // Ours by the exclusive create: removed, not left to the stale rule. A
      // descriptor is closed at most once.
      if (!closing) try { fs.closeSync(fd); } catch { /* the write failed already */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* left to the stale rule */ }
      return "locked";
    }
    try {
      return body();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
  return "locked";
}

function recentTurns(paths: NodePaths, sessionId: string, now: number): number[] {
  const turns = readJson<{ turns?: unknown }>(turnsFile(paths, sessionId))?.turns;
  return Array.isArray(turns) ? turns.filter((t): t is number => typeof t === "number" && now - t < DAY_MS) : [];
}

// Takes one autonomous turn when the budget allows it.
export function takeTurn(paths: NodePaths, sessionId: string, now: number, budget: TurnBudget = DEFAULT_TURN_BUDGET): Budget {
  const file = turnsFile(paths, sessionId);
  ensureDir(listenerDir(paths));
  return withBudgetLock(file, () => {
    const turns = recentTurns(paths, sessionId, now);
    if (turns.filter((t) => now - t < HOUR_MS).length >= budget.perHour || turns.length >= budget.perDay) return "exhausted";
    if (turns.some((t) => now - t < budget.spacingMs)) return "spacing";
    writeJsonAtomic(file, { turns: [...turns, now] });
    return "ok";
  });
}

// The delivery hook's gate for a Stop that would keep the turn going.
export function mayContinue(paths: NodePaths, sessionId: unknown, permissionMode: unknown, messageIds: string[], now: number,
  budget: TurnBudget = DEFAULT_TURN_BUDGET): boolean {
  if (!isPlainSessionId(sessionId)) return false;
  if (bypassesPermissions(permissionMode)) {
    audit(paths, now, sessionId, messageIds, "continue-permission-mode");
    return false;
  }
  const ok = takeTurn(paths, sessionId, now, budget) === "ok";
  audit(paths, now, sessionId, messageIds, ok ? "continue" : "continue-budget");
  return ok;
}

// The listener lock: newest wins; a listener recognises its own by token.
// event: the hook that armed it, with the SessionStart input's source;
// idleAt: set by StopFailure for a listener armed while a turn could run;
// order: when it armed relative to the session's other listeners (listener-order.mts).
export interface ListenerLock {
  token: string; pid: number; startedAt: number; event: "Stop" | "UserPromptSubmit" | "SessionStart"; source?: string; idleAt?: number;
  order?: number;
}

// What the live listener wakes for (issue #213): every message for its session
// (listed) or only those of its task grant (taskId) and, with replies, replies
// to its own messages (issue #253) and messages of tasks it requested (issue
// #264). Kept beside the lock and valid only while the lock carries the same
// token; delivery-progress.mts reads it.
// order: its lock's, so a listener can tell an older one's scope (issue #225).
export interface ListenerScope { token: string; listed: boolean; taskId?: string; replies?: true; order?: number }
export const listenerScope = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.scope.json`);
export function recordScope(paths: NodePaths, sessionId: string, scope: ListenerScope): void {
  const file = listenerScope(paths, sessionId);
  if (JSON.stringify(readJson(file)) !== JSON.stringify(scope)) writeJsonAtomic(file, scope);
}

// Whether the session was idle when the listener armed: after Stop, and at a
// SessionStart other than compaction, which can run inside a turn (issue #97).
export const armedIdle = (lock: Pick<ListenerLock, "event" | "source">): boolean =>
  lock.event === "Stop" || (lock.event === "SessionStart" && lock.source !== "compact");

// StopFailure ends the turn without a Stop, so no newer listener takes over:
// the one armed while the turn could run learns that the session is idle.
export function markListenerIdle(paths: NodePaths, sessionId: unknown, now: number): void {
  if (!isPlainSessionId(sessionId)) return;
  const lock = readJson<ListenerLock>(listenerLock(paths, sessionId));
  if (lock && !armedIdle(lock) && lock.idleAt === undefined) {
    writeJsonAtomic(listenerLock(paths, sessionId), { ...lock, idleAt: now });
  }
}

// Whether the process that started this one still runs. POSIX re-parents an
// orphan (process.ppid changes); Windows keeps the old ppid, so the pid is
// probed as well (EPERM: it exists). A pid of 0 or 1 cannot be watched.
export function parentWatch(ppid: number = process.ppid): () => boolean {
  if (ppid <= 1) return () => true;
  return () => {
    if (process.ppid !== ppid) return false;
    try {
      process.kill(ppid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
}
