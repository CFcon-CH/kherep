// #838 A2/A3: a failed Windows stop is classified by where it failed. Every row of the design table runs through the
// adapter's stopInvoke seam; the wrapped script is checked by source and, on Windows only, by execution.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";

import { windowsManagedAction } from "./service-definitions.mts";
import { STOP_SCRIPT_REASONS, WINDOWS_STOP_SCRIPT } from "./service-platform-windows-process.mts";
import { WindowsServiceAdapter, powerShellInvocation, type WindowsStopInvoke } from "./service-platform-windows.mts";
import { setup } from "./service-transaction-fixture.mts";
import { STOP_REPORT_STATUS, invokeNative, nativeCallFailure, nativeFailure, stopScriptReport } from "./service-windows-invoke.mts";

const result = (value: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> =>
  ({ pid: 1, output: [], stdout: "", stderr: "", status: null, signal: null, ...value }) as SpawnSyncReturns<string>;
const reported = (phase: string, reason: string) =>
  result({ status: STOP_REPORT_STATUS, stdout: JSON.stringify({ ok: false, phase, reason, hresult: -2146233087 }) });
const throwing = (value: SpawnSyncReturns<string>): WindowsStopInvoke => (call, _script, _payload, timeout) => {
  throw nativeCallFailure(call, value, 5, timeout ?? 30_000);
};

function windows(t: test.TestContext, seam: WindowsStopInvoke) {
  const h = setup(t), expected = { pid: 41, startedAt: h.adapter.state!.startedAt };
  const calls: Array<[string, number | undefined]> = [];
  const adapter = new WindowsServiceAdapter((call, script, payload, timeout) => { calls.push([call, timeout]); return seam(call, script, payload, timeout); });
  adapter.read = async () => ({ ...h.adapter.snapshot!, windows: { actions: [windowsManagedAction(h.old)] } as any });
  adapter.validateManaged = async () => {};
  return { h, expected, adapter, calls };
}
async function stopFailure(t: test.TestContext, seam: WindowsStopInvoke, prepare: (f: ReturnType<typeof windows>) => void = () => {}) {
  const f = windows(t, seam);
  prepare(f);
  try { await f.adapter.stop(f.h.old, f.expected); } catch (error) { return { f, error: error as Error & Record<string, unknown> }; }
  throw new Error("expected a failed stop");
}
const shape = (error: Record<string, unknown>) => ({ code: error.code, familyUnproven: error.familyUnproven, notIssued: error.notIssued });

const ROWS: Array<[string, WindowsStopInvoke, { code: string; familyUnproven: boolean; notIssued: boolean }]> = [
  ["pre-effect, descendant reason", throwing(reported("pre-effect", "descendants-busy")),
    { code: "STOP_BLOCKED_NATIVE_DESCENDANTS", familyUnproven: false, notIssued: true }],
  ["pre-effect, provenance reason", throwing(reported("pre-effect", "supervisor-provenance")),
    { code: "STOP_IDENTITY_MISMATCH", familyUnproven: false, notIssued: true }],
  ["pre-effect, identity reason", throwing(reported("pre-effect", "daemon-identity")),
    { code: "STOP_IDENTITY_MISMATCH", familyUnproven: false, notIssued: true }],
  ["pre-effect, other reason", throwing(reported("pre-effect", "native-error")),
    { code: "STOP_NATIVE_REFUSED", familyUnproven: false, notIssued: true }],
  ["timeout of the mutating stop", throwing(result({ error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) })),
    { code: "STOP_UNPROVEN_TIMEOUT", familyUnproven: true, notIssued: false }],
  ["pre-effect, unknown provenance", throwing(reported("pre-effect", "provenance-unknown")),
    { code: "STOP_UNKNOWN_DESCENDANTS", familyUnproven: true, notIssued: false }],
  ["effects possible, family unproven", throwing(reported("effects-possible", "family-unproven")),
    { code: "STOP_UNKNOWN_DESCENDANTS", familyUnproven: true, notIssued: false }],
  ["effects possible, other reason", throwing(reported("effects-possible", "daemon-exit")),
    { code: "STOP_NATIVE_REFUSED", familyUnproven: true, notIssued: false }],
  ["effects possible, descendant reason", throwing(reported("effects-possible", "descendants-busy")),
    { code: "STOP_NATIVE_REFUSED", familyUnproven: true, notIssued: false }],
  ["exit without a report", throwing(result({ status: 1, stdout: "garbage" })),
    { code: "STOP_NATIVE_REFUSED", familyUnproven: true, notIssued: false }],
  ["spawn error of the stop script", throwing(result({ error: Object.assign(new Error("spawnSync EPERM"), { code: "EPERM" }) })),
    { code: "STOP_NATIVE_REFUSED", familyUnproven: true, notIssued: false }],
  ["malformed proof", () => "not json", { code: "STOP_NATIVE_REFUSED", familyUnproven: true, notIssued: false }],
  ["incomplete proof", () => JSON.stringify({ version: 1, stopped: true }), { code: "STOP_NATIVE_REFUSED", familyUnproven: true, notIssued: false }],
];

