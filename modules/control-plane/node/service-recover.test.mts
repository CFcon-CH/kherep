// #810 stage B: `kherep-node service recover`. Evidence without --confirm writes and starts nothing; --confirm is the strict
// subset of upgrade to the installed commit, and refuses every state upgrade's gates do not prove.
import assert from "node:assert/strict";
import test from "node:test";

import { safeServiceFailure } from "./service-cli.mts";
import { describeServiceDrain } from "./service-drain.mts";
import { snapshotDigests, writeServiceCandidate } from "./service-records.mts";
import { recoverManagedService, RECOVER_REFUSALS } from "./service-recover.mts";
import { drainExists, effects, evidence, harness, permitExists, serviceFiles, type Harness } from "./service-recover-fixture.mts";

test("attempt-1 end state (task stopped, daemon dead, stale drain): evidence plans, --confirm starts and releases the drain", async (t) => {
  const h = harness(t, { running: false, daemonAlive: false, drain: "stale", disconnected: true });
  const before = serviceFiles(h);
  const view = (await evidence(h)).view;
  assert.deepEqual(serviceFiles(h), before, "evidence writes nothing");
  assert.deepEqual(effects(h), []);
  assert.equal(view.canRecover, true);
  assert.equal(view.node, "off");
  assert.equal(view.drain, "stale");
  assert.deepEqual(view.plan, ["reclaim-drain", "start", "health", "release-drain"]);
  const result = await recoverManagedService(h.deps);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.view.done, ["reclaim-drain", "start", "release-drain"]);
  assert.deepEqual(result.view.final, { running: true, node: "running", drain: "none" });
  assert.deepEqual(effects(h), ["start"], "no stop, no write: the receipt's definition is started as it is");
  assert.equal(h.adapter.preflightCalls.every(call => call.expected === undefined), true, "the stopped-task absence check ran");
  assert.equal(drainExists(h), false);
  assert.equal(permitExists(h), false, "the permit is cleared");
});

test("attempt-2 end state (task stopped, daemon dead, no drain): --confirm starts and leaves no drain", async (t) => {
  const h = harness(t, { running: false, daemonAlive: false, drain: "none" });
  assert.deepEqual((await evidence(h)).view.plan, ["start", "health", "release-drain"]);
  const result = await recoverManagedService(h.deps);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.view.done, ["start", "release-drain"]);
  assert.equal(drainExists(h), false);
});

test("#755 shape (task running, supervisor waiting, daemon dead, stale drain): proof-carrying stop, then start", async (t) => {
  const h = harness(t, { running: true, daemonAlive: false, drain: "stale", disconnected: true });
  const view = (await evidence(h)).view;
  assert.equal(view.canRecover, true);
  assert.equal(view.daemon, "dead");
  assert.deepEqual(view.plan, ["reclaim-drain", "stop", "start", "health", "release-drain"]);
  const result = await recoverManagedService(h.deps);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.view.done, ["reclaim-drain", "stop", "start", "release-drain"]);
  assert.deepEqual(effects(h), ["stop", "start"]);
  assert.deepEqual(h.adapter.stopCalls.map(call => call.expected?.pid), [41], "the stop carries the recorded daemon's context");
  assert.deepEqual(h.adapter.preflightCalls.map(call => call.expected?.pid), [41, 41, undefined],
    "preflight and ownership with the context, then the stopped-task absence check before the start");
  assert.equal(drainExists(h), false);
});

test("a drain-blocked node (live owned daemon, stale drain) is stopped through the proven path and restarted", async (t) => {
  const h = harness(t, { running: true, daemonAlive: true, drain: "stale" });
  const view = (await evidence(h)).view;
  assert.equal(view.node, "drain-blocked");
  assert.equal(view.ownership, "match");
  const result = await recoverManagedService(h.deps);
  assert.equal(result.recovered, true);
  assert.deepEqual(effects(h), ["stop", "start"]);
  assert.equal(drainExists(h), false);
});

