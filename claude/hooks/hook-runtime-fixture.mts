// Shared fixture of the hook-runtime suites (issue #507, part 2). Every case
// gets its own mkdtemp "Claude home" with a hooks/ directory and a copy of this
// checkout's kherep/hook-runtime beside it, laid out as an installation: the
// runtime admits only on the hooks directory of its own home. Nothing
// under the developer's real ~/.claude is read or written. The coordination
// database is only ever opened through node:sqlite, never as a plain file.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";
import { initialize, openDatabase, type Opened } from "../kherep/hook-runtime/coordinator-db.mts";

export const RUNTIME = path.resolve(import.meta.dirname, "..", "kherep", "hook-runtime");
export const ENTRY = path.join(RUNTIME, "entry.mts");
const roots: string[] = [];

export interface Home { root: string; hooks: string; db: string; runtime: string }

// This checkout's runtime into dir, each .mts source declared as an unchanged copy so coverage of the
// copy credits the original (issue #964). A caller that edits the copy afterwards must not use this.
export function copyRuntime(dir: string): void {
  fs.cpSync(RUNTIME, dir, { recursive: true });
  for (const rel of fs.readdirSync(RUNTIME, { recursive: true, encoding: "utf8" })) {
    const source = path.join(RUNTIME, rel);
    if (rel.endsWith(".mts") && !rel.endsWith(".test.mts") && fs.lstatSync(source).isFile()) declareCopy(source, path.join(dir, rel));
  }
}

// declare: false for a case that alters its runtime copy afterwards; that copy then earns no coverage credit.
export function runtimeHome(prefix = "hook-runtime-", { declare = true } = {}): Home {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  const hooks = path.join(root, "hooks");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  const runtime = path.join(root, "kherep", "hook-runtime");
  if (declare) copyRuntime(runtime);
  else fs.cpSync(RUNTIME, runtime, { recursive: true });
  return { root, hooks, db: path.join(hooks, ".kherep-integrity", "run.sqlite"), runtime };
}

// The entry of the installation a target belongs to: the nearest ancestor with kherep/hook-runtime.
export function entryOf(target: string): string {
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "kherep", "hook-runtime", "entry.mts");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return ENTRY;
  }
}

// The suites' fixed child program (hook-runtime-child.mts): a scenario name and a JSON
// data file in the home, so no test ever builds program text from its values.
export const CHILD = path.join(import.meta.dirname, "hook-runtime-child.mts");
let dataSeq = 0;
function dataFile(home: Home, data: object): string {
  const file = path.join(home.root, `child-data-${++dataSeq}.json`);
  fs.writeFileSync(file, JSON.stringify({ runtime: home.runtime, hooks: home.hooks, ...data }));
  return file;
}
export function child(home: Home, scenario: string, data: object = {}): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CHILD, scenario, dataFile(home, data)], { encoding: "utf8", windowsHide: true });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
export function childAsync(home: Home, scenario: string, data: object = {}): ReturnType<typeof spawn> {
  return spawn(process.execPath, [CHILD, scenario, dataFile(home, data)], { windowsHide: true });
}

