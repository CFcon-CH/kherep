import { SELECTED_BINDING_CAPABILITY, type MessageBinding } from "../../protocol-message-binding.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { MESSAGING_LOOP_BRAKE_CAPABILITY } from "../../protocol-loop-brake.mts";
import type { CanonicalReference } from "./registry-session-identity.mts";
import type { LoopSnapshot, Parent } from "./message-loop-identity.mts";

// Input references must be resolved at comparison time: their classifier has
// already revalidated proof freshness, validity, runtime and eligibility. Only
// observation time and the node's population generation are non-semantic.
export function semanticReference(r: CanonicalReference) {
  if (!r.address) return { address: null, eligible: r.eligible, code: r.code };
  return { address: r.address, match: r.match, runtime: r.runtime, unknown: r.unknown, eligible: r.eligible, code: r.code,
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

function semanticParent(parent: Parent) {
  if (parent.kind === "missing") return parent;
  // These are precisely the states validate() admits as a guarded parent.
  // A processing/status advance keeps the lineage eligible; refusal or expiry
  // never joins that class and is revalidated against the current parent.
  const state = ["accepted", "delivered", "replied"].includes(String(parent.row.state)) ? "accepted" : parent.row.state;
  return { ...parent, row: { ...parent.row, state } };
}
const semanticLoop = (s: LoopSnapshot) => ({ ...s, parent: semanticParent(s.parent) });
export const sameLoopIdentity = (a: LoopSnapshot, b: LoopSnapshot): boolean => JSON.stringify(semanticLoop(a)) === JSON.stringify(semanticLoop(b));

// Fixed audit metadata, never a new refusal/wire code or an identity dump.
export function changedIdentityDimension(a: LoopSnapshot, b: LoopSnapshot): string {
  for (const [code, before, after] of [
    ["owner", [a.from, a.to, a.encoding, a.direction], [b.from, b.to, b.encoding, b.direction]],
    ["connection", a.connections, b.connections], ["lifecycle", a.identityBinding, b.identityBinding],
    ["eligibility", [a.proofs, a.compatibility], [b.proofs, b.compatibility]],
    ["capability", a.both, b.both], ["lineage", semanticParent(a.parent), semanticParent(b.parent)],
  ]) if (JSON.stringify(before) !== JSON.stringify(after)) return String(code);
  return "selected-binding";
}
