import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { reserveTargetOwner, releaseNativeOwner, releaseTargetOwner, reserveNativeOwner, withTargetReservation } from "./codex-native-pending.mts";
import { nativeQueueGroups, outstandingNativeAttempts, retireNativeQueue } from "./codex-native-attempts.mts";
import { submitTargetQueueGroup } from "./codex-queue-producer.mts";
import { markDelivered, storeMessage } from "./inbox.mts";
import { beginTargetSubmission, cancelTargetBeforeSubmit, finishTargetSubmission, prepareTargetDelivery } from "./target-delivery.mts";
import { targetFixture, TARGET_T as T, TARGET_OWNER as OWNER, TARGET_NODE as NODE, TARGET_QUEUE as QUEUE, TARGET_LIMITS as LIMITS, targetId } from "./target-delivery-fixture.mts";
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const prepare = (f: ReturnType<typeof targetFixture>) => {
  const h = reserveTargetOwner(f.paths, f.group)!; assert.ok(h); prepareTargetDelivery(f.paths, h, T, LIMITS); return h;
};
test("reserve -> debit -> complete group and all original attempt references precede any injected transport", async t => {
  const f = targetFixture(t), h = prepare(f);
  let calls = 0;
  const result = await submitTargetQueueGroup(f.paths, h, () => T, async request => {
    calls++; assert.equal(read(f.reservation).phase, "submitting"); assert.equal(read(f.budget).turns.length, 1);
    assert.equal(read(f.groupFile).reference.reservationId, h.reservationId);
    for (const n of [1, 2]) assert.deepEqual(read(f.attempt(n)).targetGroup, read(f.groupFile).reference);
    assert.equal(JSON.stringify(request).includes(f.rows[0]!.text), false); assert.equal(request.owner, OWNER);
    return { queueId: QUEUE };
  });
  assert.equal(calls, 1); assert.equal(result.phase, "submitted"); assert.equal(result.queueId, QUEUE);
  assert.equal(releaseTargetOwner(f.paths, h, "no-submit"), false); assert.equal(releaseTargetOwner(f.paths, h, "reconciled"), false);
  assert.throws(() => releaseNativeOwner(f.paths, OWNER, f.group.members.map(m => m.messageId)), "old IDs cannot release v2");
});
test("two routes on same owner never acquire a second group or submission; arrivals never enlarge membership", async t => {
  const f = targetFixture(t), h = prepare(f);
  assert.equal(reserveTargetOwner(f.paths, { ...f.group, groupId: crypto.randomUUID() }), null);
  storeMessage(f.paths.inbox, { messageId: targetId(3), from: { nodeId: NODE, session: "new" }, toSession: OWNER, text: "new arrival",
    createdAt: new Date(T).toISOString(), senderOrigin: { nodeId: NODE, sentAt: new Date(T).toISOString() } }, T);
  let finish!: () => void, calls = 0;
  const a = submitTargetQueueGroup(f.paths, h, () => T, async request => { calls++; assert.match(request.input[0]!.text, /2/); await new Promise<void>(r => { finish = r; }); return { queueId: QUEUE }; });
  // The adapter's first durable transition is synchronous before transport.
  await new Promise(r => setImmediate(r));
  await assert.rejects(submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; return { queueId: QUEUE }; }));
  finish(); await a; assert.equal(calls, 1); assert.equal(read(f.groupFile).group.members.length, 2);
  assert.equal(fs.existsSync(f.attempt(3)), false);
});
test("lost submission response remains fenced; exact late queue ID resolves same debit without another transport", async t => {
  const f = targetFixture(t), h = prepare(f); let calls = 0;
  assert.equal((await submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; throw Error("lost response"); })).phase, "uncertain");
  await assert.rejects(submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; return { queueId: QUEUE }; }));
  assert.equal(releaseTargetOwner(f.paths, h, "reconciled"), false);
  assert.equal(finishTargetSubmission(f.paths, h, QUEUE).phase, "submitted");
  assert.equal(finishTargetSubmission(f.paths, h, QUEUE).phase, "submitted");
  assert.throws(() => finishTargetSubmission(f.paths, h, crypto.randomUUID())); assert.equal(calls, 1); assert.equal(read(f.budget).turns.length, 1);
});
test("ACK during submission and a late response retain exact group/queue evidence; only bound reconciliation releases", async t => {
  const f = targetFixture(t), h = prepare(f);
  await submitTargetQueueGroup(f.paths, h, () => T, async () => {
    for (const row of f.rows) markDelivered(f.paths.inbox, row.messageId);
    return { queueId: QUEUE };
  });
  assert.equal(read(f.reservation).queueId, QUEUE); assert.equal(outstandingNativeAttempts(f.paths, OWNER).length, 2);
  const group = nativeQueueGroups(f.paths, OWNER)[0]!; assert.ok(group.targetGroup);
  retireNativeQueue(f.paths, { ...group, targetGroup: undefined } as typeof group);
  assert.equal(releaseTargetOwner(f.paths, h, "reconciled"), false, "legacy/missing reference is not core proof");
  retireNativeQueue(f.paths, group);
  assert.equal(releaseTargetOwner(f.paths, h, "reconciled"), true); assert.equal(fs.existsSync(f.reservation), false);
  assert.equal(fs.existsSync(f.groupFile), true); assert.equal(fs.existsSync(f.attempt(1)), true);
});
test("no-submit release requires full exact cancelled state and original token, no refund", t => {
  const f = targetFixture(t), h = prepare(f);
  assert.equal(releaseTargetOwner(f.paths, h, "no-submit"), false);
  assert.throws(() => releaseTargetOwner(f.paths, { ...h, attemptToken: crypto.randomUUID() }, "no-submit"));
  cancelTargetBeforeSubmit(f.paths, h);
  assert.equal(releaseTargetOwner(f.paths, h, "no-submit"), true); assert.equal(read(f.budget).turns.length, 1);
  assert.throws(() => releaseTargetOwner(f.paths, h, "no-submit"));
  assert.equal(reserveNativeOwner(f.paths, OWNER, [targetId(3)]), true);
});
for (const drift of ["member", "address", "origin", "offer", "node", "partial-attempt", "missing-budget", "missing-marker-and-budget"]) test(`actual prepare/submit seam fences ${drift}`, async t => {
  const f = targetFixture(t), h = prepare(f); let calls = 0;
  if (["member", "address", "origin", "offer"].includes(drift)) {
    const file = `${f.paths.inbox}/${targetId(1)}.json`, row = read(file);
    if (drift === "member") row.text += "changed";
    if (drift === "address") row.from.session += "changed";
    if (drift === "origin") row.senderOrigin.sentAt = new Date(T - 1).toISOString();
    if (drift === "offer") row.codexOffer = { owner: OWNER, generation: crypto.randomUUID(), fingerprint: "a".repeat(64) };
    fs.writeFileSync(file, JSON.stringify(row));
  }
  if (drift === "node") { const c = read(f.paths.config); c.nodeId = crypto.randomUUID(); fs.writeFileSync(f.paths.config, JSON.stringify(c)); }
  if (drift === "partial-attempt") fs.unlinkSync(f.attempt(2));
  if (drift.startsWith("missing-")) { fs.unlinkSync(f.budget); if (drift === "missing-marker-and-budget") fs.unlinkSync(f.budget.replace(".turns.json", ".budget-state.json")); }
  await assert.rejects(submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; return { queueId: QUEUE }; }));
  assert.equal(calls, 0); assert.equal(fs.existsSync(f.reservation), true);
});
test("expired ready core cannot invoke transport; late finish after a timely begin remains possible", async t => {
  const f = targetFixture(t), h = prepare(f); let calls = 0;
  await assert.rejects(submitTargetQueueGroup(f.paths, h, () => f.group.deadlineMs, async () => { calls++; return {}; }));
  beginTargetSubmission(f.paths, h, f.group.deadlineMs - 1); assert.equal(finishTargetSubmission(f.paths, h, QUEUE).phase, "submitted"); assert.equal(calls, 0);
});
test("changed immutable handle/policy/lifecycle and detached mutation cannot rewrite reservation", t => {
  const f = targetFixture(t), h = prepare(f), before = fs.readFileSync(f.reservation, "utf8");
  assert.throws(() => withTargetReservation(f.paths, { ...h, groupFingerprint: "d".repeat(64) }, () => true));
  for (const field of ["policyFingerprint", "lifecycleGeneration"]) assert.throws(() => withTargetReservation(f.paths, h, (s, save) => {
    save({ ...s, phase: "submitting", group: { ...s.group, [field]: field === "lifecycleGeneration" ? 8 : "c".repeat(64) } });
  }));
  let detached!: () => void; withTargetReservation(f.paths, h, (s, save) => { detached = () => save({ ...s, phase: "submitting" }); });
  assert.throws(detached); assert.equal(fs.readFileSync(f.reservation, "utf8"), before);
});

