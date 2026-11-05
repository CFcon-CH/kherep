import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import { classifyExclusiveCreate, CONTENTION_ATTEMPTS, CONTENTION_PAUSE_MS, pauseSync } from "./lock-contention.mts";
import { defaultServiceOwnerProbe, type ServiceFileOwner, type ServiceOwnerProbe } from "./service-owner-probe.mts";

export { defaultServiceOwnerProbe, type ServiceFileOwner, type ServiceOwnerProbe };

export const SERVICE_DRAIN_BLOCKED = "SERVICE_DRAIN_BLOCKED";

const root = (paths: NodePaths): string => path.join(paths.dir, "service");
export const serviceDrainFile = (paths: NodePaths): string => path.join(root(paths), "drain");
const admissions = (paths: NodePaths): string => path.join(root(paths), "admissions");
export interface ServiceAdmission { readonly root: string }
export interface ServiceAdmissionBlocker { leaseId: string; pid: number; startedAt: string }
const activeAdmissions = new WeakSet<ServiceAdmission>();
interface AdmissionState { finished: boolean; permanent: boolean; pending: Set<Promise<void>>; release(): void }
const admissionStates = new WeakMap<ServiceAdmission, AdmissionState>();

function releaseFinishedAdmission(state: AdmissionState): void {
  if (state.finished && !state.permanent && state.pending.size === 0) state.release();
}

export class ServiceDrainActiveError extends Error {
  constructor() { super("managed service upgrade is draining new session admissions"); }
}

function readOwner(file: string): { owner: ServiceFileOwner; bytes: string } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))) {
    throw new Error("service controller owner file is unsafe");
  }
  const bytes = fs.readFileSync(file, "utf8");
  const owner = JSON.parse(bytes) as ServiceFileOwner;
  if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(Date.parse(owner.startedAt))
    || typeof owner.owner !== "string" || owner.owner.length === 0) throw new Error("service controller owner file is invalid");
  return { owner, bytes };
}

// An exclusive create failing with EPERM, EACCES or EBUSY (Windows delete
// pending, issue #602) is retried on one allowance per call, shared by every
// reclaim gate below it; a spent allowance fails closed with activeMessage.
// EEXIST still needs owner proof, and a transient code never bypasses it.
export function acquireServiceOwnerFile(file: string, activeMessage: string, probe: ServiceOwnerProbe = defaultServiceOwnerProbe): () => void {
  return acquireOwnerFile(file, activeMessage, probe, { left: CONTENTION_ATTEMPTS });
}

function openOwnerFile(file: string, activeMessage: string, budget: { left: number }): number {
  for (;;) {
    try {
      return fs.openSync(file, "wx", 0o600);
    } catch (error) {
      if (classifyExclusiveCreate(error) !== "retry") throw error;
      if (--budget.left <= 0) throw new Error(`${activeMessage}; its owner file cannot be created`, { cause: error });
      pauseSync(CONTENTION_PAUSE_MS);
    }
  }
}

