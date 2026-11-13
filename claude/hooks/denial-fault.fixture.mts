// Test fixture (issue #504): one journal-write fault, injected by a preload into exactly one
// process of a hook run, never an environment seam of the production code. Never wired, never
// run by a hook. A suite passes denialFaultEnv(...) as the environment of one spawn; the fault
// acts only in the process whose main has exactly the basename KHEREP_DENIAL_FAULT_MAIN and
// patches fs.promises there, which every journal writer calls through at call time.
//   journal-hang     appendFile on a *.jsonl never settles (a stalled filesystem)
//   journal-enospc   appendFile on a *.jsonl fails ENOSPC; the marker can still be written
//   enospc-all       every appendFile fails ENOSPC; rename works (the journal becomes the marker)
//   all-fail         every appendFile fails ENOSPC and every rename EPERM: no evidence survives
//   all-hang         appendFile, mkdir and rename never settle
//   marker-slow      appendFile on a *.jsonl fails ENOSPC; appendFile on a *.failed settles after 700 ms, then
//                    appends (a slow filesystem; issues #612 and #614: the marker must still be on disk when
//                    the hook process has exited)
//   marker-stuck     appendFile on a *.failed never settles, with a real referenced 60 s handle
// With KHEREP_DENIAL_FAULT_RECEIPT set, the faulted process also records its intercepted calls (issue #652)
// and two in-child anchors, so a suite measures a dispatcher's own wait, not its wall clock (issue #653),
// and the first Date.now() of the main with its caller, the main's own start (issue #661). Date.now is
// patched only in that receipt case; without the variable no global is touched. Issue #664: in the receipt case
// setTimeout is patched too, recording every timer the process arms. KHEREP_DENIAL_STALL=<at>:<ms> (stallFor)
// blocks the faulted process synchronously at its preload (startup) or at its stdin setEncoding (stdin), with or
// without a fault.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type DenialFault = "journal-hang" | "journal-enospc" | "enospc-all" | "all-fail" | "all-hang" | "marker-slow" | "marker-stuck";
export const MARKER_SLOW_MS = 700;
const SELF_URL = pathToFileURL(import.meta.filename).href;
const DIGITS = /^\d+$/;

// file, line and column at the end of a stack frame: `…/name:12:3)`.
function frameSite(frame: string): [string, string, string] | null {
  let text = frame.trimEnd();
  if (text.endsWith(")")) text = text.slice(0, -1);
  const colAt = text.lastIndexOf(":");
  const lineAt = colAt > 0 ? text.lastIndexOf(":", colAt - 1) : -1;
  const name = lineAt > 0
    ? text.slice(Math.max(text.lastIndexOf("/", lineAt - 1), text.lastIndexOf("\\", lineAt - 1)) + 1, lineAt)
    : "";
  const line = text.slice(lineAt + 1, colAt);
  const col = text.slice(colAt + 1);
  return name && DIGITS.test(line) && DIGITS.test(col) ? [name, line, col] : null;
}

// The environment of one spawn: base plus the fault, NODE_OPTIONS appended, never replaced.
// receipt (issue #652): a file the faulted process writes at exit, see readFaultReceipt.
export function denialFaultEnv(fault: DenialFault, main: string, base: NodeJS.ProcessEnv = process.env, receipt?: string): NodeJS.ProcessEnv {
  const options = `${base.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning --import=${SELF_URL}`.trim();
  const env = { ...base, NODE_OPTIONS: options, KHEREP_DENIAL_FAULT: fault, KHEREP_DENIAL_FAULT_MAIN: main };
  if (receipt === undefined) return env;
  if (/\.(jsonl|failed)$/.test(receipt)) throw new Error(`a fault receipt must not look like a journal or marker: ${receipt}`);
  return { ...env, KHEREP_DENIAL_FAULT_RECEIPT: receipt };
}
// base plus a synchronous stall of ms in the faulted process, at its preload or at its stdin setEncoding (issue #664).
export const stallFor = (base: NodeJS.ProcessEnv, at: "startup" | "stdin", ms: number): NodeJS.ProcessEnv =>
  ({ ...base, KHEREP_DENIAL_STALL: `${at}:${ms}` });

// Every intercepted call, stamped in the faulted process, and the time of its exit event: no
// receipt when that process was killed. tail is the suffix class of the path, never the path.
// startAt is this preload's evaluation, just before the main module's; originAt is the process's
// time origin, by the same expression as START in codex/hooks/hook-adapter.mts. firstNow is the value of the
// first Date.now() after this preload and its caller as basename:line:col, never a path (issue #661). timers: every
// setTimeout of the process, afterCall the number of calls when it was armed, due = armedAt + delay (an arithmetic
// target), firedAt when its callback ran (issue #664).
export interface FaultReceipt { calls: { at: number; op: "appendFile" | "mkdir" | "rename"; tail: ".jsonl" | ".failed" | "dir" | "" }[]; exitAt: number;
  startAt: number; originAt: number; firstNow?: { at: number; from: string };
  timers: { afterCall: number; armedAt: number; delay: number; due: number; firedAt?: number }[] }
