import type { NodePaths } from "./config.mts";
import type { LivenessSnapshot } from "./session-lifecycle.mts";
import { DISPLAY_TTL_MS, judgeSession, observationReason, targetKey, type Observation, type SessionEvidence, type SessionTarget } from "./session-liveness.mts";
export interface AdmissionAuthority { readonly run: unique symbol }
interface State { dir: string; status: "unproven" | "committed" | "faulted" | "stopped"; generation?: number; receipts: Map<string, number> }
const states = new WeakMap<AdmissionAuthority, State>();
const origins = new WeakMap<object, AdmissionAuthority>();
export function createAdmissionAuthority(paths: NodePaths): AdmissionAuthority {
  const authority = Object.freeze({}) as AdmissionAuthority;
  states.set(authority, { dir: paths.dir, status: "unproven", receipts: new Map() });
  return authority;
}
export interface ObservationSource { observe(targets: SessionTarget[], signal: AbortSignal): Observation<SessionEvidence[]> | Promise<Observation<SessionEvidence[]>> }
export function observeForAuthority(authority: AdmissionAuthority | undefined, source: ObservationSource, targets: SessionTarget[], signal: AbortSignal) {
  const value = source.observe(targets.map(({ runtime, sessionId }) => ({ runtime, sessionId })), signal);
  const remember = (observation: Observation<SessionEvidence[]>) => { if (authority && states.has(authority) && !origins.has(observation)) origins.set(observation, authority); return observation; };
  return value instanceof Promise ? value.then(remember) : remember(value);
}
export const observationBelongs = (authority: AdmissionAuthority | undefined, observation: object | undefined): boolean => !!authority && !!observation && origins.get(observation) === authority
  && ["native-app", "native-holder", "native-turn", "native-lifecycle"].includes((observation as Observation<unknown>).source);
export function revokeAuthority(authority: AdmissionAuthority | undefined): void {
  const state = authority && states.get(authority);
  if (!state) return;
  state.receipts.clear(); state.generation = undefined;
  if (state.status === "committed") state.status = "unproven";
}
export function faultAuthority(authority: AdmissionAuthority | undefined): void {
  revokeAuthority(authority);
  const state = authority && states.get(authority);
  if (state && state.status !== "stopped") state.status = "faulted";
}
export function stopAuthority(authority: AdmissionAuthority): void { revokeAuthority(authority); states.get(authority)!.status = "stopped"; }
export const authorityStatus = (authority: AdmissionAuthority): string => states.get(authority)?.status ?? "unproven";
export function commitAuthority(authority: AdmissionAuthority | undefined, paths: NodePaths,
  observation: Observation<SessionEvidence[]> | undefined, snapshot: LivenessSnapshot, now: number): void {
  const state = authority && states.get(authority);
  if (!state || state.dir !== paths.dir || state.status === "faulted" || state.status === "stopped" || !observation
    || origins.get(observation) !== authority || !["native-app", "native-holder", "native-turn", "native-lifecycle"].includes(observation.source) || observation.status !== "value" || observationReason(observation, now) !== null) return;
  const counts = new Map<string, number>();
  for (const e of observation.value) counts.set(targetKey(e), (counts.get(targetKey(e)) ?? 0) + 1);
  for (const e of observation.value) {
    const key = targetKey(e), verdict = judgeSession(e, now), stored = snapshot.sessions.find(s => targetKey(s) === key);
    const retained = snapshot.tombstones.find(t => targetKey(t) === key);
    if (retained && e.lifecycle?.status === "value" && (e.lifecycle.value.generation !== retained.generation
      || e.lifecycle.value.state !== retained.state || e.lifecycle.observedAt < retained.observedAt)) continue;
    if (counts.get(key) === 1 && stored?.state === verdict.state && ["running", "idle-loaded", "closed"].includes(verdict.state)) {
      state.receipts.set(key, Math.min(verdict.observedAt, observation.observedAt));
    }
  }
  state.status = "committed"; state.generation = snapshot.generation;
}
export function authorityAllows(authority: AdmissionAuthority | undefined, paths: NodePaths, target: SessionTarget, generation: number, now: number): boolean {
  const state = authority && states.get(authority), observedAt = state?.receipts.get(targetKey(target));
  return !!state && state.dir === paths.dir && state.status === "committed" && state.generation === generation
    && observedAt !== undefined && observedAt <= now && now - observedAt <= DISPLAY_TTL_MS;
}