for (const [name, seam, expected] of ROWS) {
  test(`Windows stop failure, ${name}: ${expected.code}, familyUnproven ${expected.familyUnproven}, notIssued ${expected.notIssued}`, async (t) => {
    const { f, error } = await stopFailure(t, seam);
    assert.deepEqual(shape(error), expected);
    assert.deepEqual(f.calls, [["task-stop", 65_000]], "one named mutating stop, never repeated");
    assert.equal(nativeFailure(error)?.call, "task-stop");
  });
}

test("Windows stop failure before the script is spawned: STOP_NATIVE_REFUSED, not issued, the call named", async (t) => {
  const { f, error } = await stopFailure(t, () => { throw new Error("stop script must not run"); }, g => {
    g.adapter.read = async () => { throw nativeCallFailure("task-read", result({ error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) }), 60_000, 30_000); };
  });
  assert.deepEqual(shape(error), { code: "STOP_NATIVE_REFUSED", familyUnproven: false, notIssued: true });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(nativeFailure(error), { call: "task-read", outcome: "timeout", elapsedMs: 60_000, timeoutMs: 30_000 });
});

test("the wrapped stop script maps every literal throw, turns effects-possible right before its one native stop, and reports once", () => {
  const thrown = new Set([...WINDOWS_STOP_SCRIPT.matchAll(/throw '([^']+)'/g)].map(match => match[1]));
  const mapped = new Map(STOP_SCRIPT_REASONS);
  for (const message of thrown) assert.ok(mapped.has(message), `unmapped throw: ${message}`);
  for (const [message, reason] of STOP_SCRIPT_REASONS) {
    assert.ok(thrown.has(message), `stale reason entry: ${message}`);
    assert.match(reason, /^[a-z][a-z-]{1,39}$/);
  }
  assert.ok(WINDOWS_STOP_SCRIPT.startsWith("$kherepReasons=@("));
  assert.equal((WINDOWS_STOP_SCRIPT.match(/\$kherepStopPhase='pre-effect'/g) ?? []).length, 1);
  assert.equal((WINDOWS_STOP_SCRIPT.match(/\$kherepStopPhase='effects-possible'/g) ?? []).length, 1);
  assert.match(WINDOWS_STOP_SCRIPT, /\$kherepStopPhase='effects-possible'\n {2}Stop-ScheduledTask /);
  assert.ok(WINDOWS_STOP_SCRIPT.indexOf("$kherepStopPhase='pre-effect';try{") < WINDOWS_STOP_SCRIPT.indexOf("Add-Type"));
  assert.ok(WINDOWS_STOP_SCRIPT.endsWith(`|ConvertTo-Json -Compress;exit ${STOP_REPORT_STATUS}}`));
  assert.equal((WINDOWS_STOP_SCRIPT.match(/\}catch\{\$kherepMessage=/g) ?? []).length, 1);
  assert.doesNotMatch(WINDOWS_STOP_SCRIPT.slice(WINDOWS_STOP_SCRIPT.lastIndexOf("}catch{$kherepMessage=")), /StackTrace|ScriptStackTrace|InvocationInfo|\$_\.ToString/);
});

const syntheticPayload = { serviceName: "KherepSynthetic838Missing", taskPath: "\\KherepSynthetic838Missing\\", checkOnly: false,
  action: { executable: "x", arguments: "", workingDirectory: "" }, wrapper: { executable: "x", argv: ["x"] },
  daemon: { executable: "x", argv: ["x"] }, definition: "", security: "", expected: { pid: 41, startedAt: "2026-10-14T10:00:00.000Z" } };

test("win32: the wrapped stop script reports pre-effect for an early native failure", { skip: process.platform !== "win32" && "win32-only" }, () => {
  let error: unknown;
  try { invokeNative("task-stop", WINDOWS_STOP_SCRIPT, syntheticPayload, 65_000); } catch (caught) { error = caught; }
  assert.ok(error, "a missing synthetic task fails before any effect");
  assert.equal(nativeFailure(error)?.exitStatus, STOP_REPORT_STATUS);
  assert.equal(stopScriptReport(error)?.phase, "pre-effect");
  assert.equal(typeof stopScriptReport(error)?.hresult, "number");
});

test("win32: a killed stop script prints nothing parseable and is never pre-effect", { skip: process.platform !== "win32" && "win32-only" }, () => {
  const invocation = powerShellInvocation(WINDOWS_STOP_SCRIPT, syntheticPayload);
  const killed = spawnSync(invocation.executable, invocation.args, { input: invocation.input, env: invocation.env, encoding: "utf8",
    windowsHide: true, timeout: 150 });
  assert.equal((killed.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
  let parsed: unknown;
  try { parsed = JSON.parse(killed.stdout.trim()); } catch { parsed = undefined; }
  assert.equal((parsed as { phase?: unknown } | undefined)?.phase, undefined);
  assert.equal(stopScriptReport(nativeCallFailure("task-stop", killed, 150, 150)), undefined);
});
