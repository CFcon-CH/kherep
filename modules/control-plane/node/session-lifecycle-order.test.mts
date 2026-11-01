import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import { createAdmissionAuthority } from "./session-authority.mts";
import { syntheticListing } from "./session-authority-fixture.mts";
import type { SessionInfo } from "../protocol.mts";
import { markUnseen, readKnownSessions } from "./known-sessions.mts";
import { recordingSessions } from "./exchange-sessions.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { livenessAdmission, readLivenessSnapshot, sessionVerdict, terminalReference, livenessFile } from "./session-lifecycle.mts";
import type { Observation, SessionEvidence } from "./session-liveness.mts";
const now = 1_000_000, target = { runtime: "codex", sessionId: "review-target" };
const messageId = "00000000-0000-4000-8000-000000000001";
const row = { ...target, state: "active" };
const obs = <T,>(value: T, source: Observation<T>["source"], at = now): Observation<T> =>
  ({ status: "value", value, source, observedAt: at, complete: true, reasonCode: "observed" });
const lifecycle = (state: "restored" | "deleted" | "archived", generation: number, at = now): SessionEvidence =>
  ({ ...target, lifecycle: obs({ state, generation }, "native-lifecycle", at) });
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-lifecycle-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root), authority = createAdmissionAuthority(paths);
  return { paths, authority, record: (evidence: SessionEvidence, at: number, raw: SessionInfo[] = [row], unseen: string[] = []) => recordingSessions(paths,
    async () => syntheticListing(authority, markUnseen(raw, unseen), [evidence], at), () => {}, () => at, undefined, undefined, authority)() };
}
test("accepted final lifecycle governs retention across raw membership and runtime completeness", async t => {
  for (const terminal of ["deleted", "archived"] as const) for (const present of [true, false])
    for (const completeness of ["complete", "partial", "failed"] as const) for (const previous of ["running", "unknown"] as const)
      for (const accepted of [false, true]) await t.test(`${terminal} raw-${present ? "present" : "absent"} ${completeness} previous-${previous} ${accepted ? "accepted" : "rejected"}`, async sub => {
    const { paths, authority, record } = fixture(sub);
    const initial = previous === "running" ? { ...lifecycle("restored", 4),
      holder: obs({ present: true, creationIdentity: "initial-holder" }, "native-holder"), turn: obs("running" as const, "native-turn") } : lifecycle("restored", 4);
    await record(initial, now);
    assert.equal(livenessAdmission(paths, target, "queue", now, undefined, authority) !== null, previous === "running", "initial source-backed control");
    storeMessage(paths.inbox, { messageId, from: { nodeId: "00000000-0000-4000-8000-000000000002", session: "sender" },
      toSession: target.sessionId, text: "generated order matrix", createdAt: new Date(now + 1).toISOString() }, now + 1);
    const unseen = completeness === "complete" ? [] : completeness === "partial" ? ["*"] : [target.runtime];
    const result = await record(lifecycle(terminal, 5, accepted ? now + 2 : now - 1), now + 2, present ? [row] : [], unseen);
    const snapshot = readLivenessSnapshot(paths)!;
    assert.equal(snapshot.tombstones[0].state, accepted ? terminal : "restored");
    assert.equal(snapshot.tombstones[0].generation, accepted ? 5 : 4);
    assert.equal(result.length, accepted ? 0 : 1, "only accepted terminal authority may remove the prior address");
    const persisted = JSON.parse(fs.readFileSync(paths.sessions, "utf8")).sessions as SessionInfo[];
    assert.deepEqual(persisted.map(s => [s.runtime, s.sessionId, s.state]), accepted ? [] : [[target.runtime, target.sessionId, "unknown"]]);
    if (!accepted) {
      assert.equal(result[0].state, "unknown");
      assert.equal(sessionVerdict(paths, target, now + 2).reasonCode, "conflict");
    }
    assert.equal(terminalReference(paths, target.sessionId, "codex", now + 2), accepted);
    assert.equal(getMessage(paths.inbox, messageId)?.state, accepted ? "refused" : "accepted");
    assert.equal(readKnownSessions(paths).find(s => s.sessionId === target.sessionId)?.misses,
      !present && completeness === "complete" ? 1 : undefined, "old miss accounting still uses only raw membership/completeness");
    let launched = 0;
    if (livenessAdmission(paths, target, "queue", now + 2, undefined, authority) !== null) launched++;
    assert.equal(launched, 0);
    if (!accepted) {
      assert.deepEqual(await record(lifecycle(terminal, 5, now + 3), now + 3, [], unseen), [], "valid terminal control still excludes an absent raw row");
      assert.equal(terminalReference(paths, target.sessionId, "codex", now + 3), true);
      assert.equal(getMessage(paths.inbox, messageId)?.state, "refused");
    }
  });
});
test("older-time restore cannot resurrect a retained newer terminal identity", async t => {
  const { paths, authority, record } = fixture(t);
  await record(lifecycle("deleted", 4), now);
  const rejected = { ...lifecycle("restored", 5, now - 1),
    holder: obs({ present: true, creationIdentity: "later-holder" }, "native-holder", now + 2), turn: obs("running" as const, "native-turn", now + 2) };
  await record(rejected, now + 2);
  assert.equal(readLivenessSnapshot(paths)!.tombstones[0].state, "deleted");
  assert.equal(readLivenessSnapshot(paths)!.tombstones[0].generation, 4);
  assert.equal(sessionVerdict(paths, target, now + 2).state, "unknown");
  assert.equal(livenessAdmission(paths, target, "queue", now + 2, undefined, authority), null);
});
test("cache cannot assert an unaccepted terminal generation against a restored ledger", async t => {
  const { paths, record } = fixture(t);
  await record(lifecycle("restored", 4), now);
  const snapshot = readLivenessSnapshot(paths)!;
  snapshot.sessions = [{ ...target, state: "deleted", observedAt: now - 1, reasonCode: "observed", lifecycleGeneration: 5 }];
  fs.writeFileSync(livenessFile(paths), JSON.stringify(snapshot));
  assert.equal(readLivenessSnapshot(paths), null);
  assert.equal(terminalReference(paths, target.sessionId, "codex", now + 2), false);
});

