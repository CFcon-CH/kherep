import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NodePaths } from "./config.mts";
import { renameReplacing, type RenameDeps } from "./inbox.mts";
import type { TurnBudget } from "./policy.mts";
import { budgetBytes, withBudgetMutation, type BudgetLockDeps } from "./budget-lock.mts";

export type BudgetResult = "ok" | "spacing" | "exhausted" | "locked";
export interface GroupDebitKey { groupId: string; groupFingerprint: string; reservationId: string }
export interface GroupDebit extends GroupDebitKey { chargedAt: number }
export interface BudgetRecord { version: 2; budgetId: string; revision: number; turns: number[]; groupDebits: GroupDebit[] }
export type DebitResult = { status: "debited" | "already-debited"; budgetId: string; debit: GroupDebit }
  | { status: "spacing" | "exhausted" | "locked" | "conflict" | "full" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const time = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const exact = (x: object, keys: string[]): boolean => Object.keys(x).sort().join() === keys.sort().join();
export const MAX_GROUP_DEBITS = 1024;
export const budgetFile = (paths: NodePaths, owner: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw Error("invalid budget owner");
  return path.join(paths.dir, "listeners", `${owner}.turns.json`);
};
export const budgetMarker = (file: string): string => file.replace(/\.turns\.json$/, ".budget-state.json");
export function isDebitKey(x: GroupDebitKey): boolean {
  return typeof x.groupId === "string" && UUID.test(x.groupId) && typeof x.groupFingerprint === "string" && HASH.test(x.groupFingerprint)
    && typeof x.reservationId === "string" && UUID.test(x.reservationId);
}
export function parseBudget(bytes: string): BudgetRecord | { version?: never; turns: number[] } {
  const x = JSON.parse(bytes);
  if (!x || typeof x !== "object" || !Array.isArray(x.turns) || !x.turns.every(time)) throw Error("invalid budget turns");
  if (exact(x, ["turns"])) return x;
  if (!exact(x, ["version", "budgetId", "revision", "turns", "groupDebits"]) || x.version !== 2 || typeof x.budgetId !== "string" || !UUID.test(x.budgetId)
    || !time(x.revision) || !Array.isArray(x.groupDebits) || x.groupDebits.length > MAX_GROUP_DEBITS) throw Error("invalid budget record");
  const ids = new Set<string>();
  for (const debit of x.groupDebits) {
    if (!debit || typeof debit !== "object" || !exact(debit, ["groupId", "groupFingerprint", "reservationId", "chargedAt"])
      || !isDebitKey(debit) || !time(debit.chargedAt) || ids.has(debit.groupId)) throw Error("invalid group debit");
    ids.add(debit.groupId);
  }
  return x;
}

export function budgetTombs(file: string): string[] {
  const prefix = `.${path.basename(file)}.`;
  return fs.readdirSync(path.dirname(file)).filter(n => n.startsWith(prefix) && n.endsWith(".tomb")).map(n => path.join(path.dirname(file), n));
}
function markerId(file: string): string | null {
  const bytes = budgetBytes(budgetMarker(file));
  if (bytes === null) return null;
  const x = JSON.parse(bytes);
  if (!x || !exact(x, ["version", "budgetId"]) || x.version !== 1 || typeof x.budgetId !== "string" || !UUID.test(x.budgetId)) throw Error("invalid budget marker");
  return x.budgetId;
}

// Own temp, flush before replacing, then exact target readback under ownership.
// Directory flush is attempted on supported local filesystems; this is not a
// cross-platform power-loss guarantee.
export function persistBudget(file: string, value: BudgetRecord, deps: RenameDeps = {}): void {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > 1_048_576) throw Error("budget record exceeds bound");
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    renameReplacing(temp, file, deps);
    let dir: number | undefined;
    try { dir = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(dir); }
    catch (error) { if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    finally { if (dir !== undefined) fs.closeSync(dir); }
    if (budgetBytes(file) !== bytes) throw Error("budget readback differs");
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temp, { force: true }); }
}
function hasGroupHistory(file: string): boolean {
  const dir = path.join(path.dirname(file), "..", "target-delivery-groups", path.basename(file, ".turns.json"));
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe budget group history");
    return fs.readdirSync(dir).length > 0;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function load(file: string): BudgetRecord {
  if (budgetTombs(file).length) throw Error("budget recovery unresolved");
  const bytes = budgetBytes(file), marker = markerId(file);
  const record: ReturnType<typeof parseBudget> = bytes === null ? { turns: [] } : parseBudget(bytes);
  if (record.version === 2) {
    if (marker !== record.budgetId) throw Error("budget marker mismatch");
    return record;
  }
  if (marker !== null || hasGroupHistory(file)) throw Error("budget migration incomplete or group receipt remains");
  const budgetId = crypto.randomUUID(), markerFile = budgetMarker(file);
  const fd = fs.openSync(markerFile, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ version: 1, budgetId })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Only this uninterrupted lock holder can complete this initialization.
  return { version: 2, budgetId, revision: 0, turns: record.turns, groupDebits: [] };
}
function allowance(turns: number[], now: number, budget: TurnBudget): "ok" | "spacing" | "exhausted" {
  if (turns.filter(t => now - t < 3_600_000).length >= budget.perHour || turns.length >= budget.perDay) return "exhausted";
  return turns.some(t => now - t < budget.spacingMs) ? "spacing" : "ok";
}
function mutate(file: string, now: number, budget: TurnBudget, key: GroupDebitKey | undefined, deps: BudgetLockDeps & RenameDeps): DebitResult | BudgetResult {
  return withBudgetMutation(file, () => {
    if (!time(now) || !time(budget.perHour) || !time(budget.perDay) || !time(budget.spacingMs)) throw Error("invalid budget input");
    if (key && !isDebitKey(key)) throw Error("invalid group debit key");
    const record = load(file);
    if (key) {
      if (!isDebitKey(key)) throw Error("invalid group debit key");
      const existing = record.groupDebits.find(d => d.groupId === key.groupId);
      if (existing) return existing.groupFingerprint === key.groupFingerprint && existing.reservationId === key.reservationId
        ? { status: "already-debited", budgetId: record.budgetId, debit: existing } : { status: "conflict" };
      if (record.groupDebits.length >= MAX_GROUP_DEBITS) return { status: "full" };
    }
    const turns = record.turns.filter(t => now - t < 86_400_000);
    const status = allowance(turns, now, budget);
    // Persist initialization even on a refusal, so a healthy migration is not
    // mistaken for a crash left between the marker and its first v2 commit.
    if (status !== "ok") { if (record.revision === 0) persistBudget(file, record, deps); return key ? { status } : status; }
    if (record.revision === Number.MAX_SAFE_INTEGER) throw Error("budget revision full");
    const debit = key ? { groupId: key.groupId, groupFingerprint: key.groupFingerprint, reservationId: key.reservationId, chargedAt: now } : undefined;
    const next = { ...record, revision: record.revision + 1, turns: [...turns, now], groupDebits: debit ? [...record.groupDebits, debit] : record.groupDebits };
    persistBudget(file, next, deps);
    return debit ? { status: "debited", budgetId: record.budgetId, debit } : "ok";
  }, deps);
}
export function spendTurn(file: string, now: number, budget: TurnBudget, deps: BudgetLockDeps & RenameDeps = {}): BudgetResult {
  try { return mutate(file, now, budget, undefined, deps) as BudgetResult; } catch { return "locked"; }
}
export function debitGroup(file: string, key: GroupDebitKey, now: number, budget: TurnBudget, deps: BudgetLockDeps & RenameDeps = {}): DebitResult {
  try { return mutate(file, now, budget, key, deps) as DebitResult; } catch { return { status: "locked" }; }
}

