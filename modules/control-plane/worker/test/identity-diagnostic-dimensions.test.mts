import { describe, expect, it } from "vitest";

import type { MessageBinding } from "../../protocol-message-binding.mts";
import { identityDiagnostic, selectedProofDimensions } from "../src/message-identity-diagnostics.mts";
import type { LoopSnapshot } from "../src/message-loop-identity.mts";
import type { PreparedLoop } from "../src/message-store.mts";

// Issue #965: the exported identity diagnostic helpers on synthetic input.
// A selected binding is compared with the current snapshot's owner pair and
// its identity proof [1, fromRuntime, fromLifecycle, toRuntime, toLifecycle].
const FROM = "11111111-1111-4111-8111-111111111111", TO = "22222222-2222-4222-8222-222222222222";
const binding = (fromGeneration: number | null = 3, toGeneration: number | null = 5): MessageBinding => ({ version: 1, mode: "exact",
  from: { sessionId: FROM, runtime: "codex", lifecycleGeneration: fromGeneration },
  to: { sessionId: TO, runtime: "claude-code", lifecycleGeneration: toGeneration } } as MessageBinding);
const prepared = (selected: MessageBinding | null): PreparedLoop => ({ snapshot: {} as LoopSnapshot, key: null, signal: null,
  ...(selected ? { binding: { stamp: "s", binding: selected, denyKey: null, leaseId: null, localGeneration: null } } : {}) });
const snapshot = (proof: unknown[] | null, direction: 0 | 1 | null, from = FROM, to = TO): LoopSnapshot => ({
  from: { nodeId: "a", session: from }, to: { nodeId: "b", session: to }, direction,
  identityBinding: proof ? JSON.stringify(proof) : null } as LoopSnapshot);

describe("selectedProofDimensions", () => {
  it("is empty without a selected binding or when the proof agrees in either direction", () => {
    expect(selectedProofDimensions(prepared(null), snapshot([1, "codex", 3, "claude-code", 5], 0))).toEqual([]);
    expect(selectedProofDimensions(prepared(binding()), snapshot([1, "codex", 3, "claude-code", 5], 0))).toEqual([]);
    expect(selectedProofDimensions(prepared(binding()), snapshot([1, "claude-code", 5, "codex", 3], 1))).toEqual([]);
    expect(selectedProofDimensions(prepared(binding(null, null)), snapshot([1, "codex", 9, "claude-code", 9], 0))).toEqual([]);
  });

  it("reports an owner change even when no proof can be read", () => {
    expect(selectedProofDimensions(prepared(binding()), snapshot(null, 0, FROM, FROM))).toEqual(["owner", "selected-proof"]);
    expect(selectedProofDimensions(prepared(binding()), snapshot([1, "codex", 3, "claude-code", 5], null, TO, TO)))
      .toEqual(["owner", "selected-proof"]);
  });

  it("reports runtime and lifecycle changes on either side", () => {
    expect(selectedProofDimensions(prepared(binding()), snapshot([1, "claude-code", 3, "claude-code", 5], 0)))
      .toEqual(["runtime", "selected-proof"]);
    expect(selectedProofDimensions(prepared(binding()), snapshot([1, "codex", 4, "claude-code", 5], 0)))
      .toEqual(["lifecycle", "selected-proof"]);
    expect(selectedProofDimensions(prepared(binding()), snapshot([1, "codex", 3, "claude-code", 6], 0)))
      .toEqual(["lifecycle", "selected-proof"]);
  });
});

describe("identityDiagnostic", () => {
  it("returns no diagnostic when nothing changed", () => {
    expect(identityDiagnostic(prepared(null), { matches: true }, "send-admission", 0)).toBeUndefined();
  });

  it("reports the extra dimensions it is given", () => {
    expect(identityDiagnostic(prepared(null), { matches: false }, "mcp-claim", 0, ["owner"]))
      .toEqual({ version: 1, kind: "identity-change", stage: "mcp-claim", observedAt: new Date(0).toISOString(), dimensions: ["owner"] });
  });
});