test("durable group receipt prevents even legacy writers reinitializing a lost budget and marker", async t => {
  const f = targetFixture(t), h = prepare(f);
  fs.unlinkSync(f.budget); fs.unlinkSync(f.budget.replace(".turns.json", ".budget-state.json"));
  const { takeTurn } = await import("./autonomy.mts");
  assert.equal(takeTurn(f.paths, OWNER, T, LIMITS), "locked");
  assert.equal(fs.existsSync(f.budget), false); assert.equal(fs.existsSync(f.groupFile), true);
});

test("an exact queue receipt without processing ACK cannot release a core owner", async t => {
  const f = targetFixture(t), h = prepare(f);
  await submitTargetQueueGroup(f.paths, h, () => T, async () => ({ queueId: QUEUE }));
  retireNativeQueue(f.paths, nativeQueueGroups(f.paths, OWNER)[0]!);
  assert.equal(releaseTargetOwner(f.paths, h, "reconciled"), false);
});

test("real processing offer and ACK during submit may advance delivery facts without adopting a new group", async t => {
  const f = targetFixture(t), h = prepare(f), originalGroup = fs.readFileSync(f.groupFile, "utf8");
  const { prepareCodexOffers, acknowledgeCodexOffer } = await import("./codex-inbox-ack.mts");
  await submitTargetQueueGroup(f.paths, h, () => T, async () => {
    const token = crypto.randomUUID();
    assert.equal(prepareCodexOffers(f.paths, f.rows, OWNER, token, T + 100, "receive").length, 2);
    assert.throws(() => acknowledgeCodexOffer(f.paths, crypto.randomUUID(), token, [OWNER]));
    acknowledgeCodexOffer(f.paths, OWNER, token, [OWNER]);
    return { queueId: QUEUE };
  });
  assert.equal(read(f.reservation).phase, "submitted");
  assert.equal(fs.readFileSync(f.groupFile, "utf8"), originalGroup);
  retireNativeQueue(f.paths, nativeQueueGroups(f.paths, OWNER)[0]!);
  assert.equal(releaseTargetOwner(f.paths, h, "reconciled"), true);
});

for (const malformed of [false, 0, ""]) test(`persisted present offer ${JSON.stringify(malformed)} refuses before submit callback`, async t => {
  const f = targetFixture(t), h = prepare(f), groupBefore = fs.readFileSync(f.groupFile, "utf8"), reservationBefore = fs.readFileSync(f.reservation, "utf8");
  const file = `${f.paths.inbox}/${f.rows[0]!.messageId}.json`, row = read(file);
  row.codexOffer = malformed; fs.writeFileSync(file, JSON.stringify(row));
  const malformedBytes = fs.readFileSync(file, "utf8"); let calls = 0;
  await assert.rejects(submitTargetQueueGroup(f.paths, h, () => T, async () => { calls++; return { queueId: QUEUE }; }));
  assert.equal(calls, 0); assert.equal(fs.readFileSync(file, "utf8"), malformedBytes, "no silent normalization of stored data");
  assert.equal(fs.readFileSync(f.reservation, "utf8"), reservationBefore, "phase remains ready");
  assert.equal(fs.readFileSync(f.groupFile, "utf8"), groupBefore, "immutable group remains unchanged");
});
