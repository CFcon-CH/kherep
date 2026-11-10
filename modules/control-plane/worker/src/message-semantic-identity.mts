import { sortedDimensions, type IdentityDimension } from "../../protocol-diagnostics.mts";
import { SELECTED_BINDING_CAPABILITY, type MessageBinding } from "../../protocol-message-binding.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { MESSAGING_LOOP_BRAKE_CAPABILITY } from "../../protocol-loop-brake.mts";
import type { CanonicalReference } from "./registry-session-identity.mts";
import type { LoopSnapshot, Parent } from "./message-loop-identity.mts";

// Input references must be resolved at comparison time: their classifier has
// already revalidated proof freshness, validity, runtime and eligibility. Only
// observation time, population generation and attested availability are non-semantic.
export function semanticReference(r: CanonicalReference) {
  if (!r.address) return { address: null, eligible: r.eligible, code: r.code };
  return { address: r.address, match: r.match, runtime: r.runtime,
    unknown: r.code === "ATTESTED" && r.eligible && r.proof !== null ? false : r.unknown, eligible: r.eligible, code: r.code,
    proof: r.proof ? { version: r.proof.version, source: r.proof.source, runtime: r.proof.runtime,
      sessionId: r.proof.sessionId, lifecycleGeneration: r.proof.lifecycleGeneration } : null };
}

export function semanticNodes(sql: SqlStorage, nodeIds: string[]) {
  return nodeIds.map(nodeId => {
    const n = sql.exec("SELECT message_connection_token,registration_token,capabilities FROM nodes WHERE id=? AND revoked_at IS NULL", nodeId).toArray()[0];
    if (!n) return null;
    let capabilities: unknown; try { capabilities = JSON.parse(String(n.capabilities)); } catch { capabilities = null; }
    const has = (capability: string) => Array.isArray(capabilities) && capabilities.includes(capability);
    const token = typeof n.message_connection_token === "string" ? n.message_connection_token : null;
    const registration = typeof n.registration_token === "string" ? n.registration_token : null;
    return { token, registration, capable: token !== null && registration === token && has(SELECTED_BINDING_CAPABILITY),
      messaging: has(MESSAGING_CAPABILITY), brake: has(MESSAGING_LOOP_BRAKE_CAPABILITY) };
  });
}

function semanticBinding(binding: MessageBinding) {
  const owner = (o: MessageBinding["from"]) => [o.sessionId, o.runtime, o.lifecycleGeneration];
  return [binding.version, binding.mode, owner(binding.from), owner(binding.to)];
}
export const sameBinding = (a: MessageBinding, b: MessageBinding): boolean => JSON.stringify(semanticBinding(a)) === JSON.stringify(semanticBinding(b));

interface ComparisonOptions { parentRetirementEquivalent?: boolean }
function semanticParent(parent: Parent, options: ComparisonOptions) {
  if (parent.kind === "missing") return parent;
  // These states only move forward into each other, so an advance between two
  // snapshots is not a lineage change. Admission is decided by validate() on
  // the current snapshot, which still refuses a guarded parent that is queued.
  // Refusal or expiry never joins the class.
  const state = ["queued", "accepted", "delivered", "replied"].includes(String(parent.row.state)) ? "accepted" : parent.row.state;
  return { ...parent, row: { ...parent.row, state,
    ...(options.parentRetirementEquivalent ? { from_session: null, to_session: null } : {}) } };
}
// Only an unbound guarded parent consumes the positive-state compatibility bit.
const semanticCompatibility = (s: LoopSnapshot) => s.parent.kind === "guarded" && s.parent.identityBinding === null ? s.compatibility : null;
const semanticLoop = (s: LoopSnapshot, options: ComparisonOptions) => ({ ...s, compatibility: semanticCompatibility(s), parent: semanticParent(s.parent, options) });
export const sameLoopIdentity = (a: LoopSnapshot, b: LoopSnapshot, options: ComparisonOptions = {}): boolean => JSON.stringify(semanticLoop(a, options)) === JSON.stringify(semanticLoop(b, options));

// Compare the same semantic leaves used by equality, returning codes only.
const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);
type Ref = ReturnType<typeof semanticReference>;
export function changedReferenceDimensions(a: readonly Ref[], b: readonly Ref[]): IdentityDimension[] {
  const dimensions: IdentityDimension[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const before = a[i] as unknown as Record<string, unknown> | undefined, after = b[i] as unknown as Record<string, unknown> | undefined;
    const ap = before?.proof as Record<string, unknown> | null | undefined, bp = after?.proof as Record<string, unknown> | null | undefined;
    if (differs(before?.address, after?.address) || ap && bp && differs(ap.sessionId, bp.sessionId)) dimensions.push("owner");
    if (before?.address && after?.address && before.match !== after.match) dimensions.push("reference-match");
    if (before?.runtime !== after?.runtime || ap && bp && ap.runtime !== bp.runtime) dimensions.push("runtime");
    if (ap && bp && ap.lifecycleGeneration !== bp.lifecycleGeneration) dimensions.push("lifecycle");
    if (ap && bp ? differs([ap.version, ap.source], [bp.version, bp.source])
      : (!!ap !== !!bp && [before?.code, after?.code].some(c => c === "LEGACY_KNOWN" || c === "UNPROVEN"))) dimensions.push("proof-kind");
    if (differs([before?.eligible, before?.code, before?.unknown], [after?.eligible, after?.code, after?.unknown])) dimensions.push("eligibility");
  }
  return dimensions;
}
export function changedNodeDimensions(a: ReturnType<typeof semanticNodes>, b: ReturnType<typeof semanticNodes>): IdentityDimension[] {
  const dimensions: IdentityDimension[] = [];
  const tokens = (nodes: typeof a) => nodes.map(n => [n?.token, n?.registration]);
  if (differs(tokens(a), tokens(b))) dimensions.push("connection");
  // capable includes registration. A changed connection alone cannot establish
  // a capability change; compare this derived bit only on equal connections.
  const capabilities = (nodes: typeof a) => nodes.map((n, i) => [n?.messaging, n?.brake,
    !differs(tokens([a[i]]), tokens([b[i]])) ? n?.capable : null]);
  if (differs(capabilities(a), capabilities(b))) dimensions.push("capability");
  return dimensions;
}
export function changedIdentityDimensions(a: LoopSnapshot, b: LoopSnapshot, options: ComparisonOptions = {}): IdentityDimension[] {
  const dimensions = [...changedReferenceDimensions(a.proofs as Ref[], b.proofs as Ref[]), ...changedNodeDimensions(a.connections, b.connections)];
  if (differs(semanticCompatibility(a), semanticCompatibility(b))) dimensions.push("eligibility");
  if (a.both !== b.both) dimensions.push("capability");
  if (differs(semanticParent(a.parent, options), semanticParent(b.parent, options))) dimensions.push("lineage");
  return sortedDimensions(dimensions);
}
// Retain the fixed audit field without the old unsupported selected-binding fallback.
export const changedIdentityDimension = (a: LoopSnapshot, b: LoopSnapshot, options: ComparisonOptions = {}): IdentityDimension | undefined => changedIdentityDimensions(a, b, options)[0];
