import { BINDING_TTL_MS, type BoundOwner, type MessageBinding,
  type ResolveRequest, type ResolveResponse, type SelectedResult } from "../../protocol-message-binding.mts";
import { OPERATOR_NODE_ID, type MessageAddress } from "../../protocol-messages.mts";
import { RegistrySessionIdentity } from "./registry-session-identity.mts";
import { pairIdentity } from "./message-loop-identity.mts";
import type { LoopSigner } from "./message-loop-signals.mts";
import { parseIdentityBinding } from "../../protocol-session-identity.mts";
import { semanticNodes, semanticReference } from "./message-semantic-identity.mts";
type AddressPair = { messageId: string; from: MessageAddress; to: MessageAddress };
type Resolve = (nodeId: string, request: ResolveRequest) => Promise<ResolveResponse | null>;
export interface PreparedBinding {
  stamp: string; binding: MessageBinding | null; denyKey: string | null; leaseId: string | null; localGeneration: number | null; error?: string;
}
export function bindingContext(sql: SqlStorage, message: AddressPair): { stamp: string; refs: ReturnType<RegistrySessionIdentity["resolveCanonicalReference"]>[];
  nodes: ReturnType<typeof semanticNodes> } {
  const identities = new RegistrySessionIdentity(sql);
  const refs = [message.from, message.to].map(a => identities.resolveCanonicalReference(a, Date.now()));
  const nodes = semanticNodes(sql, [message.from.nodeId, message.to.nodeId]);
  return { refs, nodes, stamp: JSON.stringify([refs.map(semanticReference), nodes]) };
}
const boundOwner = (r: Extract<SelectedResult, { code: "BOUND" }>): BoundOwner => ({ sessionId: r.owner.sessionId, runtime: r.owner.runtime,
  lifecycleGeneration: r.lifecycleGeneration });
export function selectedAgreesWithProof(binding: MessageBinding, proof: string, direction: 0 | 1 | null): boolean {
  const p = parseIdentityBinding(proof);
  if (!p || direction === null) return false;
  const from = direction === 0 ? [p[1], p[2]] : [p[3], p[4]], to = direction === 0 ? [p[3], p[4]] : [p[1], p[2]];
  return binding.from.runtime === from[0] && binding.to.runtime === to[0]
    && (binding.from.lifecycleGeneration === null || binding.from.lifecycleGeneration === from[1])
    && (binding.to.lifecycleGeneration === null || binding.to.lifecycleGeneration === to[1]);
}
export async function prepareMessageBinding(sql: SqlStorage, message: AddressPair, sign: LoopSigner, resolve: Resolve,
  purpose: "admit" | "egress" = "admit", stored?: MessageBinding): Promise<PreparedBinding> {
  const context = bindingContext(sql, message);
  const result: PreparedBinding = { stamp: context.stamp, binding: null, denyKey: null, leaseId: null, localGeneration: null };
  const expiresAt = Date.now() + BINDING_TTL_MS;
  const selected = new Map<"from" | "to", Extract<SelectedResult, { code: "BOUND" }>>();
  const requests = new Map<string, ResolveRequest>();
  for (const [index, role] of ["from", "to"].entries()) {
    const key = role as "from" | "to", address = message[key], reference = context.refs[index];
    if (stored && key === "from") continue; // An admitted source never reconnects or rebinds on replay.
    if (address.nodeId === OPERATOR_NODE_ID || !context.nodes[index]?.capable || reference.code === "AMBIGUOUS") continue;
    let request = requests.get(address.nodeId);
    if (!request) { request = { version: 1, requestId: crypto.randomUUID(), messageId: message.messageId, purpose, selections: [], expiresAt }; requests.set(address.nodeId, request); }
    const expected = stored ? { sessionId: stored[key].sessionId, runtime: stored[key].runtime }
      : reference.address ? { sessionId: reference.address.session, runtime: reference.runtime } : undefined;
    request.selections.push({ role: key, ref: address.session, ...(expected ? { expected } : {}) });
  }
  const answers = await Promise.all([...requests].map(async ([nodeId, request]) => {
    try { return { request, answer: await resolve(nodeId, request) }; }
    catch { return { request, answer: null }; }
  }));
  for (const { request, answer } of answers) {
    if (!answer || answer.requestId !== request.requestId || answer.messageId !== request.messageId) continue;
    for (const r of answer.results) {
      const s = request.selections.find(s => s.role === r.role);
      if (!s || r.code !== "BOUND" || s.expected && (s.expected.sessionId !== r.owner.sessionId || s.expected.runtime !== r.owner.runtime)) continue;
      selected.set(r.role, r);
    }
  }
  const source = stored?.from ?? (message.from.nodeId === OPERATOR_NODE_ID
    ? { sessionId: message.from.session, runtime: null, lifecycleGeneration: null }
    : selected.has("from") ? boundOwner(selected.get("from")!) : null);
  const target = selected.has("to") ? boundOwner(selected.get("to")!) : null;
  if (!source || !target) return result;
  if (stored && JSON.stringify(stored.to) !== JSON.stringify(target)) return result;
  const pair = pairIdentity({ nodeId: message.from.nodeId, session: source.sessionId }, { nodeId: message.to.nodeId, session: target.sessionId });
  try { result.denyKey = pair ? await sign("kherep-loop-pair-v1", pair.encoding) : null; }
  catch { return { ...result, error: "loop-crypto-unavailable" }; }
  result.binding = { version: 1, mode: "exact", from: source, to: target };
  result.leaseId = selected.get("to")!.leaseId;
  result.localGeneration = selected.get("to")!.localGeneration;
  return result;
}