export function cleanup(): void {
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface Run { status: number | null; signal: string | null; stdout: string; stderr: string; ms: number }

// The entry exactly as a wired command starts it; `via` names another installation's entry.
export function entry(mode: string, target: string, args: string[] = [], input = "{}", timeout = 40_000,
  env: NodeJS.ProcessEnv = process.env, via?: Home): Run {
  const start = Date.now();
  const script = via ? path.join(via.runtime, "entry.mts") : entryOf(target);
  const run = spawnSync(process.execPath, [script, mode, target, ...args], { input, encoding: "utf8", timeout, windowsHide: true, env });
  return { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr, ms: Date.now() - start };
}

export function entryAsync(mode: string, target: string, args: string[] = [], input = "{}"): Promise<Run> & { pid?: number } {
  const start = Date.now();
  const child = spawn(process.execPath, [entryOf(target), mode, target, ...args], { windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<Run>((resolve) => child.on("close", (status, signal) =>
    resolve({ status, signal, stdout, stderr, ms: Date.now() - start }))) as Promise<Run> & { pid?: number };
  child.stdin.end(input);
  done.pid = child.pid;
  return done;
}

// A database of home with the schema, opened in this process.
export async function database(home: Home): Promise<Opened> {
  const opened = await openDatabase(home.hooks);
  initialize(opened.conn);
  return opened;
}

// Holds EXCLUSIVE on home's database in this process until the returned function is called.
export async function holdExclusive(home: Home): Promise<() => void> {
  const opened = await database(home);
  opened.conn.exec("BEGIN EXCLUSIVE");
  return () => { try { opened.conn.exec("ROLLBACK"); } catch { /* ended */ } opened.conn.close(); };
}

// One writer probe with its phases kept apart (issue #641): open, BEGIN EXCLUSIVE, ROLLBACK and close run
// in that order, each at most once. Only fixed labels and a bounded error code are kept, never error text.
export type ProbeKind = "busy" | "unavailable" | "root" | "database" | "other";
export interface ProbeError { kind: ProbeKind; errcode?: number }
export interface WriterProbe {
  ok: boolean; retryable: boolean; phase?: "open" | "begin" | "rollback"; error?: ProbeError;
  acquired: boolean; rolledBack: boolean; close: "not-returned" | "ok" | "error"; closeError?: ProbeError;
}
export type Opener = (dir: string) => Promise<{ conn: { exec(sql: string): void; close(): void } }>;

const KINDS: readonly ProbeKind[] = ["busy", "unavailable", "root", "database"];
function probeError(error: unknown): ProbeError {
  const { kherepKind, errcode } = Object(error) as { kherepKind?: unknown; errcode?: unknown };
  const kind = KINDS.find((known) => known === kherepKind) ?? "other";
  return typeof errcode === "number" && Number.isInteger(errcode) && errcode >= 0 && errcode <= 0xffff ? { kind, errcode } : { kind };
}
// SQLITE_BUSY (5) or SQLITE_LOCKED (6), extended codes included, as coordinator-db.mts classifies them.
const busyCode = (error?: ProbeError): boolean => error?.errcode !== undefined && [5, 6].includes(error.errcode & 0xff);

// A busy refusal of the open, or a busy BEGIN whose connection closed, is contention; nothing else is.
export async function probeWriter(home: Home, open: Opener = openDatabase): Promise<WriterProbe> {
  const probe: WriterProbe = { ok: false, retryable: false, acquired: false, rolledBack: false, close: "not-returned" };
  const failed = (phase: WriterProbe["phase"], error: unknown): void => { probe.phase = phase; probe.error = probeError(error); };
  let conn: Awaited<ReturnType<Opener>>["conn"];
  try { ({ conn } = await open(home.hooks)); } catch (error) {
    failed("open", error);
    probe.retryable = probe.error!.kind === "busy";
    return probe;
  }
  try { conn.exec("BEGIN EXCLUSIVE"); probe.acquired = true; } catch (error) { failed("begin", error); }
  if (probe.acquired) try { conn.exec("ROLLBACK"); probe.rolledBack = true; } catch (error) { failed("rollback", error); }
  try { conn.close(); probe.close = "ok"; } catch (error) { probe.close = "error"; probe.closeError = probeError(error); }
  probe.ok = probe.rolledBack && probe.close === "ok";
  probe.retryable = probe.phase === "begin" && probe.close === "ok" && (probe.error!.kind === "busy" || busyCode(probe.error));
  return probe;
}

const errorText = (error?: ProbeError): string => (error ? `${error.kind}${error.errcode === undefined ? "" : `/${error.errcode}`}` : "none");
export const describeProbe = (probe: WriterProbe): string => `phase=${probe.phase ?? "none"} error=${errorText(probe.error)} `
  + `acquired=${probe.acquired} rolledBack=${probe.rolledBack} close=${probe.close} closeError=${errorText(probe.closeError)}`;

// true when a writer could take the database right now; a failed close still rejects, with fixed text only.
export async function writerFree(home: Home, open?: Opener): Promise<boolean> {
  const probe = await probeWriter(home, open);
  if (probe.close === "error") throw new Error(`writerFree: close failed (${describeProbe(probe)})`);
  return probe.ok;
}

// A fixture-only opener: records each step as it runs and throws where `fail` names an error.
export type Step = "open" | "begin" | "rollback" | "close";
export function fakeOpener(fail: Partial<Record<Step, unknown>>, events: string[] = []): Opener {
  const step = (event: string, name: Step): void => { events.push(event); if (name in fail) throw fail[name]; };
  return async () => {
    step("open", "open");
    return { conn: { exec: (sql: string) => step(sql, sql === "ROLLBACK" ? "rollback" : "begin"), close: () => step("close", "close") } };
  };
}

export const until = async (check: () => boolean, ms = 10_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};

// pid 0 would signal this process group and always report alive (issue #565): no process id is an error here.
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`alive(${pid}): not a process id`);
  try { process.kill(pid, 0); return true; } catch { return false; }
}