test("stale hook and rejected restore never resurrect a retained terminal; valid newer restore still works", async t => {
  for (const present of [true, false]) await t.test(present ? "raw-present" : "raw-absent", async sub => {
    const { paths, authority, record } = fixture(sub);
    await record(lifecycle("deleted", 4), now);
    assert.deepEqual(await record({ ...target, hook: obs(true, "hook", now + 1) }, now + 1, present ? [row] : []), []);
    assert.equal(sessionVerdict(paths, target, now + 1).state, "deleted");
    const rejected = { ...lifecycle("restored", 5, now - 1),
      holder: obs({ present: true, creationIdentity: "rejected-restore-holder" }, "native-holder", now + 2), turn: obs("running" as const, "native-turn", now + 2) };
    await record(rejected, now + 2, present ? [row] : []);
    assert.equal(readLivenessSnapshot(paths)!.tombstones[0].state, "deleted");
    assert.equal(readLivenessSnapshot(paths)!.tombstones[0].generation, 4);
    assert.equal(livenessAdmission(paths, target, "queue", now + 2, undefined, authority), null);
    const accepted = { ...lifecycle("restored", 5, now + 3),
      holder: obs({ present: true, creationIdentity: "accepted-restore-holder" }, "native-holder", now + 3), turn: obs("running" as const, "native-turn", now + 3) };
    const restored = await record(accepted, now + 3);
    assert.equal(restored[0].state, "running");
    assert.equal(readLivenessSnapshot(paths)!.tombstones[0].state, "restored");
    assert.equal(readLivenessSnapshot(paths)!.tombstones[0].generation, 5);
    assert.ok(livenessAdmission(paths, target, "queue", now + 3, undefined, authority));
  });
});