// Called under the same canonical lock, never listener rank arbitration.
export function recoverBudget(file: string): void {
  const tombs = budgetTombs(file), canonical = budgetBytes(file);
  if (!tombs.length) return;
  const variants = tombs.map(t => budgetBytes(t));
  if (variants.some(v => v === null) || new Set(variants).size !== 1 || (canonical !== null && canonical !== variants[0]))
    throw Error("conflicting budget recovery");
  const bytes = variants[0]!; const record = parseBudget(bytes), marker = markerId(file);
  if ((record.version === 2 ? record.budgetId : null) !== marker) throw Error("budget recovery marker mismatch");
  if (canonical === null) fs.linkSync(tombs[0]!, file);
  if (budgetBytes(file) !== bytes) throw Error("budget recovery changed");
  for (const tomb of tombs) fs.unlinkSync(tomb);
}

// Recovery with a previously persisted core receipt must never initialize a
// missing budget or create a replacement debit, even if its marker also vanished.
export function verifyGroupDebit(file: string, key: GroupDebitKey, expected: { budgetId: string; chargedAt: number }): boolean {
  try {
    return withBudgetMutation(file, () => {
      if (!isDebitKey(key) || budgetTombs(file).length || markerId(file) !== expected.budgetId) return false;
      const bytes = budgetBytes(file);
      if (bytes === null) return false;
      const record = parseBudget(bytes);
      return record.version === 2 && record.budgetId === expected.budgetId && record.groupDebits.some(d => d.groupId === key.groupId
        && d.groupFingerprint === key.groupFingerprint && d.reservationId === key.reservationId && d.chargedAt === expected.chargedAt);
    });
  } catch { return false; }
}

export interface NoGroupDebitProof { version:1; budgetId:string; revision:number; key:GroupDebitKey; absent:true }
// Positive absence only. Never initialize, migrate, refund or interpret a failed
// read/locked result as absence. The cancellation journal is written in callback.
export function withConfirmedNoGroupDebit<T>(file:string,key:GroupDebitKey,
  body:(proof:NoGroupDebitProof)=>T):T {
  return withBudgetMutation(file,()=>{
    if(!isDebitKey(key)||budgetTombs(file).length)throw Error('no-debit proof unavailable');
    const bytes=budgetBytes(file);if(bytes===null)throw Error('no-debit budget missing');
    const record=parseBudget(bytes);
    if(record.version!==2||markerId(file)!==record.budgetId||record.groupDebits.some(d=>d.groupId===key.groupId||d.reservationId===key.reservationId))throw Error('no-debit proof conflicts');
    return body({version:1,budgetId:record.budgetId,revision:record.revision,key:{...key},absent:true});
  });
}
