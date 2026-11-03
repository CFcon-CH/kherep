import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createTargetGroup, parseTargetGroup, targetGroupFingerprint, targetMembersMatch } from "./target-delivery-state.mts";
import type { InboxRecord } from "./inbox.mts";
const T = 1767225600000, node = "00000000-0000-4000-8000-000000000706", owner = "00000000-0000-4000-8000-000000000707";
function record(n = 1): InboxRecord {
  return { messageId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, from: { nodeId: node, session: "raw sender alias" },
    toSession: "raw target alias", text: "synthetic body", createdAt: new Date(T).toISOString(), receivedAt: new Date(T + 100).toISOString(),
    state: "accepted", senderOrigin: { nodeId: node, sentAt: new Date(T).toISOString() },
    codexOffer: { owner, generation: crypto.randomUUID(), fingerprint: "a".repeat(64) } };
}
const input = () => ({ runtime: "codex" as const, originalId: owner, nodeId: node, policyFingerprint: "b".repeat(64), lifecycleGeneration: 3, producer: null });
test("strict immutable bounded group retains raw endpoints, exact offer and minimum immutable origin deadline", () => {
  const a = record(), b = record(2); b.senderOrigin!.sentAt = new Date(T - 23 * 3_600_000).toISOString();
  const g = createTargetGroup(input(), [a, b], T);
  assert.equal(g.deadlineMs, T + 3_600_000); assert.equal(g.members[0]!.from.session, a.from.session);
  assert.equal(g.members[0]!.to.session, a.toSession); assert.deepEqual(g.members[0]!.offer, a.codexOffer);
  assert.equal(JSON.stringify(g).includes(a.text), false); assert.equal(Object.isFrozen(g.members[0]!.origin), true);
  assert.deepEqual(parseTargetGroup(JSON.parse(JSON.stringify(g))), g);
  assert.equal(targetGroupFingerprint(parseTargetGroup(g)), targetGroupFingerprint(g));
  assert.equal(targetMembersMatch(g, [a, b], node), true); assert.equal(targetMembersMatch(g, [a, b, record(3)], node), false);
});
test("membership, address, content, lineage, origin, offer and policy/lifecycle generations cannot drift", () => {
  const r = record(), g = createTargetGroup(input(), [r], T), original = JSON.stringify(g);
  for (const change of [(x: InboxRecord) => { x.text += "!"; }, (x: InboxRecord) => { x.toSession += "!"; },
    (x: InboxRecord) => { x.from.session += "!"; }, (x: InboxRecord) => { x.senderOrigin!.sentAt = new Date(T - 1).toISOString(); },
    (x: InboxRecord) => { x.codexOffer!.generation = crypto.randomUUID(); }, (x: InboxRecord) => { x.inReplyTo = record(2).messageId; },
    (x: InboxRecord) => { delete x.senderOrigin; }, (x: InboxRecord) => { x.codexOffer!.owner = crypto.randomUUID(); }]) {
    const copy = structuredClone(r); change(copy); assert.equal(targetMembersMatch(g, [copy], node), false);
  }
  for (const field of ["policyFingerprint", "lifecycleGeneration", "generation", "originalId"]) {
    const copy = JSON.parse(original); copy[field] = field === "lifecycleGeneration" ? 4 : field === "policyFingerprint" ? "c".repeat(64) : crypto.randomUUID();
    if (field === "originalId") assert.throws(() => parseTargetGroup(copy), "offer remains bound to original owner");
    else assert.notEqual(targetGroupFingerprint(parseTargetGroup(copy)), targetGroupFingerprint(g));
  }
});
test("parser and constructor refuse partial, oversized, unbound, future, expired and malformed groups", () => {
  const g = createTargetGroup(input(), [record()], T);
  for (const alter of [(x: any) => { x.extra = "body"; }, (x: any) => { x.members[0].text = "body"; },
    (x: any) => { x.deadlineMs++; }, (x: any) => { delete x.policyFingerprint; }, (x: any) => { x.members.push(x.members[0]); },
    (x: any) => { x.members[0].origin.nodeId = crypto.randomUUID(); }, (x: any) => { x.producer = {}; }]) {
    const copy = structuredClone(g); alter(copy); assert.throws(() => parseTargetGroup(copy));
  }
  assert.throws(() => createTargetGroup(input(), [], T));
  assert.throws(() => createTargetGroup(input(), Array.from({ length: 9 }, (_, n) => record(n)), T));
  for (const sentAt of [new Date(T + 1).toISOString(), new Date(T - 86_400_000).toISOString(), "2026-01-01T00:00:00Z"]) {
    const r = record(); r.senderOrigin!.sentAt = sentAt; assert.throws(() => createTargetGroup(input(), [r], T));
  }
});

test("present malformed offer is never normalized to an absent offer", () => {
  const r = record(); delete r.codexOffer; const g = createTargetGroup(input(), [r], T);
  for (const malformed of [null, undefined, false, 0, "", true, [], {},
    { owner, generation: "not-a-generation", fingerprint: "a".repeat(64) },
    { owner: crypto.randomUUID(), generation: crypto.randomUUID(), fingerprint: "a".repeat(64) },
    { owner, generation: crypto.randomUUID(), fingerprint: "bad-hash" },
    { owner, generation: crypto.randomUUID(), fingerprint: "a".repeat(64), extra: true }]) {
    const changed = { ...r, codexOffer: malformed } as unknown as InboxRecord;
    assert.throws(() => createTargetGroup(input(), [changed], T));
    assert.equal(targetMembersMatch(g, [changed], node), false);
  }
});
