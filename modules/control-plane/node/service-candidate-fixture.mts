// #582: helpers shared by the recorded-candidate tests. Every world is a FakeAdapter in a temp dir; nothing here
// reads or writes a real service definition.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { runService } from "./service-cli.mts";
import { serviceRoot } from "./service-records.mts";
import { activateManagedService, readServiceReceipt } from "./service-transaction.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import type { ServiceAdapter, ServiceBinding } from "./service-types.mts";

export type Harness = ReturnType<typeof setup>;
export type Failure = Error & { code?: string; recovery?: string; stage?: string; blocker?: string; stopCode?: string };
export interface RecordJson {
  binding: ServiceBinding; definitionDigest: string; securityDigest: string; backupId?: string;
  command: string; stage: string; blocker: string; stopCode: string; failedAt: string;
}

export const candidateFile = (h: Harness): string => path.join(serviceRoot(h.paths), "candidate.json");
export const drainFile = (h: Harness): string => path.join(serviceRoot(h.paths), "drain");
export const receiptFile = (h: Harness): string => path.join(serviceRoot(h.paths), "receipt.json");
export const readRecord = (h: Harness): RecordJson | null =>
  fs.existsSync(candidateFile(h)) ? JSON.parse(fs.readFileSync(candidateFile(h), "utf8")) as RecordJson : null;
const bytes = (file: string): string | null => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const backups = (h: Harness): string[] => {
  try { return fs.readdirSync(path.join(serviceRoot(h.paths), "backups")).sort(); } catch { return []; }
};
// The "no mutation" snapshot: native state, both records byte for byte, the backup listing and the drain.
export const world = (h: Harness): string => JSON.stringify({
  events: h.adapter.events.length, definition: h.adapter.snapshot?.definition.toString(), running: h.adapter.snapshot?.running,
  receipt: bytes(receiptFile(h)), candidate: bytes(candidateFile(h)), backups: backups(h), drain: fs.existsSync(drainFile(h)) });
export const why = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; return "resolved"; } catch (error) { return (error as Error).message; }
};
export const caught = async (promise: Promise<unknown>): Promise<Failure> => {
  try { await promise; } catch (error) { return error as Failure; }
  throw new Error("expected a rejection");
};
export const stops = (h: Harness): number => h.adapter.events.filter(event => event === "stop").length;
export const tamper = (h: Harness, edit: (record: Record<string, unknown>) => void): void => {
  const record = JSON.parse(fs.readFileSync(candidateFile(h), "utf8")) as Record<string, unknown>;
  edit(record);
  fs.writeFileSync(candidateFile(h), JSON.stringify(record));
};

// The failed controller has exited on a real node: the kept drain's owner is a dead pid, so the next verb reclaims it.
export function staleDrain(h: Harness): void {
  if (!fs.existsSync(drainFile(h))) return;
  h.advanceController();
}

// A second verb in one test: pid 42 is the loaded candidate until its first stop, pid 43 the next candidate start.
export function secondCall(h: Harness): Harness["deps"] {
  staleDrain(h);
  h.adapter.candidatePid = 43;
  const base = stops(h);
  return { ...h.deps, pidAlive: (pid: unknown) => (pid === 42 && stops(h) === base) || (pid === 43 && h.adapter.candidatePidAlive) };
}

// T1: a managed upgrade fails at health and the candidate stop fails, so the candidate stays loaded and recorded.
export async function failedUpgrade(t: test.TestContext, configure: (h: Harness) => void = () => {}) {
  const h = setup(t);
  seedManaged(h);
  h.adapter.failCandidateHealth = true;
  h.adapter.failCandidateRecoveryStop = true;
  configure(h);
  const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps));
  h.adapter.failCandidateHealth = false;
  h.adapter.failCandidateRecoveryStop = false;
  return { h, failure };
}

// T0: an adopt install over a stopped legacy service fails at health with the same candidate stop failure.
export async function failedAdoptInstall(t: test.TestContext) {
  const h = setup(t);
  h.adapter.snapshot!.running = false;
  h.adapter.oldPidAlive = false;
  h.adapter.failCandidateHealth = true;
  h.adapter.failCandidateRecoveryStop = true;
  const failure = await caught(activateManagedService({ mode: "install", binding: h.candidate, adopt: true, explicitServiceName: true }, h.deps));
  h.adapter.failCandidateHealth = false;
  h.adapter.failCandidateRecoveryStop = false;
  return { h, failure };
}

// T0b: a fresh install whose candidate never settles (it disconnects) and whose stop fails.
export async function failedFreshInstall(t: test.TestContext) {
  const h = setup(t);
  h.adapter.snapshot = null;
  h.adapter.state = null;
  h.adapter.oldPidAlive = false;
  h.adapter.disconnectAfterHealth = true;
  h.adapter.failCandidateRecoveryStop = true;
  const failure = await caught(activateManagedService({ mode: "install", binding: h.candidate }, h.deps));
  h.adapter.disconnectAfterHealth = false;
  h.adapter.failCandidateRecoveryStop = false;
  return { h, failure };
}

export async function status(h: Harness, extra: Partial<NonNullable<Parameters<typeof runService>[1]>> = {}) {
  const lines: string[] = [];
  const log = console.log;
  console.log = (value: unknown) => { lines.push(String(value)); };
  let exit: number;
  try {
    exit = await runService(["status"], { root: path.dirname(h.paths.dir), readReceipt: () => readServiceReceipt(h.paths),
      adapterFor: () => h.adapter as unknown as ServiceAdapter, readState: () => h.adapter.state, alive: h.deps.pidAlive,
      ownerProbe: h.deps.ownerProbe, ...extra });
  } finally { console.log = log; }
  assert.equal(lines.length, 1, "status prints one report");
  return { exit, text: lines[0], report: JSON.parse(lines[0]) as Record<string, any> };
}

export const noPath = (text: string): boolean => !text.includes("/") && !text.includes("\\");