export function readFaultReceipt(file: string): FaultReceipt | undefined {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as FaultReceipt : undefined;
}
// The exit event less an anchor (no ms without a receipt, or for first-call without a call), and the calls as op:tail.
export function faultSpan(file: string, from: "first-call" | "start" | "origin" | "main-start"): { doc?: FaultReceipt; ops: string[]; ms?: number } {
  const doc = readFaultReceipt(file);
  const anchor = from === "first-call" ? doc?.calls[0]?.at : from === "start" ? doc?.startAt : from === "main-start" ? doc?.firstNow?.at : doc?.originAt;
  return { doc, ops: doc?.calls.map((c) => `${c.op}${c.tail ? `:${c.tail}` : ""}`) ?? [], ms: doc && anchor !== undefined ? doc.exitAt - anchor : undefined };
}

const startAt = Date.now();
const originAt = Math.floor(Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now());
const fault = process.env.KHEREP_DENIAL_FAULT ?? "";
const receipt = process.env.KHEREP_DENIAL_FAULT_RECEIPT ?? "";
const [stallAt, stallMs] = (process.env.KHEREP_DENIAL_STALL ?? "").split(":");
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`injected ${code}`), { code });
const never = (): Promise<never> => new Promise<never>(() => {});
const stall = (): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stallMs)); };

if ((fault || stallAt) && process.argv[1] && path.basename(process.argv[1]) === process.env.KHEREP_DENIAL_FAULT_MAIN) {
  const promises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const append = promises.appendFile!, rename = promises.rename!, mkdir = promises.mkdir!;
  const journal = (file: unknown): boolean => String(file).endsWith(".jsonl");
  const marker = (file: unknown): boolean => String(file).endsWith(".failed");
  const realSetTimeout = globalThis.setTimeout; // the fixture's own delay is never recorded
  const later = (): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, MARKER_SLOW_MS));
  const calls: FaultReceipt["calls"] = [];
  const timers: FaultReceipt["timers"] = [];
  const realNow = Date.now;
  let firstNow: FaultReceipt["firstNow"];
  // A rename is classed by its target. The receipt is written synchronously: only fs.promises is patched.
  const note = (op: FaultReceipt["calls"][number]["op"], file: unknown): void => {
    if (receipt) calls.push({ at: realNow(), op, tail: op === "mkdir" ? "dir" : journal(file) ? ".jsonl" : marker(file) ? ".failed" : "" });
  };
  if (receipt) process.on("exit", () => fs.writeFileSync(receipt, JSON.stringify({ calls, exitAt: realNow(), startAt, originAt, firstNow, timers })));
  promises.appendFile = function (file: unknown, ...rest: unknown[]) {
    note("appendFile", file);
    if (fault === "all-hang" || (fault === "journal-hang" && journal(file))) return never();
    if (fault === "marker-stuck" && marker(file)) {
      setTimeout(() => {}, 60_000); // A pending Promise alone does not hold the event loop open.
      return never();
    }
    if (fault === "marker-slow" && marker(file)) return later().then(() => append.call(fs.promises, file, ...rest));
    if (fault === "enospc-all" || fault === "all-fail" || ((fault === "journal-enospc" || fault === "marker-slow") && journal(file))) {
      return Promise.reject(errno("ENOSPC"));
    }
    return append.call(fs.promises, file, ...rest);
  };
  promises.rename = function (...args: unknown[]) {
    note("rename", args[1]);
    if (fault === "all-hang") return never();
    if (fault === "all-fail") return Promise.reject(errno("EPERM"));
    return rename.call(fs.promises, ...args);
  };
  promises.mkdir = function (...args: unknown[]) {
    note("mkdir", args[0]);
    return fault === "all-hang" ? never() : mkdir.call(fs.promises, ...args);
  };
  // Only with a receipt: the first caller of Date.now() after this preload, the first frame outside this file.
  const callerOf = (stack = ""): string => {
    for (const frame of stack.split("\n").slice(1)) {
      const site = frameSite(frame);
      if (site && site[0] !== path.basename(import.meta.filename)) return site.join(":");
    }
    return "";
  };
  if (receipt) Date.now = function () {
    const at = realNow();
    if (!firstNow) firstNow = { at, from: callerOf(new Error().stack) };
    return at;
  };
  // Only with a receipt: every timer armed here, on the real clock, its arguments, receiver and handle kept.
  if (receipt) globalThis.setTimeout = function (this: unknown, callback: unknown, delay?: unknown, ...args: unknown[]) {
    const armedAt = realNow(), ms = typeof delay === "number" ? delay : 0;
    const timer: FaultReceipt["timers"][number] = { afterCall: calls.length, armedAt, delay: ms, due: armedAt + ms };
    timers.push(timer);
    const fire = typeof callback !== "function" ? callback
      : function (this: unknown, ...given: unknown[]) { timer.firedAt = realNow(); return Reflect.apply(callback, this, given); };
    return Reflect.apply(realSetTimeout, this, [fire, delay, ...args]);
  } as unknown as typeof setTimeout;
  if (stallAt === "stdin") {
    const setEncoding = process.stdin.setEncoding;
    process.stdin.setEncoding = function (this: typeof process.stdin, ...args: Parameters<typeof setEncoding>) { stall(); return setEncoding.apply(this, args); };
  }
  if (stallAt === "startup") stall();
}
