import fs from "node:fs";
import { isPlainSessionId, listenerDir } from "./autonomy.mts";
import { inspectTurnBudget } from "./autonomy-budget.mts";
import type { NodePaths } from "./config.mts";
import { wakeBudget, type NodePolicy } from "./policy.mts";
import { at, readWakeSnapshot, type Clock } from "./wake-snapshot.mts";

const MAX_LEDGERS = 512;
const LEDGER_SUFFIX = ".turns.json";
const ledgerOwner = (name: string): string => name.slice(0, -LEDGER_SUFFIX.length);

// The directory establishes only stored owners, never usage for unlisted
// sessions. Exhaustion is useful evidence even without a session snapshot.
export function checkWakeBudget(paths: NodePaths, policy: NodePolicy | null, now: Clock): { ok: boolean; [key: string]: unknown } {
  const observedAt = new Date(at(now)).toISOString();
  const coverage = { sourceStatus: "unreadable", completeness: "unknown", truncated: false, inspected: 0, unreadable: 0, unsupported: 0,
    countScope: "stored-ledgers-only" };
  if (!policy) return { ok: false, status: "unknown", observedAt, limits: "unknown", coverage, sessions: [],
    detail: "budget limits are unknown because policy is unreadable" };
  const limits = wakeBudget(policy);
  const disabled = policy.wake === undefined;
  let all: string[];
  try {
    all = fs.readdirSync(listenerDir(paths)).filter(name => name.endsWith(LEDGER_SUFFIX)).sort();
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: missing, status: disabled ? "disabled" : "unknown", observedAt, limits,
      coverage: { ...coverage, sourceStatus: missing ? "not-initialized" : "unreadable", completeness: missing ? "complete" : "unknown" },
      sessions: [], detail: missing ? "no stored budget ledgers have been initialized" : "stored budget owners could not be enumerated" };
  }
  // A name the filename guard excludes is reported as uncovered and never opened.
  const names = all.filter(name => isPlainSessionId(ledgerOwner(name)));
  coverage.unsupported = all.length - names.length;
  coverage.truncated = names.length > MAX_LEDGERS;
  coverage.sourceStatus = coverage.truncated ? "partial" : all.length ? "ok" : "empty";
  coverage.completeness = coverage.truncated || coverage.unsupported ? "partial" : "complete";
  const { sessions: listed } = readWakeSnapshot(paths, now);
  const sessions = names.slice(0, MAX_LEDGERS).map(name => {
    const sessionId = ledgerOwner(name);
    const rows = listed.filter(s => s.sessionId === sessionId);
    const runtimes = new Set(rows.map(s => s.runtime));
    const inspection = inspectTurnBudget(paths, sessionId, now, limits);
    coverage.inspected++;
    if (inspection.ledgerStatus !== "ok") coverage.unreadable++;
    return { sessionId, runtime: runtimes.size === 1 ? rows[0].runtime : "unknown", ...inspection };
  });
  if (coverage.unreadable) coverage.completeness = "partial";
  // A spacing hold stays on the owner's row; only a full window blocks the budget as a whole.
  const exhausted = sessions.some(s => s.blockedBy.includes("hour") || s.blockedBy.includes("day"));
  const failed = coverage.unreadable > 0;
  const status = disabled ? "disabled" : exhausted ? "blocked"
    : failed || coverage.truncated || coverage.unsupported ? "partial" : sessions.length ? "available" : "unknown";
  return { ok: !failed, status, observedAt, limits, coverage, sessions,
    detail: "read-only stored-ledger evidence; nextAvailableAt assumes no additional autonomous turns and does not prove a message hold" };
}
