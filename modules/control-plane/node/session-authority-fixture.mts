// Generated metadata only. No native adapter, process or user-state access.
import type { SessionInfo } from "../protocol.mts";
import type { NodePaths } from "./config.mts";
import { createAdmissionAuthority, observeForAuthority, commitAuthority, revokeAuthority, type AdmissionAuthority } from "./session-authority.mts";
import { attachLiveness } from "./liveness-pass.mts";
import { publishLiveness } from "./session-lifecycle.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import type { SessionEvidence, Observation } from "./session-liveness.mts";
// Explicit generated source facts. A legacy task/hook row is never evidence.
export function fixtureEvidence(target: { runtime: string; sessionId: string }, state: "running" | "idle-loaded" | "closed" | "unknown", now: number): SessionEvidence {
  if (state === "unknown") return { ...target };
  const common = { status: "value" as const, observedAt: now, complete: true, reasonCode: "observed" as const };
  if (state === "closed") return { ...target,
    holder: { ...common, source: "native-holder", value: { present: false } },
    app: { ...common, source: "native-app", value: "absent" } };
  return { ...target, holder: { ...common, source: "native-holder", value: { present: true, creationIdentity: "synthetic-holder" } },
    turn: { ...common, source: "native-turn", value: state === "running" ? "running" : "idle" },
    ...(state === "idle-loaded" ? { loaded: { ...common, source: "native-app" as const, value: true } } : {}) };
}
export function syntheticListing<T extends object>(authority: AdmissionAuthority, rows: T, evidence: SessionEvidence[], now: number): T {
  const observation = observeForAuthority(authority, { observe: () => ({ status: "value", value: evidence, observedAt: now,
    source: "native-app", complete: true, reasonCode: "observed" }) }, evidence, new AbortController().signal) as Observation<SessionEvidence[]>;
  return attachLiveness(rows, observation);
}
export function publishSynthetic(paths: NodePaths, evidence: SessionEvidence[], now: number,
  rows: SessionInfo[], authority = createAdmissionAuthority(paths)): AdmissionAuthority {
  // Use the same source provenance, lifecycle writer and coherent marker writer
  // as production; no disk-only grant or implicit context is available.
  const observation = observeForAuthority(authority, { observe: () => ({ status: "value", value: evidence, observedAt: now,
    source: "native-app", complete: true, reasonCode: "observed" }) }, evidence, new AbortController().signal) as Observation<SessionEvidence[]>;
  revokeAuthority(authority);
  const snapshot = publishLiveness(paths, evidence, now, rows);
  writeLocalSessions(paths, rows, now, snapshot.generation);
  commitAuthority(authority, paths, observation, snapshot, now);
  return authority;
}
