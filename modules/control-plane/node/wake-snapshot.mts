import fs from "node:fs";
import type { NodePaths } from "./config.mts";
import { validIdentity } from "./session-liveness.mts";

// Two listing intervals allow one delayed round without treating old state as idle.
export const SESSION_SNAPSHOT_FRESH_MS = 120_000;
// A function is sampled after the file it judges is read. Every writer stamps its
// time before an atomic rename, so a file that was read cannot be newer than that
// sample; what still looks future-dated is a real clock disagreement.
export type Clock = number | (() => number);
export const at = (clock: Clock): number => typeof clock === "function" ? clock() : clock;
export interface WakeSession { sessionId: string; runtime: string; state: string; name?: string }
type Reason = "observed" | "missing" | "io-error" | "invalid-json" | "invalid-envelope" | "missing-timestamp" | "future-timestamp" | "stale";
export interface WakeSnapshot {
  status: "fresh" | "missing" | "unreadable" | "stale";
  reasonCode: Reason;
  updatedAt?: string;
  ageSeconds?: number;
  completeness: "complete" | "partial" | "unknown";
  rejectedRows: number | "unknown";
  incompleteRows: number | "unknown";
  unseenRuntimes: string[] | "unknown";
  truncated: boolean | "unknown";
  countScope: "observed-valid-rows";
}
export const snapshotObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function unknown(status: WakeSnapshot["status"], reasonCode: Reason, extra = {}): { snapshot: WakeSnapshot; sessions: WakeSession[] } {
  return { snapshot: { status, reasonCode, completeness: "unknown", rejectedRows: "unknown", incompleteRows: "unknown",
    unseenRuntimes: "unknown", truncated: "unknown", countScope: "observed-valid-rows", ...extra }, sessions: [] };
}

// Identity validation here is for display only. File consumers must separately
// require isPlainSessionId before deriving listener or budget filenames.
export function readWakeSnapshot(paths: NodePaths, now: Clock,
  deps: { read?: (file: string) => string } = {}): { snapshot: WakeSnapshot; sessions: WakeSession[] } {
  let text: string;
  try { text = deps.read ? deps.read(paths.sessions) : fs.readFileSync(paths.sessions, "utf8"); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? unknown("missing", "missing") : unknown("unreadable", "io-error");
  }
  const observed = at(now);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return unknown("unreadable", "invalid-json"); }
  if (!snapshotObject(value) || !Array.isArray(value.sessions) || (value.unseen !== undefined && (!Array.isArray(value.unseen)
      || value.unseen.length > 8 || !value.unseen.every(r => typeof r === "string" && r.length > 0 && r.length <= 64)))) {
    return unknown("unreadable", "invalid-envelope");
  }
  // A resume into a home without a listing writes rows only; no listing is implied.
  if (value.updatedAt === undefined) return unknown("unreadable", "missing-timestamp");
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) return unknown("unreadable", "invalid-envelope");
  const age = observed - Date.parse(value.updatedAt);
  if (!Number.isFinite(age) || age < 0) return unknown("unreadable", "future-timestamp");
  const time = { updatedAt: value.updatedAt, ageSeconds: Math.floor(age / 1000) };
  if (age > SESSION_SNAPSHOT_FRESH_MS) return unknown("stale", "stale", time);
  const unseenRuntimes = value.unseen as string[] | undefined;
  const truncated: boolean | "unknown" = value.sessions.length > 512 ? true
    : unseenRuntimes === undefined ? "unknown" : unseenRuntimes.includes("*");
  const sessions: WakeSession[] = [];
  let rejectedRows = 0, incompleteRows = 0;
  for (const row of value.sessions.slice(0, 512)) {
    if (!snapshotObject(row) || typeof row.sessionId !== "string"
      || !validIdentity({ sessionId: row.sessionId, runtime: "unknown" })
      || (row.name !== undefined && (typeof row.name !== "string" || row.name.length === 0 || row.name.length > 128))) {
      rejectedRows++; continue;
    }
    if (row.runtime === undefined || row.state === undefined) { incompleteRows++; continue; }
    if (typeof row.runtime !== "string" || !validIdentity({ sessionId: row.sessionId, runtime: row.runtime })
      || typeof row.state !== "string" || !/^[a-z][a-z-]{0,63}$/.test(row.state)) { rejectedRows++; continue; }
    sessions.push({ sessionId: row.sessionId, runtime: row.runtime, state: row.state,
      ...(typeof row.name === "string" ? { name: row.name } : {}) });
  }
  const partial = rejectedRows > 0 || incompleteRows > 0 || truncated === true || (unseenRuntimes?.length ?? 0) > 0;
  return { sessions, snapshot: { status: "fresh", reasonCode: "observed", ...time,
    completeness: partial ? "partial" : unseenRuntimes === undefined ? "unknown" : "complete",
    rejectedRows, incompleteRows, unseenRuntimes: unseenRuntimes ?? "unknown", truncated, countScope: "observed-valid-rows" } };
}
