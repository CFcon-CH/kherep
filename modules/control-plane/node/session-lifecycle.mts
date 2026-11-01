import path from "node:path";
import { authorityAllows, type AdmissionAuthority } from "./session-authority.mts";
import fs from "node:fs";
import type { NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { autonomousEligibility, DISPLAY_TTL_MS, judgeSession, observationReason, targetKey, validIdentity,
  type AutonomousRoute, type LifecycleEvent, type SessionEvidence, type SessionTarget, type SessionVerdict } from "./session-liveness.mts";

interface Tombstone extends SessionTarget { state: LifecycleEvent["state"]; generation: number; observedAt: number }
export interface LivenessSnapshot { version: 1; generation: number; sessions: SessionVerdict[]; tombstones: Tombstone[]; capped?: true }
const LIMIT = 512;
export const livenessFile = (paths: NodePaths): string => path.join(paths.dir, "session-liveness.json");
const states = new Set(["running", "idle-loaded", "reachable-probable", "closed", "archived", "deleted", "unknown"]);
const reasons = new Set(["observed", "unsupported", "missing", "malformed", "future", "stale", "capped", "aborted", "failed", "incomplete", "conflict", "identity"]);
const keysOnly = (value: object, keys: string[]): boolean => Object.keys(value).every(k => keys.includes(k));
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const generation = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
export function readLivenessSnapshot(paths: NodePaths): LivenessSnapshot | null {
  try {
    const stat = fs.lstatSync(livenessFile(paths));
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    const value = readJson<LivenessSnapshot>(livenessFile(paths));
    if (!value || !keysOnly(value, ["version", "generation", "sessions", "tombstones", "capped"]) || value.version !== 1 || value.capped !== undefined && value.capped !== true || !generation(value.generation)
      || !Array.isArray(value.sessions) || !Array.isArray(value.tombstones) || value.sessions.length > LIMIT || value.tombstones.length > LIMIT) return null;
    if (!value.sessions.every(v => object(v) && validIdentity(v as unknown as SessionTarget) && states.has(v.state as string)
      && reasons.has(v.reasonCode as string) && Number.isFinite(v.observedAt) && (v.lifecycleGeneration === undefined || generation(v.lifecycleGeneration))
      && keysOnly(v, ["runtime", "sessionId", "state", "observedAt", "reasonCode", "lifecycleGeneration"]))) return null;
    if (!value.tombstones.every(v => object(v) && validIdentity(v as unknown as SessionTarget) && ["archived", "deleted", "restored"].includes(v.state as string)
      && generation(v.generation) && Number.isFinite(v.observedAt) && keysOnly(v, ["runtime", "sessionId", "state", "generation", "observedAt"]))) return null;
    if (new Set(value.sessions.map(targetKey)).size !== value.sessions.length || new Set(value.tombstones.map(targetKey)).size !== value.tombstones.length) return null;
    if (value.tombstones.some(t => t.state !== "restored" && value.sessions.some(s => targetKey(s) === targetKey(t)
      && (s.lifecycleGeneration !== t.generation || s.state !== t.state && s.state !== "unknown")))) return null;
    if (value.sessions.some(s => (s.state === "archived" || s.state === "deleted") && !value.tombstones.some(t => targetKey(t) === targetKey(s)
      && t.state === s.state && t.generation === s.lifecycleGeneration && t.observedAt === s.observedAt))) return null;
    return value;
  } catch { return null; }
}
export function publishLiveness(paths: NodePaths, evidence: SessionEvidence[], now: number, current: SessionTarget[] = evidence): LivenessSnapshot {
  const previous = readLivenessSnapshot(paths);
  if (!previous && fs.existsSync(livenessFile(paths))) throw new Error("invalid liveness cache");
  let capped = false;
  const tombstones = new Map(previous?.tombstones.map(v => [targetKey(v), v]));
  const sessions = new Map<string, SessionVerdict>(previous?.sessions.map(v => [targetKey(v), { ...v, state: "unknown" as const, reasonCode: "missing" as const }]));
  const counts = new Map<string, number>();
  for (const e of evidence) counts.set(targetKey(e), (counts.get(targetKey(e)) ?? 0) + 1);
  for (const e of evidence) {
    if (!validIdentity(e)) continue;
    const key = targetKey(e);
    if (counts.get(key)! > 1) {
      sessions.set(key, { runtime: e.runtime, sessionId: e.sessionId, state: "unknown", reasonCode: "identity", observedAt: now,
        ...(tombstones.get(key) ? { lifecycleGeneration: tombstones.get(key)!.generation } : {}) });
      continue;
    }
    const event = e.lifecycle;
    const old = tombstones.get(key);
    const validEvent = event?.status === "value" && event.source === "native-lifecycle" && observationReason(event, now) === null
      && generation(event.value.generation) && ["archived", "deleted", "restored"].includes(event.value.state);
    const advances = validEvent && (!old || event.value.generation > old.generation && event.observedAt >= old.observedAt);
    const repeats = validEvent && old && event.value.generation === old.generation && event.value.state === old.state && event.observedAt >= old.observedAt;
    const rejected = validEvent && old && !advances && !repeats;
    const contradictory = rejected && event.value.generation >= old.generation;
    if (advances) {
      if (old || tombstones.size < LIMIT) tombstones.set(key, { runtime: e.runtime, sessionId: e.sessionId, state: event.value.state, generation: event.value.generation, observedAt: event.observedAt });
      else capped = true;
    }
    let verdict = judgeSession(rejected ? { ...e, lifecycle: undefined } : e, now);
    if (contradictory) verdict = { runtime: e.runtime, sessionId: e.sessionId, state: "unknown", reasonCode: "conflict",
      observedAt: event.observedAt, lifecycleGeneration: old.generation };
    const terminal = tombstones.get(key);
    if (terminal && terminal.state !== "restored" && !contradictory) {
      const holder = e.holder;
      const conflict = holder?.status === "value" && holder.source === "native-holder" && holder.value.present
        && !!holder.value.creationIdentity && observationReason(holder, now) === null && holder.observedAt >= terminal.observedAt;
      verdict = { runtime: e.runtime, sessionId: e.sessionId, state: conflict ? "unknown" : terminal.state,
        observedAt: terminal.observedAt, lifecycleGeneration: terminal.generation, reasonCode: conflict ? "conflict" : "observed" };
    }
    sessions.set(key, verdict);
  }
  // Positive lifecycle identity survives a failed/empty/capped observation.
  for (const [key, v] of tombstones) if (v.state !== "restored" && !evidence.some(e => targetKey(e) === key)) {
    sessions.set(key, { runtime: v.runtime, sessionId: v.sessionId, state: v.state, observedAt: v.observedAt,
      lifecycleGeneration: v.generation, reasonCode: "observed" });
  }
  const currentKeys = new Set(current.map(targetKey));
  const retained = [...sessions.values()].filter(s => currentKeys.has(targetKey(s)) || !["archived", "deleted"].includes(s.state))
    .sort((a, b) => Number(currentKeys.has(targetKey(b))) - Number(currentKeys.has(targetKey(a)))
      || b.observedAt - a.observedAt || targetKey(a).localeCompare(targetKey(b)));
  if (retained.length > LIMIT) capped = true;
  const bounded = retained.slice(0, LIMIT).map(s => tombstones.size === LIMIT && !tombstones.has(targetKey(s))
    ? { ...s, state: "unknown" as const, reasonCode: "capped" as const } : s);
  const snapshot: LivenessSnapshot = { version: 1, generation: (previous?.generation ?? 0) + 1,
    sessions: bounded, tombstones: [...tombstones.values()], ...(capped || tombstones.size === LIMIT ? { capped: true } : {}) };
  fs.mkdirSync(paths.dir, { recursive: true });
  writeJsonAtomic(livenessFile(paths), snapshot);
  return snapshot;
}
function verdictFrom(snapshot: LivenessSnapshot | null, target: SessionTarget, now: number): SessionVerdict {
  const record = snapshot?.tombstones.find(v => targetKey(v) === targetKey(target));
  if (snapshot?.tombstones.length === LIMIT && !record) return { ...target, state: "unknown", observedAt: now, reasonCode: "capped" };
  const v = snapshot?.sessions.find(v => targetKey(v) === targetKey(target)) ?? (record && record.state !== "restored"
    ? { ...target, state: record.state, observedAt: record.observedAt, reasonCode: "observed" as const, lifecycleGeneration: record.generation } : undefined);
  if (!v) return { ...target, state: "unknown", observedAt: now, reasonCode: "missing" };
  if (v.observedAt > now) return { ...v, state: "unknown", reasonCode: "future" };
  if (v.state === "archived" || v.state === "deleted") return v;
  return now - v.observedAt > DISPLAY_TTL_MS ? { ...v, state: "unknown", reasonCode: "stale" } : v;
}
export function sessionVerdict(paths: NodePaths, target: SessionTarget, now: number): SessionVerdict {
  return verdictFrom(readLivenessSnapshot(paths), target, now);
}
// The directory file is the commit marker of the existing serialized publisher.
// A failed second write leaves different generations and therefore no admission.
function publicationMatches(paths: NodePaths, snapshot: LivenessSnapshot): boolean {
  try {
    const local = readJson<{ generation?: unknown; sessions?: unknown }>(paths.sessions);
    return local?.generation === snapshot.generation && Array.isArray(local.sessions);
  } catch { return false; }
}
// Closed fallback has its own veto, separate from queue/idle eligibility.
// The caller must still enforce every baseline listing/miss/policy guard.
export function closedFallbackGeneration(paths: NodePaths, target: SessionTarget, now: number, expected?: number, authority?: AdmissionAuthority): number | null {
  const snapshot = readLivenessSnapshot(paths);
  if (!snapshot || !authorityAllows(authority, paths, target, snapshot.generation, now) || !publicationMatches(paths, snapshot) || expected !== undefined && expected !== snapshot.generation) return null;
  return verdictFrom(snapshot, target, now).state === "closed" ? snapshot.generation : null;
}
// A second read at the existing final admission seam detects any publication
// during an await. This is only a veto; policy/attempt/permission guards remain.
export function livenessAdmission(paths: NodePaths, target: SessionTarget, route: AutonomousRoute, now: number, expectedGeneration?: number, authority?: AdmissionAuthority): number | null {
  const snapshot = readLivenessSnapshot(paths);
  if (!snapshot || !authorityAllows(authority, paths, target, snapshot.generation, now) || !publicationMatches(paths, snapshot) || expectedGeneration !== undefined && snapshot.generation !== expectedGeneration) return null;
  const verdict = verdictFrom(snapshot, target, now);
  const local = readJson<{ sessions: SessionVerdict[] }>(paths.sessions);
  if (!local?.sessions.some(s => targetKey(s) === targetKey(target) && s.state === verdict.state)) return null;
  return autonomousEligibility(verdict, route) ? snapshot.generation : null;
}
export function terminalReference(paths: NodePaths, ref: string, runtime?: string, now = Date.now()): boolean {
  const snapshot = readLivenessSnapshot(paths);
  const matches = [...new Map([...(snapshot?.sessions ?? []), ...(snapshot?.tombstones ?? [])].filter(s => s.sessionId === ref && (runtime === undefined || s.runtime === runtime)).map(s => [targetKey(s), s])).values()];
  return !!snapshot && publicationMatches(paths, snapshot) && matches.length === 1 && ["archived", "deleted"].includes(verdictFrom(snapshot, matches[0], now).state);
}

export function closedReference(paths: NodePaths, ref: string, now: number, authority?: AdmissionAuthority): boolean {
  const snapshot = readLivenessSnapshot(paths);
  const matches = snapshot?.sessions.filter(s => s.sessionId === ref) ?? [];
  return !!snapshot && publicationMatches(paths, snapshot) && matches.length === 1 && authorityAllows(authority, paths, matches[0], snapshot.generation, now) && verdictFrom(snapshot, matches[0], now).state === "closed";
}