const refusals: Array<[string, Parameters<typeof harness>[1], (h: Harness) => void, keyof typeof RECOVER_REFUSALS]> = [
  ["definition drift (#746 shape)", { running: false, daemonAlive: false, drain: "stale" },
    h => { h.adapter.snapshot!.definition = Buffer.from("DRIFTED_XML"); }, "DEFINITION_DRIFT"],
  ["a recorded candidate in place", { running: false, daemonAlive: false, drain: "stale" }, h => {
    h.adapter.snapshot!.definition = Buffer.from("RAW_NEW_XML");
    writeServiceCandidate(h.paths, { version: 2, phase: "attested", preparedAt: "2026-10-14T10:59:00.000Z", binding: h.old,
      ...snapshotDigests(h.adapter.snapshot!), command: "install" });
  }, "CANDIDATE_IN_PLACE"],
  ["an active drain", { running: false, daemonAlive: false, drain: "active" }, () => {}, "DRAIN_ACTIVE"],
  ["an unknown drain owner", { running: false, daemonAlive: false, drain: "unknown" }, () => {}, "DRAIN_UNKNOWN"],
  ["a live daemon outside the stopped task", { running: false, daemonAlive: true, drain: "stale" }, () => {}, "DAEMON_OUTLIVED"],
  ["a live daemon the task does not own", { running: true, daemonAlive: true, drain: "stale" }, h => { h.adapter.owned = false; }, "DAEMON_NOT_OWNED"],
  ["a live disconnected daemon", { running: true, daemonAlive: true, drain: "stale", disconnected: true }, () => {}, "DAEMON_NOT_OWNED"],
  ["a running task without a recorded daemon", { running: true, daemonAlive: false, drain: "stale" }, h => { h.adapter.state = null; }, "DAEMON_UNRECORDED"],
  ["a recorded daemon of another source", { running: true, daemonAlive: false, drain: "stale" },
    h => { h.adapter.state = { ...h.adapter.state!, source: h.candidate.source }; }, "DAEMON_MISMATCH"],
  ["an unknown running state", { running: false, daemonAlive: false, drain: "stale" }, h => { h.adapter.snapshot!.running = "unknown"; }, "RUNNING_UNKNOWN"],
  ["a missing definition", { running: false, daemonAlive: false, drain: "stale" }, h => { h.adapter.snapshot = null; }, "DEFINITION_MISSING"],
  ["an unreadable definition", { running: false, daemonAlive: false, drain: "stale" },
    h => { h.adapter.read = async () => { throw new Error("native read failed"); }; }, "DEFINITION_UNATTESTED"],
  ["an invalid managed definition", { running: false, daemonAlive: false, drain: "stale" }, h => { h.adapter.rejectExistingValidation = true; }, "DEFINITION_INVALID"],
  ["an unverifiable source pin", { running: false, daemonAlive: false, drain: "stale" }, h => { h.setSourceValid(false); }, "SOURCE_UNVERIFIED"],
  ["a running node without a drain", { running: true, daemonAlive: true, drain: "none" }, () => {}, "NODE_RUNNING"],
];
for (const [name, options, arrange, reason] of refusals) {
  test(`recover refuses ${name} with ${reason}, with and without --confirm, and touches nothing`, async (t) => {
    const h = harness(t, options);
    arrange(h);
    const drainBefore = describeServiceDrain(h.paths, h.deps.ownerProbe);
    const before = serviceFiles(h);
    const view = (await evidence(h)).view;
    assert.equal(view.canRecover, false);
    assert.equal(view.reason, reason);
    assert.equal(view.detail, RECOVER_REFUSALS[reason]);
    assert.equal("plan" in view, false);
    const confirmed = await recoverManagedService(h.deps);
    assert.equal(confirmed.recovered, false);
    assert.equal(confirmed.view.reason, reason);
    assert.deepEqual(confirmed.view.done, []);
    assert.deepEqual(effects(h), [], "nothing stopped, written or started");
    assert.deepEqual(serviceFiles(h), before, "no record, drain or permit changed");
    assert.equal(describeServiceDrain(h.paths, h.deps.ownerProbe), drainBefore);
  });
}

test("the #746 shape names rollback in its refusal, never a hand-moved drain", () => {
  assert.match(RECOVER_REFUSALS.DEFINITION_DRIFT, /service rollback/);
  for (const text of Object.values(RECOVER_REFUSALS)) assert.doesNotMatch(text, /move|rename|delete/i);
});

test("a failure before any native effect leaves the drain as found: a stale drain stays held, none stays none", async (t) => {
  for (const drain of ["stale", "none"] as const) {
    const h = harness(t, { running: false, daemonAlive: false, drain });
    h.adapter.descendants = 1; // the stopped-task preflight refuses before any effect
    await assert.rejects(recoverManagedService(h.deps), /STOP_BLOCKED_NATIVE_DESCENDANTS/);
    assert.deepEqual(effects(h), []);
    assert.equal(drainExists(h), drain === "stale", `drain ${drain}`);
  }
});

test("a stop refused before its effect counts as not issued; the drain is not retained beyond how it was found", async (t) => {
  const h = harness(t, { running: true, daemonAlive: false, drain: "none" });
  h.adapter.failStopBeforeEffect = true;
  await assert.rejects(recoverManagedService(h.deps), /synthetic stop failure before effect/);
  assert.equal(drainExists(h), false);
});

test("a failure after a native effect keeps the drain and reports a fixed SERVICE_RECOVER_FAILED", async (t) => {
  const h = harness(t, { running: true, daemonAlive: false, drain: "stale" });
  h.startFails();
  const error = await recoverManagedService(h.deps).then(() => null, (cause: unknown) => cause);
  const failure = safeServiceFailure(error);
  assert.deepEqual(failure, { ok: false, code: "SERVICE_RECOVER_FAILED", recovery: "unknown", stage: "start" });
  assert.deepEqual(effects(h), ["stop", "start"]);
  assert.equal(drainExists(h), true, "after an effect nothing is released");
  assert.equal(permitExists(h), false);
  assert.equal((error as { drainRetained?: boolean }).drainRetained, true);
});

test("a stop that leaves its daemon family unproven keeps the drain and starts nothing", async (t) => {
  const h = harness(t, { running: true, daemonAlive: true, drain: "stale" });
  h.adapter.stopFailureAfterEffect = Object.assign(new Error("Windows stop proof is incomplete"), { code: "STOP_NATIVE_REFUSED", familyUnproven: true });
  const error = await recoverManagedService(h.deps).then(() => null, (cause: unknown) => cause);
  assert.deepEqual(safeServiceFailure(error), { ok: false, code: "SERVICE_RECOVER_FAILED", recovery: "unknown", stage: "stop",
    stopCode: "STOP_NATIVE_REFUSED" });
  assert.deepEqual(effects(h), ["stop"]);
  assert.equal(drainExists(h), true);
});
