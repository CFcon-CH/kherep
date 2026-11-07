import fs from "node:fs";
import path from "node:path";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { classifyExclusiveCreate, pauseSync } from "./lock-contention.mts";
import { DEFAULT_TURN_BUDGET, type TurnBudget } from "./policy.mts";
import { isPlainSessionId, listenerDir } from "./autonomy.mts";
import { at, type Clock } from "./wake-snapshot.mts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const turnsFile = (paths: NodePaths, sessionId: string): string => path.join(listenerDir(paths), `${sessionId}.turns.json`);

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

export type LedgerStatus = "ok" | "missing" | "unreadable" | "malformed" | "nonfinite" | "future" | "too-large" | "unsupported-identity";
export interface BudgetInspection {
  ledgerStatus: LedgerStatus;
  usedHour: number | "unknown";
  usedDay: number | "unknown";
  remainingHour: number | "unknown";
  remainingDay: number | "unknown";
  state: "available" | "blocked" | "unknown";
  blockedBy: Array<"hour" | "day" | "spacing">;
  nextAvailableAt: string | null;
  observedAt: string;
}
const unknownBudget = (ledgerStatus: LedgerStatus, now: number): BudgetInspection => ({
  ledgerStatus, usedHour: "unknown", usedDay: "unknown", remainingHour: "unknown", remainingDay: "unknown",
  state: "unknown", blockedBy: [], nextAvailableAt: null, observedAt: new Date(now).toISOString(),
});

// Diagnostic validation is intentionally separate from the compatible charging
// path above. A bad ledger must never become a successful zero-usage diagnosis.
export function evaluateTurnBudget(turns: unknown, limits: TurnBudget, now: number): BudgetInspection {
  if (!Array.isArray(turns) || turns.some(t => typeof t !== "number")) return unknownBudget("malformed", now);
  if (turns.some(t => !Number.isFinite(t))) return unknownBudget("nonfinite", now);
  if (turns.some(t => t < 0)) return unknownBudget("malformed", now);
  if (turns.some(t => t > now)) return unknownBudget("future", now);
  const active = (turns as number[]).filter(t => now - t < DAY_MS).sort((a, b) => a - b);
  const hourly = active.filter(t => now - t < HOUR_MS);
  const blockedBy: BudgetInspection["blockedBy"] = [];
  let release = now;
  if (hourly.length >= limits.perHour) {
    blockedBy.push("hour");
    release = Math.max(release, hourly[hourly.length - limits.perHour] + HOUR_MS);
  }
  if (active.length >= limits.perDay) {
    blockedBy.push("day");
    release = Math.max(release, active[active.length - limits.perDay] + DAY_MS);
  }
  if (active.some(t => now - t < limits.spacingMs)) {
    blockedBy.push("spacing");
    release = Math.max(release, active[active.length - 1] + limits.spacingMs);
  }
  return { ledgerStatus: "ok", usedHour: hourly.length, usedDay: active.length,
    remainingHour: Math.max(0, limits.perHour - hourly.length), remainingDay: Math.max(0, limits.perDay - active.length),
    state: blockedBy.length ? "blocked" : "available", blockedBy,
    nextAvailableAt: new Date(release).toISOString(), observedAt: new Date(now).toISOString() };
}

export const MAX_LEDGER_BYTES = 256 * 1024;
// No lock, directory creation, charging, trimming or repair is permitted here.
export function inspectTurnBudget(paths: NodePaths, sessionId: string, now: Clock,
  limits: TurnBudget = DEFAULT_TURN_BUDGET): BudgetInspection {
  if (!isPlainSessionId(sessionId)) return unknownBudget("unsupported-identity", at(now));
  let fd: number | undefined;
  let text: string;
  try {
    fd = fs.openSync(turnsFile(paths, sessionId), "r");
    const buffer = Buffer.alloc(MAX_LEDGER_BYTES + 1);
    let size = 0, read: number;
    do { read = fs.readSync(fd, buffer, size, buffer.length - size, null); size += read; } while (read > 0 && size < buffer.length);
    if (size > MAX_LEDGER_BYTES) return unknownBudget("too-large", at(now));
    text = buffer.subarray(0, size).toString("utf8");
  } catch (error) {
    return unknownBudget((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", at(now));
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const observed = at(now);
  let value: { turns?: unknown } | null;
  try { value = JSON.parse(text); } catch { return unknownBudget("malformed", observed); }
  return evaluateTurnBudget(value?.turns, limits, observed);
}

export type BudgetHold = { kind: "exhausted"; retryAt: number } | { kind: "available" } | { kind: "unknown"; ledgerStatus: LedgerStatus };
// Read-only. "missing" is a ledger without stamps, which takeTurn would grant.
// Spacing is not a hold: the listener retries at its next poll.
export function inspectBudgetHold(paths: NodePaths, sessionId: string, now: number, limits: TurnBudget = DEFAULT_TURN_BUDGET): BudgetHold {
  const budget = inspectTurnBudget(paths, sessionId, now, limits);
  if (budget.ledgerStatus === "missing") return { kind: "available" };
  if (budget.ledgerStatus !== "ok") return { kind: "unknown", ledgerStatus: budget.ledgerStatus };
  return budget.blockedBy.includes("hour") || budget.blockedBy.includes("day")
    ? { kind: "exhausted", retryAt: Date.parse(budget.nextAvailableAt!) } : { kind: "available" };
}

