// #677: a stop failure reaches the CLI as one allowlisted stop code on the failure itself, without a candidate record,
// and `service status` names a daemon that outlived its stopped service instead of the stale-drain upgrade text.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runService, safeServiceFailure } from "./service-cli.mts";
import { candidateFile, caught, drainFile, staleDrain, status, type Harness } from "./service-candidate-fixture.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { snapshotDigests, writeServiceReceipt } from "./service-records.mts";
import { activateManagedService, readServiceReceipt, rollbackManagedService } from "./service-transaction.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import { STOP_CODES, stopCode, type ServiceAdapter } from "./service-types.mts";

const RAW = "private native stderr with /Users/x677leak/Library/LaunchAgents/org.kherep.node.plist";
const coded = (code: string, message = RAW) => Object.assign(new Error(message), { code });
const verbs = (h: Harness) => ({
  upgrade: () => activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps),
  rollback: () => rollbackManagedService({ binding: h.candidate }, h.deps),
});
async function managed(t: test.TestContext, verb: "upgrade" | "rollback"): Promise<Harness> {
  const h = setup(t);
  seedManaged(h);
  if (verb === "rollback") await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.events.length = 0;
  return h;
}

test("STOP_UNLISTED_ALIVE is an allowlisted stop code", () => {
  assert.ok((STOP_CODES as readonly string[]).includes("STOP_UNLISTED_ALIVE"));
});

test("stopCode accepts an error.code from STOP_CODES and still ignores foreign codes and near-miss messages", () => {
  for (const code of STOP_CODES) assert.equal(stopCode(coded(code)), code);
  assert.equal(stopCode(coded("STOP_UNLISTED_ALIVE", "managed service verification timed out")), "STOP_UNLISTED_ALIVE");
  assert.equal(stopCode(coded("STOP_NOT_ISSUED", "managed service verification timed out")), "STOP_UNPROVEN_TIMEOUT",
    "a foreign code falls back to the exact-message table");
  for (const other of [coded("STOP_X"), coded("stop_unlisted_alive"), coded(RAW), { code: 7 }, new Error("STOP_UNLISTED_ALIVE"),
    "STOP_UNLISTED_ALIVE", undefined]) assert.equal(stopCode(other), "STOP_FAILED_OTHER");
});

for (const verb of ["upgrade", "rollback"] as const) {
  test(`${verb} whose issued stop fails with a coded STOP_UNLISTED_ALIVE carries the stop code without a candidate record`, async (t) => {
    const h = await managed(t, verb);
    h.adapter.stopFailureAfterEffect = coded("STOP_UNLISTED_ALIVE");
    const failure = await caught(verbs(h)[verb]());
    assert.equal(failure.code, verb === "upgrade" ? "SERVICE_ACTIVATION_FAILED" : "SERVICE_ROLLBACK_FAILED");
    assert.equal(failure.stage, "stop");
    assert.equal(failure.recovery, "unknown");
    assert.equal(failure.stopCode, "STOP_UNLISTED_ALIVE");
    assert.equal(fs.existsSync(candidateFile(h)), false);
  });

  test(`${verb} whose generic prove-stopped timeout fails carries STOP_UNPROVEN_TIMEOUT without a candidate record`, async (t) => {
    const h = await managed(t, verb);
    h.adapter.stopKeepsPidAlive = true;
    const failure = await caught(verbs(h)[verb]());
    assert.equal(failure.stage, "prove-stopped");
    assert.equal(failure.blocker, "RECOVERY_ABSENCE_UNPROVEN");
    assert.equal(failure.stopCode, "STOP_UNPROVEN_TIMEOUT");
    assert.equal(fs.existsSync(candidateFile(h)), false);
    assert.deepEqual(Object.keys(safeServiceFailure(failure)!).sort(), ["blocker", "code", "ok", "recovery", "stage", "stopCode"]);
  });
}

test("a failure outside the stop stages carries no stop code", async (t) => {
  const h = await managed(t, "upgrade");
  h.adapter.failCandidateStart = true;
  const failure = await caught(verbs(h).upgrade());
  assert.equal(failure.stage, "start");
  assert.equal("stopCode" in failure, false);
});

