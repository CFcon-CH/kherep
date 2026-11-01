import { observeForAuthority, type AdmissionAuthority } from "./session-authority.mts";
import type { NodePaths } from "./config.mts";
import { publishLiveness, type LivenessSnapshot } from "./session-lifecycle.mts";
import { observationReason, targetKey, type Observation, type SessionEvidence, type SessionTarget } from "./session-liveness.mts";
export const LIVENESS_INTERVAL_MS = 5 * 60_000;
export interface LivenessSource { observe(targets: SessionTarget[], signal: AbortSignal): Observation<SessionEvidence[]> | Promise<Observation<SessionEvidence[]>> }
export const unsupportedLiveness: LivenessSource = { observe: async () => ({ status: "unknown", observedAt: 0,
  complete: false, source: "unsupported", reasonCode: "unsupported" }) };
// Called from the existing daemon discovery/serialized publication lanes.
// No timer and no independent filesystem writer.
export function createLivenessPass(source: LivenessSource = unsupportedLiveness, now: () => number = Date.now, authority?: AdmissionAuthority) {
  let pending: Promise<Observation<SessionEvidence[]>> | null = null;
  let lastStarted = -Infinity;
  let cached: Observation<SessionEvidence[]> | null = null;
  const halt = new AbortController();
  const observe = (targets: SessionTarget[], signal?: AbortSignal): Promise<Observation<SessionEvidence[]>> => {
    signal?.throwIfAborted();
    halt.signal.throwIfAborted();
    if (pending) return pending;
    if (cached && now() - lastStarted < LIVENESS_INTERVAL_MS) return Promise.resolve(cached);
    lastStarted = now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    halt.signal.addEventListener("abort", abort, { once: true });
    pending = Promise.resolve(observeForAuthority(authority, source, targets, controller.signal)).then(value => {
      controller.signal.throwIfAborted();
      cached = value;
      return value;
    }).catch(() => {
      cached = { status: "unknown", observedAt: lastStarted, complete: false, source: "unsupported",
        reasonCode: controller.signal.aborted ? "aborted" : "failed" };
      return cached;
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      halt.signal.removeEventListener("abort", abort);
      pending = null;
    });
    return pending;
  };
  return { observe,
    publish(paths: NodePaths, targets: SessionTarget[], observation: Observation<SessionEvidence[]>): LivenessSnapshot {
      halt.signal.throwIfAborted();
      // Partial populations cannot prove absence; each target retains an UNKNOWN.
      const given = observation.status === "value" && observationReason(observation, now()) === null ? observation.value : [];
      const byId = new Map(given.map(e => [targetKey(e), e]));
      return publishLiveness(paths, targets.map(t => byId.get(targetKey(t)) ?? { ...t,
        app: { status: "unknown", observedAt: observation.observedAt, complete: false,
          source: observation.source, reasonCode: observation.status === "unknown" ? observation.reasonCode : "incomplete" } }), now());
    },
    async stop(): Promise<void> { halt.abort(); await pending; },
  };
}

// The observation travels with its exact listing, outside the wire protocol.
const observations = new WeakMap<object, Observation<SessionEvidence[]>>();
export function attachLiveness<T extends object>(listing: T, observation: Observation<SessionEvidence[]>): T {
  observations.set(listing, observation);
  return listing;
}
export const listingObservation = (listing: object): Observation<SessionEvidence[]> | undefined => observations.get(listing);
