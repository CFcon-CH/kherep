import { createAdmissionAuthority, authorityStatus } from "./session-authority.mts";
import { syntheticListing, publishSynthetic } from "./session-authority-fixture.mts";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodePaths } from "./config.mts";
import { attachLiveness } from "./liveness-pass.mts";
import { recordingSessions } from "./exchange-sessions.mts";
import { markUnseen, readKnownSessions, rememberSessions, unlistedRuntimes } from "./known-sessions.mts";
import { normalizedState, type Observation, type SessionEvidence } from "./session-liveness.mts";
import { readLivenessSnapshot, sessionVerdict, livenessAdmission, publishLiveness } from "./session-lifecycle.mts";
import { rememberMode, takeTurn } from "./autonomy.mts";
import { closedNode, deliver, SESSION } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { getMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";
const obs = <T,>(value: T, source: Observation<T>["source"], at: number): Observation<T> =>
  ({ status: "value", value, source, observedAt: at, complete: true, reasonCode: "observed" });
const target = { runtime: "claude-code", sessionId: SESSION };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-review-706-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}
const closed = (at: number): SessionEvidence => ({ ...target,
  app: obs("absent", "native-app", at), holder: obs({ present: false }, "native-holder", at) });

test("R1 raw-present archived rows reset the baseline miss veto before restored CLOSED fallback", async (t) => {
  const node = closedNode(t);
  const row = { ...target, state: "idle", name: "review", cwd: node.workspace };
  rememberSessions(node.paths, [row], T0 - 180_000);
  let clock = T0 - 180_000;
  for (let i = 0; i < 3; i++, clock += 60_000) {
    const listed = attachLiveness([row], obs([{ ...target, lifecycle: obs({ state: "archived", generation: 1 }, "native-lifecycle", clock) }], "native-app", clock));
    assert.deepEqual(await recordingSessions(node.paths, async () => syntheticListing(node.livenessAuthority, [row], [{ ...target, lifecycle: obs({ state: "archived", generation: 1 }, "native-lifecycle", clock) }], clock), () => {}, () => clock, undefined, undefined, node.livenessAuthority)(), []);
  }
  assert.equal(readKnownSessions(node.paths).find(s => s.sessionId === SESSION)?.misses, undefined,
    "raw presence cannot become a miss just because publication excludes archive");
  rememberMode(node.paths, SESSION, "auto");
  const id = deliver(node);
  for (let misses = 1; misses <= 3; misses++) {
    const evidence = { ...closed(clock), lifecycle: obs({ state: "restored" as const, generation: 2 }, "native-lifecycle", clock) };
    await recordingSessions(node.paths, async () => syntheticListing(node.livenessAuthority, [], [evidence], clock), () => {}, () => clock, undefined, undefined, node.livenessAuthority)();
    assert.equal(readKnownSessions(node.paths).find(s => s.sessionId === SESSION)?.misses, misses);
    await deliverToClosed(node.deps());
    assert.equal(node.calls.filter(c => c.args[0] !== "agents").length, misses === 3 ? 1 : 0);
    if (misses < 3) {
      assert.equal(getMessage(node.paths.inbox, id)?.closedAttempt, undefined);
      assert.equal(takeTurn(node.paths, SESSION, clock), "ok", "ineligible fallback did not spend a turn");
      node.tick(60_000); clock += 60_000;
    }
  }
});

test("R3 partial runtime listing retains UNKNOWN rows despite a complete metadata envelope", async (t) => {
  for (const unseen of [["claude-code"], ["*"], []]) await t.test(unseen[0] ?? "complete-envelope-unknown-target", async sub => {
    const paths = fixture(sub);
    const authority = createAdmissionAuthority(paths);
    const at = T0;
    const row = { ...target, state: "running" };
    const other = { runtime: "codex", sessionId: "other-full-id", state: "running" };
    const otherEvidence = (when: number): SessionEvidence => ({ ...other,
      holder: obs({ present: true, creationIdentity: "other-created-1" }, "native-holder", when), turn: obs("running", "native-turn", when) });
    const initial = { ...target, holder: obs({ present: true, creationIdentity: "created-1" }, "native-holder", at), turn: obs("running" as const, "native-turn", at) };
    await recordingSessions(paths, async () => syntheticListing(authority, [row, other], [initial, otherEvidence(at)], at), () => {}, () => at, undefined, undefined, authority)();
    const partial = markUnseen([other], unseen);
    const reasonCode = unseen.includes("*") ? "capped" as const : unseen.length ? "failed" as const : "unsupported" as const;
    const unknown: SessionEvidence = { ...target, app: { status: "unknown", observedAt: at + 1, complete: false, source: "native-app", reasonCode } };
    const rows = await recordingSessions(paths, async () => syntheticListing(authority, partial, [unknown, otherEvidence(at + 1)], at + 1), () => {}, () => at + 1, undefined, undefined, authority)();
    assert.equal(rows.length, 2);
    const retained = rows.find(s => s.sessionId === SESSION)!;
    assert.equal(retained.runtime, "claude-code");
    assert.equal(retained.state, "unknown");
    assert.equal(sessionVerdict(paths, target, at + 1).reasonCode, reasonCode);
    assert.equal(rows.find(s => s.runtime === "codex")?.state, "running");
    assert.deepEqual(unlistedRuntimes(rows), unseen);
    assert.equal(livenessAdmission(paths, target, "queue", at + 1), null);
    const terminal = { ...target, lifecycle: obs({ state: "deleted" as const, generation: 1 }, "native-lifecycle", at + 2) };
    const after = await recordingSessions(paths, async () => syntheticListing(authority, markUnseen([other], unseen), [terminal, otherEvidence(at + 2)], at + 2), () => {}, () => at + 2, undefined, undefined, authority)();
    assert.deepEqual(after.map(s => s.sessionId), [other.sessionId]);
    assert.equal(sessionVerdict(paths, target, at + 2).state, "deleted");
  });
});

