import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireServiceOwnerFile, type ServiceOwnerProbe } from "./service-drain.mts";

export interface BudgetLockDeps { signal?: (pid: number) => void }
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ESRCH";
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

// Same-host cooperative ownership only. PID reuse deliberately fences: no
// process epoch, mtime, account lookup or inventory is evidence of absence.
export function budgetOwnerProbe(deps: BudgetLockDeps = {}): ServiceOwnerProbe {
  let acquisitions = 0, probes = 0;
  return {
    current: () => {
      if (++acquisitions > 4) throw Error("budget reclaim depth exceeded");
      return { version: 1, pid: process.pid, startedAt: new Date().toISOString(), owner: `budget/v1:${crypto.randomUUID()}` };
    },
    active: owner => {
      if (++probes > 24 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2_147_483_647) return "unknown";
      try { (deps.signal ?? (pid => { process.kill(pid, 0); }))(owner.pid); return true; }
      catch (error) { return absent(error) ? false : "unknown"; }
    },
  };
}

// Shared with the budget parser/cleanup: refuse links, foreign ownership,
// writable-by-others records and unbounded input before reading bytes.
export function budgetBytes(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576
      || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))) throw Error("unsafe budget file");
    return fs.readFileSync(file, "utf8");
  } catch (error) { if (missing(error)) return null; throw error; }
}

// Legacy PID locks can be reclaimed only under the same serialized reclaim
// gate as modern owners, with a repeated positive absence/identity proof.
function migrateLegacy(lock: string, probe: ServiceOwnerProbe): void {
  const bytes = budgetBytes(lock);
  if (bytes === null || !/^[1-9][0-9]{0,9}$/.test(bytes)) return;
  const before = fs.lstatSync(lock);
  const owner = { version: 1 as const, pid: Number(bytes), startedAt: new Date(0).toISOString(), owner: "legacy-budget" };
  if (probe.active(owner) !== false) throw Error("legacy budget owner is live or unknown");
  const release = acquireServiceOwnerFile(`${lock}.reclaim`, "budget reclaim held", probe);
  try {
    const current = budgetBytes(lock);
    if (current === null) return;
    const stat = fs.lstatSync(lock);
    if (current !== bytes || stat.dev !== before.dev || stat.ino !== before.ino || probe.active(owner) !== false)
      throw Error("legacy budget owner changed or unknown");
    fs.unlinkSync(lock);
  } finally { release(); }
}

// The synchronous body owns read/validation/decision/persist/readback. No
// detached async continuation may inherit this mutation boundary.
export function withBudgetMutation<T>(file: string, body: () => T, deps: BudgetLockDeps = {}): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw Error("unsafe budget directory");
  const probe = budgetOwnerProbe(deps), lock = `${file}.lock`;
  migrateLegacy(lock, probe);
  const release = acquireServiceOwnerFile(lock, "budget mutation held", probe);
  try {
    const value = body();
    if (value && typeof (value as { then?: unknown }).then === "function") throw Error("budget mutation must be synchronous");
    return value;
  } finally { release(); }
}
