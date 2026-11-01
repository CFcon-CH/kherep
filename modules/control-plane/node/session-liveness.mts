// Metadata only. Native adapters must establish exact identity and coverage;
// a hook or PID alone never establishes a loaded application.
export type LivenessState = "running" | "idle-loaded" | "reachable-probable" | "closed" | "archived" | "deleted" | "unknown";
export type EvidenceSource = "native-lifecycle" | "native-holder" | "native-app" | "native-turn" | "hook" | "task" | "unsupported";
export type ReasonCode = "observed" | "unsupported" | "missing" | "malformed" | "future" | "stale" | "capped" | "aborted" | "failed" | "incomplete" | "conflict" | "identity";
export type Observation<T> = { status: "value"; value: T; observedAt: number; complete: boolean; source: EvidenceSource; reasonCode: ReasonCode }
  | { status: "unknown"; observedAt: number; complete: false; source: EvidenceSource; reasonCode: ReasonCode };
export interface SessionTarget { runtime: string; sessionId: string }
export interface LifecycleEvent { state: "archived" | "deleted" | "restored"; generation: number }
export interface SessionEvidence extends SessionTarget {
  lifecycle?: Observation<LifecycleEvent>;
  app?: Observation<"present" | "absent">;
  holder?: Observation<{ present: boolean; creationIdentity?: string }>;
  loaded?: Observation<boolean>;
  turn?: Observation<"running" | "idle" | "approval-waiting">;
  hook?: Observation<boolean>;
}
export interface SessionVerdict extends SessionTarget {
  state: LivenessState; observedAt: number; reasonCode: ReasonCode; lifecycleGeneration?: number;
}
export const DISPLAY_TTL_MS = 60_000;
export const validIdentity = (target: SessionTarget): boolean => typeof target.runtime === "string"
  && /^[a-z][a-z0-9-]{0,31}$/.test(target.runtime) && typeof target.sessionId === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.sessionId);
export const targetKey = (target: SessionTarget): string => `${target.runtime}/${target.sessionId}`;
const sources = new Set(["native-lifecycle", "native-holder", "native-app", "native-turn", "hook", "task", "unsupported"]);
const reasons = new Set(["observed", "unsupported", "missing", "malformed", "future", "stale", "capped", "aborted", "failed", "incomplete", "conflict", "identity"]);
export function observationReason<T>(observation: Observation<T> | undefined, now: number): ReasonCode | null {
  if (!observation) return "missing";
  if (!sources.has(observation.source) || !reasons.has(observation.reasonCode) || !Number.isFinite(observation.observedAt) || observation.observedAt < 0) return "malformed";
  if (observation.observedAt > now) return "future";
  if (now - observation.observedAt > DISPLAY_TTL_MS) return "stale";
  if (observation.status !== "value") return observation.reasonCode;
  if (!observation.complete) return observation.reasonCode === "capped" ? "capped" : "incomplete";
  return null;
}
export function judgeSession(e: SessionEvidence, now: number): SessionVerdict {
  const result = (state: LivenessState, reasonCode: ReasonCode, observations: (Observation<unknown> | undefined)[] = [], generation?: number): SessionVerdict => ({
    runtime: e.runtime, sessionId: e.sessionId, state, reasonCode,
    // Republishing never moves the underlying evidence time forward.
    observedAt: Math.min(...observations.filter((o) => o !== undefined && Number.isFinite(o.observedAt) && o.observedAt <= now).map(o => o!.observedAt), now),
    ...(generation === undefined ? {} : { lifecycleGeneration: generation }),
  });
  if (!validIdentity(e)) return result("unknown", "identity");
  const valid = <T,>(o: Observation<T> | undefined): o is Extract<Observation<T>, { status: "value" }> => observationReason(o, now) === null;
  const exact = valid(e.holder) && e.holder.source === "native-holder"
    && e.holder.value !== null && typeof e.holder.value === "object" && typeof e.holder.value.present === "boolean"
    && (!e.holder.value.present || typeof e.holder.value.creationIdentity === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(e.holder.value.creationIdentity));
  const held = exact && e.holder?.status === "value" && e.holder.value.present;
  if (valid(e.lifecycle) && e.lifecycle.source === "native-lifecycle") {
    const { state, generation } = e.lifecycle.value;
    if (!Number.isSafeInteger(generation) || generation < 1) return result("unknown", "malformed");
    if (state === "archived" || state === "deleted") {
      if (held && e.holder!.observedAt >= e.lifecycle.observedAt) return result("unknown", "conflict", [e.lifecycle, e.holder], generation);
      return result(state, "observed", [e.lifecycle], generation);
    }
  }
  if (held) {
    if (valid(e.turn) && e.turn.source === "native-turn" && e.turn.value === "running") return result("running", "observed", [e.holder, e.turn]);
    if (valid(e.turn) && e.turn.source === "native-turn" && e.turn.value === "idle" && valid(e.loaded)
      && e.loaded.source === "native-app" && e.loaded.value) return result("idle-loaded", "observed", [e.holder, e.turn, e.loaded]);
    return result("reachable-probable", "observed", [e.holder]);
  }
  if (exact && valid(e.app) && e.app.source === "native-app" && e.app.value === "absent") return result("closed", "observed", [e.holder, e.app]);
  if (valid(e.hook) && e.hook.source === "hook" && e.hook.value) return result("reachable-probable", "observed", [e.hook]);
  const reason = [e.holder, e.app, e.hook].filter(o => o !== undefined).map(o => observationReason<unknown>(o, now)).find(r => r !== null);
  return result("unknown", reason ?? "unsupported");
}
export const directoryVisibility = (v: SessionVerdict): boolean => v.state !== "archived" && v.state !== "deleted";
export type AutonomousRoute = "queue" | "wake" | "closed-fallback" | "target-resume";
export function autonomousEligibility(v: SessionVerdict, route: AutonomousRoute): boolean {
  if (route === "closed-fallback") return false; // Uses its separate positive-closure veto.
  if (route === "queue") return v.state === "running" || v.state === "idle-loaded";
  return v.state === "idle-loaded";
}
export function normalizedState(state: string, provenance?: { runtime: string; kind?: string }): LivenessState {
  // An old task's "idle" means its run ended, not that an app/thread is loaded.
  if (state === "idle" && provenance?.runtime === "codex"
    && (provenance.kind === "codex-task" || provenance.kind === "codex-intercom")) return "unknown";
  if (state === "busy" || state === "running") return "running";
  if (state === "idle" || state === "idle-loaded") return "idle-loaded";
  if (state === "waiting" || state === "active" || state === "reachable-probable") return "reachable-probable";
  if (state === "closed" || state === "archived" || state === "deleted") return state;
  return "unknown";
}
