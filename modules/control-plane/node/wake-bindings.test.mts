import assert from "node:assert/strict";
import test from "node:test";
import { resolveWakeSelection, type BindingView } from "./wake-bindings.mts";
const S = "11111111-1111-4111-8111-111111111111", T = "22222222-2222-4222-8222-222222222222";
const view: BindingView = { status: "healthy", version: 1, bindings: [], complete: true, observedAt: 1000, local: [{ nodeId: "local", runtime: "claude-code", sessionId: S, name: "review", observedAt: 1000, lifecycleGeneration: 0, revision: 1 }] };
const select = (tokens: string[], v = view, now = 1000) => resolveWakeSelection(tokens, { target: { runtime: "claude-code", sessionId: S }, view: v, now });
test("pure resolver preserves exact-ID and wildcard distinction under damaged history", () => {
    const damaged = { ...view, status: "history-unavailable" as const };
    assert.equal(select([S], damaged).explicit, true);
    assert.deepEqual(select(["*"], damaged), { allowed: true, explicit: false, reason: "wildcard" });
    assert.equal(select(["review"], damaged).allowed, false);
});
test("pure resolver labels healthy unbound-name compatibility without inventing a pin", () => { assert.equal(select(["review"]).reason, "unbound-name"); assert.equal(view.bindings.length, 0); assert.equal(select(["review"], view, 200000).allowed, false); });
test("a full UUID policy token never falls back to a display name", () => { assert.equal(select([T], { ...view, local: [{ ...view.local[0], name: T }] }).allowed, false); });
test("stored selection follows exact runtime/ID independently of present duplicate names", () => {
    const bound = { ...view, bindings: [{ token: "review", runtime: "claude-code", sessionId: S, firstName: "review", boundAt: 1000, sourceGeneration: 1, provenance: "policy-co-list" as const }], local: [{ ...view.local[0], name: "analysis" }, { ...view.local[0], sessionId: T }] };
    assert.equal(select(["review"], bound).reason, "bound-name");
    assert.equal(resolveWakeSelection(["review"], { target: { runtime: "claude-code", sessionId: T }, view: bound, now: 1000 }).allowed, false);
    assert.equal(select(["review"], { ...bound, local: [...bound.local, { ...view.local[0], runtime: "codex" }] }).allowed, false);
});
test("review R1: healthy durable binding selects exact ID without a current display label", () => {
    const bound = { ...view, bindings: [{ token: "review", runtime: "claude-code", sessionId: S, firstName: "review", boundAt: 1000, sourceGeneration: 1, provenance: "policy-co-list" as const }] };
    for (const local of [[], [{ ...view.local[0], current: false }]])
        assert.deepEqual(select(["review"], { ...bound, local }), { allowed: true, explicit: true, reason: "bound-name" });
});
test("review R1: a name-shaped target ID cannot impersonate an exact full-ID policy grant", () => {
    const context = { target: { runtime: "claude-code", sessionId: "review" }, view: { ...view, status: "history-unavailable" as const }, now: 1000 };
    assert.equal(resolveWakeSelection(["review"], context).explicit, false);
    assert.equal(resolveWakeSelection(["review"], context).allowed, false);
    assert.deepEqual(resolveWakeSelection(["*"], context), { allowed: true, explicit: false, reason: "wildcard" });
});
