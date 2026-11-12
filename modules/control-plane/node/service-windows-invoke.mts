import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";

import { STOP_SCRIPT_REPORT_STATUS } from "./service-platform-windows-process.mts";
import { timedSync } from "./sync-timing.mts";

// #838 A1: every PowerShell call of the Windows adapter has a fixed name. A failed call throws the one fixed
// message it always threw (service-types.mts maps it to STOP_NATIVE_REFUSED) and carries a non-enumerable detail
// with fixed fields only: no stderr, stdout, path, pid, task name or SID leaves the process.
export const NATIVE_CALLS = ["task-read", "task-write", "task-start", "task-remove", "task-stop", "task-stop-check",
  "process-provenance", "current-user", "principal-sid", "environment-read", "definition-mutate", "process-executable"] as const;
export type NativeCall = typeof NATIVE_CALLS[number];
export const NATIVE_OUTCOMES = ["timeout", "exit", "spawn", "output"] as const;
export type NativeOutcome = typeof NATIVE_OUTCOMES[number];
export interface NativeFailure {
  call: NativeCall; outcome: NativeOutcome; exitStatus?: number; elapsedMs: number; timeoutMs: number; reason?: string;
}
export const NATIVE_CALL_FAILED = "Scheduled Task operation failed for the selected task";

// #838 A2: the wrapped stop script exits with this status after printing its fixed failure report.
export const STOP_REPORT_STATUS = STOP_SCRIPT_REPORT_STATUS;
export const STOP_PHASES = ["pre-effect", "effects-possible"] as const;
export interface StopScriptReport { phase: typeof STOP_PHASES[number]; reason: string; hresult: number }
const REASON = /^[a-z][a-z-]{1,39}$/;
const ERRNO = /^E[A-Z]{2,20}$/;
const STOP_REPORT = Symbol("windows-stop-script-report");

// #838 A5, the #427 pattern (service-owner-probe.mts): a read-only call runs once more after a timeout only.
// A mutating call is never repeated; task-write and task-start keep their limit and run once.
export const RETRY_ON_TIMEOUT: ReadonlySet<NativeCall> = new Set<NativeCall>(["task-read", "process-provenance", "task-stop-check", "current-user"]);

const PRELUDE = "$ErrorActionPreference='Stop';$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KHEREP_SERVICE_PAYLOAD))|ConvertFrom-Json;";
const STDIN_BOOTSTRAP = "$script=[Console]::In.ReadToEnd();&([ScriptBlock]::Create($script))";

export function powerShellInvocation(script: string, payload: unknown): {
  executable: string; args: string[]; env: NodeJS.ProcessEnv; input: string;
} {
  return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", STDIN_BOOTSTRAP], input: PRELUDE + script,
    env: { ...process.env, KHEREP_SERVICE_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64") } };
}

const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// The only reader of a detail: anything that is not exactly the fixed shape is dropped, extra fields included.
export function safeNativeFailure(value: unknown): NativeFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!(NATIVE_CALLS as readonly unknown[]).includes(item.call) || !(NATIVE_OUTCOMES as readonly unknown[]).includes(item.outcome)
    || !nonNegative(item.elapsedMs) || !nonNegative(item.timeoutMs) || item.timeoutMs === 0
    || (item.exitStatus !== undefined && !Number.isSafeInteger(item.exitStatus))
    || (item.reason !== undefined && !(typeof item.reason === "string" && (REASON.test(item.reason) || ERRNO.test(item.reason))))) return undefined;
  return { call: item.call as NativeCall, outcome: item.outcome as NativeOutcome,
    ...(item.exitStatus !== undefined ? { exitStatus: item.exitStatus as number } : {}),
    elapsedMs: item.elapsedMs as number, timeoutMs: item.timeoutMs as number,
    ...(item.reason !== undefined ? { reason: item.reason as string } : {}) };
}

export function withNativeFailure<E extends Error>(error: E, detail: NativeFailure): E {
  const safe = safeNativeFailure(detail);
  if (safe) Object.defineProperty(error, "native", { value: Object.freeze(safe), enumerable: false, configurable: true });
  return error;
}