test("R4 legacy remote Codex task idle stays unknown while normalized evidence-backed state survives", () => {
  for (const kind of ["codex-task", "codex-intercom"]) {
    const source = { runtime: "codex", sessionId: "full-source-id", kind, state: "idle" };
    assert.equal(normalizedState(source.state, source), "unknown");
    assert.equal(normalizedState("idle-loaded", source), "idle-loaded");
    assert.deepEqual(source, { runtime: "codex", sessionId: "full-source-id", kind, state: "idle" });
  }
  assert.equal(normalizedState("idle", { runtime: "claude-code", kind: "interactive" }), "idle-loaded");
});

test("R2 lifetime nonterminal churn beyond 512 remains publishable after restart with UNKNOWN eviction", async (t) => {
  const paths = fixture(t);
  for (let i = 0; i < 513; i++) publishLiveness(paths, [{ runtime: "codex", sessionId: `churn-${i}` }], T0 + i);
  const newest = { runtime: "codex", sessionId: "churn-512", state: "active" };
  // A newly constructed wrapper represents restart; the default unsupported
  // adapter is represented by no attached native metadata, never a real probe.
  const rows = await recordingSessions(paths, async () => [newest], () => {}, () => T0 + 514)();
  assert.ok(rows.some(s => s.sessionId === newest.sessionId));
  assert.ok(rows.length <= 512);
  assert.equal(sessionVerdict(paths, { runtime: "codex", sessionId: "churn-0" }, T0 + 514).state, "unknown");
  assert.equal(livenessAdmission(paths, { runtime: "codex", sessionId: "churn-0" }, "queue", T0 + 514), null);
  assert.ok(readLivenessSnapshot(paths)!.sessions.length <= 512);
  const currentEvidence: SessionEvidence = { ...newest, holder: obs({ present: true, creationIdentity: "after-churn" }, "native-holder", T0 + 515), turn: obs("running", "native-turn", T0 + 515) };
  const currentRun = publishSynthetic(paths, [currentEvidence], T0 + 515, [{ ...newest, state: "running" }]);
  assert.ok(livenessAdmission(paths, newest, "queue", T0 + 515, undefined, currentRun), "current proven identity survives historical eviction");
  assert.equal(readLivenessSnapshot(paths)!.tombstones.length, 0, "ordinary churn consumes no lifecycle slots");
});

test("R2 failed new-terminal write cannot recover the older permissive generation on restart", async (t) => {
  const paths = fixture(t), at = T0;
  const authority = createAdmissionAuthority(paths);
  const running: SessionEvidence = { ...target, holder: obs({ present: true, creationIdentity: "created-before-failure" }, "native-holder", at), turn: obs("running", "native-turn", at) };
  const record = (e: SessionEvidence, when: number) => recordingSessions(paths,
    async () => syntheticListing(authority, [{ ...target, state: "running" }], [e], when), () => {}, () => when, undefined, undefined, authority)();
  await record(running, at);
  assert.ok(livenessAdmission(paths, target, "queue", at, undefined, authority));
  const old = [fs.readFileSync(paths.sessions), fs.readFileSync(path.join(paths.dir, "session-liveness.json"))];
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    if (String(args[1]).endsWith("session-liveness.json")) throw new Error("synthetic durable-write failure");
    return Reflect.apply(rename, fs, args);
  });
  await assert.rejects(record({ ...target, lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle", at + 1) }, at + 1), /session publication failed/);
  assert.deepEqual([fs.readFileSync(paths.sessions), fs.readFileSync(path.join(paths.dir, "session-liveness.json"))], old);
  assert.equal(authorityStatus(authority), "faulted");
  let launched = 0;
  for (const context of [authority, createAdmissionAuthority(paths), undefined]) {
    if (livenessAdmission(paths, target, "queue", at + 2, undefined, context) !== null) launched++;
  }
  assert.equal(launched, 0, "a failed durable terminal write must not reuse the old committed authority");
});
