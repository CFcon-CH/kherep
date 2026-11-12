// #838 A1/A5: every Windows native call is named; a failure carries a fixed, non-enumerable detail, and only the
// read-only calls run once more after a timeout. A fake spawn stands in for powershell.exe on every platform.
import assert from "node:assert/strict";
import fs from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";
import test from "node:test";

import {
  NATIVE_CALL_FAILED, NATIVE_CALLS, RETRY_ON_TIMEOUT, STOP_REPORT_STATUS, invokeNative, invokeNativeJson, nativeFailure, safeNativeFailure,
  stopScriptReport, type NativeCall, type NativeSpawn,
} from "./service-windows-invoke.mts";

const LEAK = "C:\\Users\\x838leak\\AppData S-1-5-21-838 KherepNode pid 4242";
type Result = Partial<SpawnSyncReturns<string>>;
const result = (value: Result): SpawnSyncReturns<string> =>
  ({ pid: 4242, output: [], stdout: LEAK, stderr: LEAK, status: null, signal: null, ...value }) as SpawnSyncReturns<string>;
const errno = (code: string) => Object.assign(new Error(`spawnSync powershell.exe ${code} ${LEAK}`), { code });
const TIMEOUT = result({ error: errno("ETIMEDOUT"), signal: "SIGTERM" });

function fake(...results: SpawnSyncReturns<string>[]) {
  const calls: number[] = [];
  let clock = 0;
  const spawn: NativeSpawn = (_command, _args, options) => { calls.push(options.timeout ?? -1); clock += 7; return results.shift() ?? result({ status: 0, stdout: "{}" }); };
  return { calls, deps: { spawn, now: () => clock } };
}
function failure(run: () => unknown): Error {
  try { run(); } catch (error) { return error as Error; }
  throw new Error("expected a failure");
}
function leakFree(error: Error): void {
  assert.equal(Object.keys(error).includes("native"), false, "the detail is non-enumerable");
  for (const text of [error.message, JSON.stringify(nativeFailure(error)), JSON.stringify(error)]) assert.equal(text.includes("x838leak"), false, text);
}

test("invoke classifies a timeout, a non-zero exit, a spawn error and unparseable output with the fixed message", () => {
  const cases: Array<[SpawnSyncReturns<string> | "output", Record<string, unknown>]> = [
    [TIMEOUT, { call: "task-write", outcome: "timeout", elapsedMs: 7, timeoutMs: 30_000 }],
    [result({ status: 1 }), { call: "task-write", outcome: "exit", exitStatus: 1, elapsedMs: 7, timeoutMs: 30_000 }],
    [result({ error: errno("ENOENT") }), { call: "task-write", outcome: "spawn", elapsedMs: 7, timeoutMs: 30_000, reason: "ENOENT" }],
  ];
  for (const [value, expected] of cases) {
    const f = fake(value as SpawnSyncReturns<string>);
    const error = failure(() => invokeNative("task-write", "script", {}, 30_000, f.deps));
    assert.equal(error.message, NATIVE_CALL_FAILED);
    assert.deepEqual(nativeFailure(error), expected);
    leakFree(error);
  }
  const f = fake(result({ status: 0, stdout: `not json ${LEAK}` }));
  const error = failure(() => invokeNativeJson("task-read", "script", {}, "Scheduled Task readback is incomplete", 30_000, f.deps));
  assert.equal(error.message, "Scheduled Task readback is incomplete");
  assert.deepEqual(nativeFailure(error), { call: "task-read", outcome: "output", elapsedMs: 7, timeoutMs: 30_000 });
  leakFree(error);
});

test("only task-read, process-provenance, task-stop-check and current-user run once more, and only after a timeout", () => {
  assert.deepEqual([...RETRY_ON_TIMEOUT].sort(), ["current-user", "process-provenance", "task-read", "task-stop-check"]);
  for (const call of NATIVE_CALLS) {
    const retried = fake(TIMEOUT, result({ status: 0, stdout: " ok " }));
    if (RETRY_ON_TIMEOUT.has(call)) {
      assert.equal(invokeNative(call, "script", {}, 30_000, retried.deps), "ok", call);
      assert.deepEqual(retried.calls, [30_000, 30_000], `${call}: the same limit for the second run`);
    } else {
      assert.equal(nativeFailure(failure(() => invokeNative(call, "script", {}, 65_000, retried.deps)))?.outcome, "timeout", call);
      assert.equal(retried.calls.length, 1, `${call} is never repeated`);
    }
    const exited = fake(result({ status: 1 }), result({ status: 0, stdout: "ok" }));
    failure(() => invokeNative(call, "script", {}, 30_000, exited.deps));
    assert.equal(exited.calls.length, 1, `${call}: a non-zero exit is final`);
  }
  const twice = fake(TIMEOUT, TIMEOUT);
  assert.deepEqual(nativeFailure(failure(() => invokeNative("task-read", "script", {}, 30_000, twice.deps))),
    { call: "task-read", outcome: "timeout", elapsedMs: 14, timeoutMs: 30_000 }, "elapsed covers both runs");
});

