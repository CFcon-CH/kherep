import assert from "node:assert/strict";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { identityVetoes } from "./session-label-vetoes.mts";
import type { LivenessSnapshot } from "./session-lifecycle.mts";
import type { SessionEvidence } from "./session-liveness.mts";
import type { IdentityVeto } from "./wake-bindings.mts";

// The veto reducer moved out of session-labels.mts (issue #828); these pin the
// branches the integration tests of the label state do not reach.
const S = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 10, 15, 12);
const target = { runtime: "claude-code", sessionId: S };
const snapshot = (parts: Partial<LivenessSnapshot>): LivenessSnapshot => ({ version: 1, generation: 2, sessions: [], tombstones: [], ...parts });
const row = (observedAt: number, lifecycleGeneration: number): SessionInfo => ({ ...target, state: "unknown",
  canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: S, observedAt, lifecycleGeneration } });
const veto = (parts: Partial<IdentityVeto> = {}): IdentityVeto => ({ ...target, kind: "terminal", sourceGeneration: 1, observedAt: NOW - 1000, lifecycleGeneration: 2, ...parts });

test("an accepted restore with equal-time proof at its generation clears a terminal veto", () => {
  const at = NOW - 1000;
  const source = { snapshot: snapshot({ tombstones: [{ ...target, state: "restored", generation: 3, observedAt: at }] }), listed: [row(at, 3)], evidence: [] };
  assert.deepEqual(identityVetoes({ identityVetoes: [veto()], bindings: [] }, [row(at, 3)], source, NOW, true), []);
  assert.equal(identityVetoes({ identityVetoes: [veto()], bindings: [] }, [row(at, 2)], source, NOW, true).length, 1, "proof below the restore generation keeps it");
});

test("evidence without a valid identity is skipped", () => {
  const evidence = [{ runtime: "Not A Runtime", sessionId: S }] as SessionEvidence[];
  assert.deepEqual(identityVetoes({ identityVetoes: [], bindings: [] }, [], { snapshot: snapshot({}), listed: [], evidence }, NOW, true), []);
});

test("a native lifecycle event that contradicts an accepted conflict tombstone by generation or age adds a conflict fact", () => {
  const accepted = { ...target, state: "archived" as const, generation: 2, observedAt: NOW - 200 };
  const verdict = { ...target, state: "unknown" as const, observedAt: NOW - 200, reasonCode: "conflict" as const, lifecycleGeneration: 2 };
  const run = (generation: number, observedAt: number) => identityVetoes({ identityVetoes: [], bindings: [] }, [],
    { snapshot: snapshot({ sessions: [verdict], tombstones: [accepted] }), listed: [], evidence: [{ ...target,
      lifecycle: { status: "value", value: { state: "archived", generation }, observedAt, complete: true, source: "native-lifecycle", reasonCode: "observed" } }] }, NOW, true);
  assert.deepEqual(run(3, NOW - 100).map(v => [v.kind, v.observedAt, v.lifecycleGeneration]), [["terminal", NOW - 100, 2]], "a newer generation");
  assert.deepEqual(run(2, NOW - 300).map(v => [v.kind, v.observedAt]), [["terminal", NOW - 200]], "an older observation of the same generation");
  assert.deepEqual(run(2, NOW - 100).map(v => [v.kind, v.observedAt]), [["terminal", NOW - 200]], "an agreeing event adds nothing");
});
