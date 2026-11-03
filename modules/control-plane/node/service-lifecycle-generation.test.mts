import assert from "node:assert/strict";
import test from "node:test";
import { activateManagedService } from "./service-transaction.mts";
import { readServiceCandidate, readServiceReceipt } from "./service-records.mts";
import { assertSettled } from "./service-transaction-support.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import type { ServiceCandidate } from "./service-records.mts";

test("a proven old stop permits reused PID with a new startedAt and owned candidate", async t => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.candidatePid = 41;
  const stop = h.adapter.stop.bind(h.adapter);
  h.adapter.stop = async (binding, expected) => {
    await stop(binding, expected);
    h.adapter.oldPidAlive = false;
  };
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  assert.equal(readServiceReceipt(h.paths)?.binding.source.commit, h.candidate.source.commit);
  assert.equal(h.adapter.state?.pid, 41);
  assert.equal(h.adapter.state?.startedAt, "2026-10-14T11:00:00.000Z");
});

test("failed candidate health retains an exact attested prestart record when the candidate stays loaded", async t => {
  const h = setup(t);
  seedManaged(h);
  const receipt = readServiceReceipt(h.paths);
  h.adapter.candidatePid = 41;
  h.adapter.failCandidateHealth = true;
  h.adapter.failCandidateRecoveryStop = true;
  const stop = h.adapter.stop.bind(h.adapter);
  h.adapter.stop = async (binding, expected) => {
    await stop(binding, expected);
    h.adapter.oldPidAlive = false;
  };
  let beforeStart: ServiceCandidate | null = null;
  const start = h.adapter.start.bind(h.adapter);
  h.adapter.start = async binding => {
    beforeStart = readServiceCandidate(h.paths);
    await start(binding);
  };
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps),
    (error: Error & { blocker?: string; stage?: string }) => error.blocker === "RECOVERY_CANDIDATE_LOADED" && error.stage === "health");
  assert.ok(beforeStart, "candidate is persisted before the native start");
  const record = readServiceCandidate(h.paths)!;
  assert.equal(record.phase, "attested");
  assert.equal(record.binding.source.commit, h.candidate.source.commit);
  assert.equal(record.binding.supervisorGeneration, (beforeStart as ServiceCandidate).binding.supervisorGeneration);
  assert.equal(record.backupId, (beforeStart as ServiceCandidate).backupId);
  assert.ok(record.backupId);
  assert.deepEqual(readServiceReceipt(h.paths), receipt);
  assert.equal(h.adapter.events.includes("write:MANAGED_OLD_XML"), false);
});

test("settle rejects a daemon record whose PID was reused after the health read", async t => {
  const h = setup(t);
  const daemon = { ...h.adapter.state! };
  h.adapter.state = { ...daemon, startedAt: "2026-10-14T12:00:00.000Z" };
  await assert.rejects(assertSettled(h.deps, h.old, h.adapter.snapshot!, daemon, true), /recorded daemon/);
});
