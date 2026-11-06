import { sortedDimensions, type DiagnosticStage, type IdentityDimension, type MessageDiagnostic } from "../../protocol-diagnostics.mts";
import { parseIdentityBinding } from "../../protocol-session-identity.mts";
import type { LoopSnapshot } from "./message-loop-identity.mts";
import type { PreparedLoop } from "./message-store.mts";
import { bindingContext } from "./message-binding.mts";
import { changedIdentityDimensions, changedNodeDimensions, changedReferenceDimensions, semanticReference } from "./message-semantic-identity.mts";
export interface IdentityComparison { matches: boolean; parentRetirementEquivalent?: boolean; current?: LoopSnapshot; context?: ReturnType<typeof bindingContext> }
export function identityDiagnostic(prepared: PreparedLoop, comparison: IdentityComparison, stage: DiagnosticStage, now: number,
  extra: IdentityDimension[] = []): MessageDiagnostic | undefined {
  const dimensions = [...extra];
  if (comparison.current) dimensions.push(...changedIdentityDimensions(prepared.snapshot, comparison.current,
    { parentRetirementEquivalent: comparison.parentRetirementEquivalent }));
  if (prepared.binding?.connectionChanged) dimensions.push("connection");
  const before = prepared.binding?.context, after = comparison.context;
  if (before && after) dimensions.push(...changedReferenceDimensions(before.refs.map(semanticReference), after.refs.map(semanticReference)),
    ...changedNodeDimensions(before.nodes, after.nodes));
  const sorted = sortedDimensions(dimensions);
  return sorted.length ? { version: 1, kind: "identity-change", stage, observedAt: new Date(now).toISOString(), dimensions: sorted } : undefined;
}
export function selectedProofDimensions(prepared: PreparedLoop, current: LoopSnapshot): IdentityDimension[] {
  const selected = prepared.binding?.binding;
  if (!selected) return [];
  const dimensions: IdentityDimension[] = [];
  if (current.from?.session !== selected.from.sessionId || current.to?.session !== selected.to.sessionId) dimensions.push("owner");
  const proof = parseIdentityBinding(current.identityBinding);
  if (proof && current.direction !== null) {
    const from = current.direction === 0 ? [proof[1], proof[2]] : [proof[3], proof[4]];
    const to = current.direction === 0 ? [proof[3], proof[4]] : [proof[1], proof[2]];
    if (selected.from.runtime !== from[0] || selected.to.runtime !== to[0]) dimensions.push("runtime");
    if (selected.from.lifecycleGeneration !== null && selected.from.lifecycleGeneration !== from[1]
      || selected.to.lifecycleGeneration !== null && selected.to.lifecycleGeneration !== to[1]) dimensions.push("lifecycle");
  }
  return dimensions.length ? [...dimensions, "selected-proof"] : [];
}
