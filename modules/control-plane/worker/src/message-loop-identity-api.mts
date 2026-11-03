import { isNodeId } from "../../protocol.mts";
import { isSessionRef } from "../../protocol-messages.mts";
import { fullSessionId, identityRuntime, type IdentityRuntime } from "../../protocol-session-identity.mts";
import { MESSAGING_LOOP_BRAKE_CAPABILITY } from "../../protocol-loop-brake.mts";
import { registryStub, sessionStub, type Env } from "./env.mts";
import { health } from "./health.mts";
import { json, readJsonObject } from "./http.mts";
export interface IdentitySelector { ref: string; expectedSessionId: string; expectedRuntime: IdentityRuntime }
export interface SelectedPair { nodeId: string; selectors: [IdentitySelector, IdentitySelector] }
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function isSelectedPair(v: unknown): v is SelectedPair {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  return exact(b, ["nodeId", "selectors"]) && isNodeId(b.nodeId) && Array.isArray(b.selectors) && b.selectors.length === 2
    && b.selectors.every(s => !!s && typeof s === "object" && !Array.isArray(s) && exact(s, ["ref", "expectedSessionId", "expectedRuntime"])
      && isSessionRef(s.ref) && !/[?*]/.test(s.ref) && fullSessionId(s.expectedSessionId) && identityRuntime(s.expectedRuntime));
}
export const loopCapability = (caps: string[]): boolean => caps.includes(MESSAGING_LOOP_BRAKE_CAPABILITY);
export interface ConnectionEvidence { token: string | null; registered: boolean; capability: boolean }
export interface SelectedIdentityEvidence {
  stamp: string; registrationToken: string | null; registryCapability: boolean;
  endpointA: EndpointEvidence; endpointB: EndpointEvidence; samePairEligible: boolean;
}
export interface EndpointEvidence { canonicalMatch: boolean; attested: boolean; availabilityUnknown: boolean; code: string }
export function connectionVerdict(before: ConnectionEvidence, after: ConnectionEvidence, token: string | null): "MEASURED" | "CONNECTION_CHANGED" | "CONNECTION_UNPROVEN" {
  if (before.token !== after.token) return "CONNECTION_CHANGED";
  return before.token && before.token === token && before.registered && after.registered && before.capability === after.capability
    ? "MEASURED" : "CONNECTION_UNPROVEN";
}
// Access is verified by index.mts before this route. No selectors are logged,
// audited, reflected, or used to trigger discovery, registration or a send.
export async function handleLoopIdentityCheck(request: Request, env: Env): Promise<Response> {
  const commit = health(env).commit;
  const workerRevision = commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  const failure = (code: string, status: number) => json({ schema: "loop-identity-check-v1", ok: false, code, workerRevision,
    currentConnectionCapability: "UNKNOWN", newRootRequired: true }, status);
  if (request.method !== "POST" || new URL(request.url).search) return failure("INVALID_REQUEST", 400);
  const body = await readJsonObject(request);
  if (!isSelectedPair(body)) return failure("INVALID_REQUEST", 400);
  try {
    const session = sessionStub(env, body.nodeId), registry = registryStub(env);
    const before = await session.loopCapabilityEvidence();
    const result = await registry.selectedLoopIdentityCheck(body);
    const after = await session.loopCapabilityEvidence();
    if (!await registry.selectedLoopIdentityUnchanged(body, result.stamp)) return failure("CONTEXT_CHANGED", 409);
    const code = connectionVerdict(before, after, result.registrationToken);
    return json({ schema: "loop-identity-check-v1", ok: code === "MEASURED", code, workerRevision,
      registryCapability: result.registryCapability,
      currentConnectionCapability: code === "MEASURED" ? after.capability : "UNKNOWN",
      endpointA: result.endpointA, endpointB: result.endpointB,
      samePairEligible: code === "MEASURED" && after.capability && result.samePairEligible, newRootRequired: true });
  } catch { return failure("EVIDENCE_UNAVAILABLE", 503); }
}