export const nativeFailure = (error: unknown): NativeFailure | undefined =>
  error && typeof error === "object" ? safeNativeFailure((error as { native?: unknown }).native) : undefined;

export function stopScriptReport(error: unknown): StopScriptReport | undefined {
  return error && typeof error === "object" ? (error as { [STOP_REPORT]?: StopScriptReport })[STOP_REPORT] : undefined;
}

// A report is read only from a completed stop script with the dedicated status: exactly one JSON object with the
// four fixed keys. A killed or timed-out script never reaches this, so it is never pre-effect.
function parseStopReport(stdout: string): StopScriptReport | undefined {
  let value: Record<string, unknown>;
  try { value = JSON.parse(stdout.trim()) as Record<string, unknown>; } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== "hresult,ok,phase,reason" || value.ok !== false
    || !(STOP_PHASES as readonly unknown[]).includes(value.phase) || typeof value.reason !== "string" || !REASON.test(value.reason)
    || !Number.isSafeInteger(value.hresult)) return undefined;
  return { phase: value.phase as StopScriptReport["phase"], reason: value.reason, hresult: value.hresult as number };
}

const timedOut = (result: SpawnSyncReturns<string>): boolean =>
  (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";

// Classifies one finished spawnSync result that did not succeed.
export function nativeCallFailure(call: NativeCall, result: SpawnSyncReturns<string>, elapsedMs: number, timeoutMs: number): Error {
  const error = new Error(NATIVE_CALL_FAILED);
  const elapsed = Math.max(0, Math.round(elapsedMs));
  const errno = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (timedOut(result)) return withNativeFailure(error, { call, outcome: "timeout", elapsedMs: elapsed, timeoutMs });
  if (result.error) {
    return withNativeFailure(error, { call, outcome: "spawn", elapsedMs: elapsed, timeoutMs,
      ...(typeof errno === "string" && ERRNO.test(errno) ? { reason: errno } : {}) });
  }
  const report = (call === "task-stop" || call === "task-stop-check") && result.status === STOP_REPORT_STATUS
    ? parseStopReport(result.stdout ?? "") : undefined;
  if (report) Object.defineProperty(error, STOP_REPORT, { value: Object.freeze(report), enumerable: false });
  return withNativeFailure(error, { call, outcome: "exit", ...(Number.isSafeInteger(result.status) ? { exitStatus: result.status! } : {}),
    elapsedMs: elapsed, timeoutMs, ...(report ? { reason: report.reason } : {}) });
}

export function nativeOutputFailure(call: NativeCall, message: string, elapsedMs: number, timeoutMs: number): Error {
  return withNativeFailure(new Error(message), { call, outcome: "output", elapsedMs: Math.max(0, Math.round(elapsedMs)), timeoutMs });
}

export type NativeSpawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
export interface NativeInvokeDeps { spawn?: NativeSpawn; now?: () => number }

export function invokeNative(call: NativeCall, script: string, payload: unknown, timeout = 30_000, deps: NativeInvokeDeps = {}): string {
  const spawn = deps.spawn ?? spawnSync;
  const now = deps.now ?? Date.now;
  const native = powerShellInvocation(script, payload);
  const run = () => spawn(native.executable, native.args, { input: native.input, encoding: "utf8", env: native.env,
    windowsHide: true, timeout, stdio: ["pipe", "pipe", "pipe"] });
  return timedSync(call, () => {
    const started = now();
    let result = run();
    if (timedOut(result) && RETRY_ON_TIMEOUT.has(call)) result = run();
    if (result.status === 0) return result.stdout.trim();
    throw nativeCallFailure(call, result, now() - started, timeout);
  });
}

// A JSON answer of a named call; unparseable output throws the caller's fixed message as outcome "output".
export function invokeNativeJson<T>(call: NativeCall, script: string, payload: unknown, malformed: string,
  timeout = 30_000, deps: NativeInvokeDeps = {}): T {
  const now = deps.now ?? Date.now;
  const started = now();
  const output = invokeNative(call, script, payload, timeout, deps);
  try { return JSON.parse(output) as T; }
  catch { throw nativeOutputFailure(call, malformed, now() - started, timeout); }
}