test("a stop report is read only from a completed stop script with the dedicated status and the exact fixed shape", () => {
  const report = JSON.stringify({ ok: false, phase: "pre-effect", reason: "descendants-busy", hresult: -2146233087 });
  for (const call of ["task-stop", "task-stop-check"] as const) {
    const error = failure(() => invokeNative(call, "script", {}, 65_000, fake(result({ status: STOP_REPORT_STATUS, stdout: report })).deps));
    assert.deepEqual(stopScriptReport(error), { phase: "pre-effect", reason: "descendants-busy", hresult: -2146233087 });
    assert.deepEqual(nativeFailure(error), { call, outcome: "exit", exitStatus: STOP_REPORT_STATUS, elapsedMs: 7, timeoutMs: 65_000, reason: "descendants-busy" });
  }
  const rejected: Array<[NativeCall, SpawnSyncReturns<string>]> = [
    ["task-read", result({ status: STOP_REPORT_STATUS, stdout: report })],
    ["task-stop", result({ status: 1, stdout: report })],
    ["task-stop", result({ error: errno("ETIMEDOUT"), stdout: report })],
    ["task-stop", result({ status: STOP_REPORT_STATUS, stdout: `${report}\n${report}` })],
    ["task-stop", result({ status: STOP_REPORT_STATUS, stdout: JSON.stringify({ ok: false, phase: "pre-effect", reason: "descendants-busy", hresult: 1, path: LEAK }) })],
    ["task-stop", result({ status: STOP_REPORT_STATUS, stdout: JSON.stringify({ ok: false, phase: "before", reason: "descendants-busy", hresult: 1 }) })],
    ["task-stop", result({ status: STOP_REPORT_STATUS, stdout: JSON.stringify({ ok: false, phase: "pre-effect", reason: LEAK, hresult: 1 }) })],
  ];
  for (const [call, value] of rejected) {
    const error = failure(() => invokeNative(call, "script", {}, 65_000, fake(value).deps));
    assert.equal(stopScriptReport(error), undefined, JSON.stringify(value));
    assert.equal(nativeFailure(error)?.reason, undefined);
    leakFree(error);
  }
});

test("safeNativeFailure keeps the fixed fields only and drops a detail with any invalid value", () => {
  const base = { call: "task-stop", outcome: "exit", exitStatus: 70, elapsedMs: 12, timeoutMs: 65_000, reason: "native-error" };
  assert.deepEqual(safeNativeFailure({ ...base, stderr: LEAK, pid: 4242, path: LEAK }), base);
  for (const bad of [{ call: "task-explode" }, { outcome: "crash" }, { elapsedMs: -1 }, { elapsedMs: 1.5 }, { timeoutMs: 0 },
    { exitStatus: "1" }, { reason: LEAK }, { reason: "Native Error" }]) assert.equal(safeNativeFailure({ ...base, ...bad }), undefined, JSON.stringify(bad));
  for (const bad of [null, "task-stop", 7, []]) assert.equal(safeNativeFailure(bad), undefined);
});

test("the Windows adapter spawns no process outside a named native call", () => {
  const source = fs.readFileSync(new URL("service-platform-windows.mts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /spawnSync|child_process|\binvoke\(/);
  const names = [...source.matchAll(/invokeNative(?:Json)?(?:<[^(]*>)?\(\s*"([a-z-]+)"/g)].map(match => match[1]);
  assert.ok(names.length >= 12, String(names.length));
  for (const name of names) assert.ok((NATIVE_CALLS as readonly string[]).includes(name), name);
  assert.match(source, /checkOnly \? "task-stop-check" : "task-stop"/);
});
