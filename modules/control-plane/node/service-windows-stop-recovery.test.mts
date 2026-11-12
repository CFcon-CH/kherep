// #838 A3 end to end: the Windows stop classification drives the existing #472/#677 transaction. A stop that failed
// with positive pre-effect evidence ends restored with the drain released, the old daemon untouched; a timeout or a
// failure after effects may have begun still ends unknown with the drain kept (regression guard for #677).
import assert from "node:assert/strict";
import fs from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";
import test from "node:test";

import { safeServiceFailure } from "./service-cli.mts";
import { caught, drainFile, type Harness } from "./service-candidate-fixture.mts";
import { windowsManagedAction } from "./service-definitions.mts";
import { WindowsServiceAdapter, type WindowsStopInvoke } from "./service-platform-windows.mts";
import { activateManagedService, rollbackManagedService } from "./service-transaction.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import { stopNotIssued } from "./service-transaction-support.mts";
import { STOP_REPORT_STATUS, nativeCallFailure } from "./service-windows-invoke.mts";

const result = (value: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> =>
  ({ pid: 1, output: [], stdout: "", stderr: "", status: null, signal: null, ...value }) as SpawnSyncReturns<string>;
const TIMEOUT = result({ error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) });
const report = (phase: string, reason: string) =>
  result({ status: STOP_REPORT_STATUS, stdout: JSON.stringify({ ok: false, phase, reason, hresult: -2146233087 }) });

// The fake world's stop is replaced by the real Windows stop over the seam; reads come from the fake world.
function windowsStop(h: Harness, seam: WindowsStopInvoke, failRead = false): void {
  const real = new WindowsServiceAdapter(seam);
  real.read = async (binding) => {
    if (failRead) throw nativeCallFailure("task-read", TIMEOUT, 60_000, 30_000);
    return { ...(await h.adapter.read())!, windows: { actions: [windowsManagedAction(binding)] } as any };
  };
  real.validateManaged = async () => {};
  h.adapter.stop = async (binding, expected) => { h.adapter.events.push("stop"); return real.stop(binding, expected); };
}
const throwing = (value: SpawnSyncReturns<string>): WindowsStopInvoke => (call, _script, _payload, timeout) => {
  throw nativeCallFailure(call, value, 5, timeout ?? 30_000);
};

async function managed(t: test.TestContext, verb: "upgrade" | "rollback"): Promise<Harness> {
  const h = setup(t);
  seedManaged(h);
  if (verb === "rollback") await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.events.length = 0;
  return h;
}
const run = (h: Harness, verb: "upgrade" | "rollback") => verb === "upgrade"
  ? activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps) : rollbackManagedService({ binding: h.candidate }, h.deps);

const PRE_EFFECT: Array<[string, (h: Harness) => void, string]> = [
  ["F2 before the stop script is spawned", h => windowsStop(h, () => { throw new Error("must not run"); }, true), "STOP_NATIVE_REFUSED"],
  ["F3 pre-effect descendant report", h => windowsStop(h, throwing(report("pre-effect", "descendants-busy"))), "STOP_BLOCKED_NATIVE_DESCENDANTS"],
  ["F3 pre-effect identity report", h => windowsStop(h, throwing(report("pre-effect", "supervisor-owner"))), "STOP_IDENTITY_MISMATCH"],
];
const EFFECTS: Array<[string, (h: Harness) => void, string]> = [
  ["F4 timeout of the mutating stop", h => windowsStop(h, throwing(TIMEOUT)), "STOP_UNPROVEN_TIMEOUT"],
  ["F4 effects-possible report", h => windowsStop(h, throwing(report("effects-possible", "daemon-exit"))), "STOP_NATIVE_REFUSED"],
  ["F4 family unproven after the native stop", h => windowsStop(h, throwing(report("effects-possible", "family-unproven"))), "STOP_UNKNOWN_DESCENDANTS"],
  ["F4 malformed proof", h => windowsStop(h, () => "not json"), "STOP_NATIVE_REFUSED"],
];

for (const verb of ["upgrade", "rollback"] as const) {
  for (const [name, arrange, stopCode] of PRE_EFFECT) {
    test(`${verb}, ${name}: restored, drain released, the running daemon untouched`, async (t) => {
      const h = await managed(t, verb);
      const before = h.adapter.snapshot!.definition.toString();
      arrange(h);
      const failure = await caught(run(h, verb));
      assert.equal(failure.stage, "stop");
      assert.equal(failure.recovery, "restored");
      assert.equal(failure.stopCode, stopCode);
      assert.equal(fs.existsSync(drainFile(h)), false, "the drain is released");
      assert.equal(h.adapter.snapshot!.running, true);
      assert.equal(h.adapter.snapshot!.definition.toString(), before, "nothing was written");
      assert.equal(h.adapter.events.some(event => event.startsWith("write:") || event.startsWith("start:")), false);
      const printed = safeServiceFailure(failure)!;
      assert.equal(printed.native?.call, name.startsWith("F2") ? "task-read" : "task-stop");
      assert.equal((failure as unknown as { drainRetained?: boolean }).drainRetained, false);
    });
  }
  for (const [name, arrange, stopCode] of EFFECTS) {
    test(`${verb}, ${name}: recovery unknown with the drain kept (#677 regression guard)`, async (t) => {
      const h = await managed(t, verb);
      arrange(h);
      const failure = await caught(run(h, verb));
      assert.equal(failure.stage, "stop");
      assert.equal(failure.recovery, "unknown");
      assert.equal(failure.blocker, "RECOVERY_ABSENCE_UNPROVEN");
      assert.equal(failure.stopCode, stopCode);
      assert.equal(fs.existsSync(drainFile(h)), true, "the drain is kept");
      assert.equal(h.adapter.events.some(event => event.startsWith("write:") || event.startsWith("start:")), false, "nothing written or started");
      assert.equal(safeServiceFailure(failure)!.native?.call, "task-stop");
      assert.equal((failure as unknown as { drainRetained?: boolean }).drainRetained, true);
    });
  }
}

test("stopNotIssued: STOP_NOT_ISSUED as before, or an allowlisted code with notIssued true and a proven family, at the stop stage only", () => {
  const tagged = (value: Record<string, unknown>) => Object.assign(new Error("x"), value);
  assert.equal(stopNotIssued("stop", tagged({ code: "STOP_NOT_ISSUED" })), true, "the macOS tag is unchanged");
  assert.equal(stopNotIssued("stop", tagged({ code: "STOP_NATIVE_REFUSED", notIssued: true, familyUnproven: false })), true);
  for (const value of [{ code: "STOP_NATIVE_REFUSED", notIssued: true, familyUnproven: true }, { code: "STOP_NATIVE_REFUSED", notIssued: "true" },
    { code: "STOP_X", notIssued: true }, { code: "STOP_NATIVE_REFUSED" }, { notIssued: true }]) {
    assert.equal(stopNotIssued("stop", tagged(value)), false, JSON.stringify(value));
  }
  assert.equal(stopNotIssued("prove-stopped", tagged({ code: "STOP_NATIVE_REFUSED", notIssued: true })), false);
  assert.equal(stopNotIssued("stop", null), false);
});