test("service failures pass only an allowlisted stop code", () => {
  const base = { code: "SERVICE_ACTIVATION_FAILED", recovery: "unknown", message: RAW, stage: "prove-stopped", blocker: "RECOVERY_ABSENCE_UNPROVEN" };
  assert.deepEqual(safeServiceFailure({ ...base, stopCode: "STOP_UNLISTED_ALIVE" }), { ok: false, code: "SERVICE_ACTIVATION_FAILED",
    recovery: "unknown", stage: "prove-stopped", blocker: "RECOVERY_ABSENCE_UNPROVEN", stopCode: "STOP_UNLISTED_ALIVE" });
  for (const value of [RAW, "STOP_X", "STOP_NOT_ISSUED", 7, null]) {
    const dropped = safeServiceFailure({ ...base, stopCode: value });
    assert.equal(dropped && "stopCode" in dropped, false, String(value));
    assert.equal(JSON.stringify(dropped).includes("x677leak"), false);
  }
});

test("service rollback reports the stop code through the CLI failure without candidate.json", async (t) => {
  const h = await managed(t, "rollback");
  const root = path.dirname(h.paths.dir);
  fs.writeFileSync(h.paths.config, JSON.stringify({ version: 1, nodeId: crypto.randomUUID() }));
  h.adapter.stopFailureAfterEffect = coded("STOP_UNLISTED_ALIVE");
  const { paths: _paths, adapter: _adapter, ...lifecycle } = h.deps;
  const failure = await caught(runService(["rollback"], { root, adapterFor: () => h.adapter as unknown as ServiceAdapter, lifecycle }));
  const printed = JSON.stringify(safeServiceFailure(failure));
  assert.deepEqual(JSON.parse(printed), { ok: false, code: "SERVICE_ROLLBACK_FAILED", recovery: "unknown", stage: "stop",
    blocker: "RECOVERY_ABSENCE_UNPROVEN", stopCode: "STOP_UNLISTED_ALIVE" });
  assert.equal(printed.includes("x677leak"), false);
  assert.equal(fs.existsSync(candidateFile(h)), false);
});

const UNLISTED = {
  darwin: "the previous daemon is no longer loaded by launchd but its process still runs; upgrade and rollback refuse until it ends; end that process by hand, then run kherep-node service upgrade --source <clean checkout>, see docs/INSTALLATION.md",
  win32: "the Scheduled Task is stopped but its daemon process still runs; upgrade and rollback refuse until it ends; end that process by hand, then run kherep-node service upgrade --source <clean checkout>, see docs/INSTALLATION.md",
};
for (const platform of ["darwin", "win32"] as const) {
  test(`status names a daemon that outlived its stopped ${platform} service and the manual step instead of the stale-drain text`, async (t) => {
    const h = setup(t);
    seedManaged(h);
    if (platform === "darwin") {
      const binding = { ...h.old, platform, taskPath: undefined, logFile: undefined, supervisorGeneration: undefined };
      writeServiceReceipt(h.paths, { version: 1, binding, ...snapshotDigests(h.adapter.snapshot!), activatedAt: "2026-10-14T10:00:02.000Z" });
    }
    h.adapter.snapshot!.running = false;
    delete h.adapter.snapshot!.pid;
    beginServiceDrain(h.paths, h.deps.ownerProbe);
    staleDrain(h);
    const unlisted = await status(h);
    assert.equal(unlisted.report.running, false);
    assert.equal(unlisted.report.drain, "stale");
    assert.equal(unlisted.report.recovery, UNLISTED[platform]);
    assert.equal(unlisted.report.ok, false);
    h.adapter.oldPidAlive = false;
    assert.match((await status(h)).report.recovery, /reclaims the stale drain/, "a dead recorded daemon keeps the reclaim text");
    assert.ok(fs.existsSync(drainFile(h)));
    assert.equal(readServiceReceipt(h.paths)?.binding.platform, platform);
  });
}