function acquireOwnerFile(file: string, activeMessage: string, probe: ServiceOwnerProbe, budget: { left: number }): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const owner = probe.current();
  const bytes = `${JSON.stringify(owner)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: number;
    try {
      handle = openOwnerFile(file, activeMessage, budget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: ReturnType<typeof readOwner>;
      try { existing = readOwner(file); } catch { throw new Error(`${activeMessage}; its owner cannot be verified`); }
      const active = probe.active(existing.owner);
      if (active === true) throw new Error(activeMessage);
      if (active === "unknown") throw new Error(`${activeMessage}; its owner cannot be verified`);
      const releaseReclaim = acquireOwnerFile(`${file}.reclaim`, `${activeMessage}; stale reclaim is already active`, probe, budget);
      try {
        let claimed: ReturnType<typeof readOwner>;
        try { claimed = readOwner(file); }
        catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error(`${activeMessage}; its owner cannot be verified`);
        }
        if (claimed.bytes !== existing.bytes) throw new Error(`${activeMessage}; its owner changed during verification`);
        const claimedActive = probe.active(claimed.owner);
        if (claimedActive === true) throw new Error(activeMessage);
        if (claimedActive === "unknown") throw new Error(`${activeMessage}; its owner cannot be verified`);
        fs.rmSync(file);
      } finally { releaseReclaim(); }
      continue;
    }
    let closing = false;
    try {
      fs.writeFileSync(handle, bytes);
      fs.fsyncSync(handle);
      closing = true;
      fs.closeSync(handle);
    } catch (error) {
      // Closed at most once, then the caller's own file is removed; a failed removal leaves it for manual cleanup.
      if (!closing) try { fs.closeSync(handle); } catch { /* the write failed already */ }
      try { fs.rmSync(file, { force: true }); } catch { /* the original error is rethrown */ }
      throw error;
    }
    return () => {
      try { if (fs.readFileSync(file, "utf8") === bytes) fs.rmSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
  }
  throw new Error(activeMessage);
}

export async function withServiceAdmission<T>(
  paths: NodePaths, operation: (admission: ServiceAdmission) => Promise<T>, probe: ServiceOwnerProbe = defaultServiceOwnerProbe,
): Promise<T> {
  const drain = serviceDrainFile(paths);
  if (fs.existsSync(drain)) throw new ServiceDrainActiveError();
  const dir = admissions(paths);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lease = path.join(dir, `${process.pid}-${crypto.randomUUID()}`);
  const bytes = `${JSON.stringify(probe.current())}\n`;
  const handle = fs.openSync(lease, "wx", 0o600);
  fs.writeFileSync(handle, bytes);
  fs.fsyncSync(handle);
  fs.closeSync(handle);
  const admission = Object.freeze({ root: path.resolve(paths.dir) });
  const state: AdmissionState = { finished: false, permanent: false, pending: new Set(), release: () => {
    try { if (fs.readFileSync(lease, "utf8") === bytes) fs.rmSync(lease); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } };
  admissionStates.set(admission, state);
  activeAdmissions.add(admission);
  try {
    if (fs.existsSync(drain)) throw new ServiceDrainActiveError();
    return await operation(admission);
  } finally {
    activeAdmissions.delete(admission);
    state.finished = true;
    releaseFinishedAdmission(state);
  }
}

export async function continueServiceAdmission<T>(
  paths: NodePaths, admission: ServiceAdmission | undefined, operation: (active: ServiceAdmission) => Promise<T>,
  probe?: ServiceOwnerProbe,
): Promise<T> {
  if (admission && activeAdmissions.has(admission) && admission.root === path.resolve(paths.dir)) return operation(admission);
  return withServiceAdmission(paths, operation, probe);
}

export function retainServiceAdmission(admission: ServiceAdmission, whenStopped?: Promise<void>): void {
  if (!activeAdmissions.has(admission)) throw new Error("service admission is not active");
  const state = admissionStates.get(admission)!;
  if (!whenStopped) { state.permanent = true; return; }
  if (state.pending.has(whenStopped)) return;
  state.pending.add(whenStopped);
  void whenStopped.then(() => {
    state.pending.delete(whenStopped);
    // A late cleanup failure leaves the on-disk lease blocking the drain.
    try { releaseFinishedAdmission(state); } catch { /* no positive release */ }
  }, () => { /* rejected observation is not proof of shutdown */ });
}

export async function waitForServiceAdmission<T>(
  paths: NodePaths, operation: (active: ServiceAdmission) => Promise<T>,
  options: { admission?: ServiceAdmission; signal?: AbortSignal; intervalMs?: number; probe?: ServiceOwnerProbe } = {},
): Promise<T> {
  const interval = options.intervalMs ?? 25;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("operation aborted", "AbortError");
    try { return await continueServiceAdmission(paths, options.admission, operation, options.probe); }
    catch (error) {
      if (!(error instanceof ServiceDrainActiveError)) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, interval);
        function done(): void { options.signal?.removeEventListener("abort", aborted); resolve(); }
        function aborted(): void { clearTimeout(timer); reject(options.signal?.reason ?? new DOMException("operation aborted", "AbortError")); }
        options.signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  }
}

export function beginServiceDrain(paths: NodePaths, probe?: ServiceOwnerProbe): () => void {
  return acquireServiceOwnerFile(serviceDrainFile(paths), "another managed service drain is already active", probe);
}

// Issue #472: read-only. Only the next upgrade or rollback reclaims a stale drain.
export function describeServiceDrain(
  paths: NodePaths, probe: ServiceOwnerProbe = defaultServiceOwnerProbe,
): "none" | "active" | "stale" | "unknown" {
  let existing: ReturnType<typeof readOwner>;
  try { existing = readOwner(serviceDrainFile(paths)); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unknown"; }
  try {
    const active = probe.active(existing.owner);
    return active === true ? "active" : active === false ? "stale" : "unknown";
  } catch { return "unknown"; }
}

export function serviceAdmissionsIdle(
  paths: NodePaths, probe: ServiceOwnerProbe = defaultServiceOwnerProbe, onBlocked?: (blocker: ServiceAdmissionBlocker) => void,
): boolean {
  try {
    const current = probe.current();
    for (const name of fs.readdirSync(admissions(paths))) {
      const file = path.join(admissions(paths), name);
      let existing: ReturnType<typeof readOwner>;
      try { existing = readOwner(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("service admission lease owner cannot be verified");
      }
      const blocked = (): false => {
        try {
          onBlocked?.({ leaseId: crypto.createHash("sha256").update(name).digest("hex").slice(0, 12),
            pid: existing.owner.pid, startedAt: new Date(Date.parse(existing.owner.startedAt)).toISOString() });
        } catch { /* Diagnostic failure cannot change the admission decision. */ }
        return false;
      };
      if (existing.owner.pid === current.pid && existing.owner.startedAt === current.startedAt
        && existing.owner.owner === current.owner) return blocked();
      const active = probe.active(existing.owner);
      if (active === true) return blocked();
      if (active === "unknown") throw new Error("service admission lease owner cannot be verified");
      try {
        if (fs.readFileSync(file, "utf8") !== existing.bytes) throw new Error("service admission lease owner changed during verification");
        fs.rmSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return true;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
