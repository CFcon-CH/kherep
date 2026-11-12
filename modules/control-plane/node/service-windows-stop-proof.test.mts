import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { WindowsServiceAdapter, powerShellInvocation } from "./service-platform-windows.mts";
import * as nativeScripts from "./service-platform-windows-process.mts";
import { windowsManagedAction } from "./service-definitions.mts";
import { setup } from "./service-transaction-fixture.mts";
import type { ServiceStopContext } from "./service-types.mts";

function adapterFor(t: test.TestContext, output: (expected: ServiceStopContext) => unknown) {
  const h = setup(t), expected = { pid: 41, startedAt: h.adapter.state!.startedAt };
  const call = (_call: string, _script: string, payload: any) => JSON.stringify(output(payload.expected));
  const adapter = new WindowsServiceAdapter(call);
  adapter.read = async () => ({ ...h.adapter.snapshot!, windows: { actions: [windowsManagedAction(h.old)] } as any });
  adapter.validateManaged = async () => {};
  const proof = { alive: () => true, clock: { now: () => 0, sleep: async () => {} }, deadline: 100 };
  return { h, expected, adapter, proof };
}
const complete = (expected: ServiceStopContext) => ({ version: 1, stopped: true, daemonExited: true,
  supervisorExited: true, familyAbsent: true, expected });

test("Windows stop attestation consumes one matching instance proof without PID-only polling", async t => {
  const f = adapterFor(t, complete);
  assert.equal(typeof f.adapter.proveStopped, "function");
  await f.adapter.stop(f.h.old, f.expected);
  await f.adapter.proveStopped!(f.h.old, f.expected, f.proof);
  await assert.rejects(f.adapter.proveStopped!(f.h.old, f.expected, f.proof), /proof/);
});

for (const field of ["supervisorExited", "daemonExited", "familyAbsent"] as const) {
  test(`Windows refuses an unproven ${field} response`, async t => {
    const f = adapterFor(t, expected => ({ ...complete(expected), [field]: false }));
    assert.equal(typeof f.adapter.proveStopped, "function");
    await assert.rejects(f.adapter.stop(f.h.old, f.expected), /proof/);
  });
}

test("Windows stop proof rejects different generation and same-PID different start", async t => {
  const f = adapterFor(t, complete);
  assert.equal(typeof f.adapter.proveStopped, "function");
  await f.adapter.stop(f.h.old, f.expected);
  await assert.rejects(f.adapter.proveStopped!({ ...f.h.old, supervisorGeneration: f.h.candidate.supervisorGeneration + "x" }, f.expected, f.proof), /proof/);
  await f.adapter.stop(f.h.old, f.expected);
  await assert.rejects(f.adapter.proveStopped!(f.h.old, { ...f.expected, startedAt: "2026-10-14T12:00:00.000Z" }, f.proof), /proof/);
});

for (const scenario of ["surviving-supervisor", "reused-pid", "unknown-family"] as const) {
  test(`native final proof with synthetic handles: ${scenario}`, { skip: process.platform !== "win32" }, t => {
    const helper = (nativeScripts as unknown as Record<string, unknown>).WINDOWS_FINAL_STOP_PROOF_SCRIPT;
    assert.equal(typeof helper, "string", "native final proof must have a directly testable, mutation-free seam");
    const invocation = powerShellInvocation(`${helper}
      $script:probes=0;$script:unrelatedPidAlive=$true
      $supervisor=[pscustomobject]@{HasExited=${scenario === "surviving-supervisor" ? "$false" : "$true"}}
      $daemon=[pscustomobject]@{HasExited=$true};$expected=[pscustomobject]@{pid=41;startedAt='2026-10-14T10:00:00.000Z'}
      function Get-Process{throw 'PID-only observation is forbidden'}
      function Stop-Process{throw 'PID-only termination is forbidden'}
      try{$proof=Complete-KherepStopProof $supervisor $daemon {$script:probes++;'${scenario === "unknown-family" ? "unknown" : "clear"}'} $expected
        @{failed=$false;proof=($proof|ConvertFrom-Json);probes=$script:probes;unrelatedAlive=$script:unrelatedPidAlive}|ConvertTo-Json -Depth 4 -Compress
      }catch{@{failed=$true;probes=$script:probes;unrelatedAlive=$script:unrelatedPidAlive}|ConvertTo-Json -Compress}`, {});
    const startedAt = new Date().toISOString();
    const result = spawnSync(invocation.executable, invocation.args, { input: invocation.input, env: invocation.env,
      encoding: "utf8", windowsHide: true, timeout: 30_000 });
    t.diagnostic(JSON.stringify({ syntheticChild: "powershell", pid: result.pid, startedAt, closedAt: new Date().toISOString(), exit: result.status, signal: result.signal }));
    assert.equal(result.status, 0, "synthetic proof harness exits cleanly");
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.failed, scenario !== "reused-pid");
    assert.equal(observed.unrelatedAlive, true);
    assert.equal(observed.probes, scenario === "surviving-supervisor" ? 0 : 1);
    if (scenario === "reused-pid") assert.deepEqual(observed.proof, complete({ pid: 41, startedAt: "2026-10-14T10:00:00.000Z" }));
  });
}
