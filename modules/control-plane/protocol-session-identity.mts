// Enrolled-Node source attestation only, never cryptographic native origin or liveness.
export const CANONICAL_IDENTITY_MAX_AGE_MS = 12 * 60 * 60_000;
export type IdentityRuntime = "claude-code" | "codex";
export interface CanonicalIdentityV1 {
  version: 1; source: "claude-list" | "codex-hook"; runtime: IdentityRuntime;
  sessionId: string; observedAt: number; lifecycleGeneration: number;
}
export interface IdentitySnapshotV1 { version: 1; generation: number }
export type IdentityBinding = [1, IdentityRuntime, number, IdentityRuntime, number];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const identityRuntime = (v: unknown): v is IdentityRuntime => v === "codex" || v === "claude-code";
// Current supported native sources identify full UUIDs. Short names stay display/legacy references.
export const fullSessionId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function isCanonicalIdentity(v: unknown): v is CanonicalIdentityV1 {
  return object(v) && exact(v, ["version", "source", "runtime", "sessionId", "observedAt", "lifecycleGeneration"])
    && v.version === 1 && identityRuntime(v.runtime) && fullSessionId(v.sessionId)
    && (v.runtime === "codex" ? v.source === "codex-hook" : v.source === "claude-list")
    && typeof v.observedAt === "number" && Number.isFinite(v.observedAt) && v.observedAt >= 0 && natural(v.lifecycleGeneration);
}
export function currentIdentity(v: unknown, row: { sessionId: string; runtime: string }, now: number): v is CanonicalIdentityV1 {
  return isCanonicalIdentity(v) && v.sessionId === row.sessionId && v.runtime === row.runtime
    && v.observedAt <= now && now - v.observedAt <= CANONICAL_IDENTITY_MAX_AGE_MS;
}
export function isIdentitySnapshot(v: unknown): v is IdentitySnapshotV1 {
  return object(v) && exact(v, ["version", "generation"]) && v.version === 1 && natural(v.generation) && v.generation > 0;
}
export function parseIdentityBinding(v: unknown): IdentityBinding | null {
  if (typeof v !== "string") return null;
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) && a.length === 5 && a[0] === 1 && identityRuntime(a[1]) && natural(a[2])
      && identityRuntime(a[3]) && natural(a[4]) && JSON.stringify(a) === v ? a as IdentityBinding : null;
  } catch { return null; }
}
