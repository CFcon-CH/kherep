import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import type { SourceIdentity } from "./daemon-source.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { acquireServiceOwnerFile, type ServiceOwnerProbe } from "./service-drain.mts";
import { serviceSelector } from "./service-platform.mts";
import { STOP_CODES, type NativeServiceSnapshot, type ServiceBinding, type StopCode } from "./service-types.mts";

export interface ServiceReceipt {
  version: 1;
  binding: ServiceBinding;
  definitionDigest: string;
  securityDigest: string;
  activatedAt: string;
  previousBackup?: string;
}

export interface ServiceBackup {
  version: 1;
  id: string;
  createdAt: string;
  definitionDigest: string;
  securityDigest: string;
  wasRunning: boolean;
  priorSourceStatus: "verified" | "unknown";
  priorSource?: SourceIdentity;
  priorReceipt?: ServiceReceipt;
}

const hash = (value: Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
export const snapshotDigests = (snapshot: NativeServiceSnapshot) =>
  ({ definitionDigest: hash(snapshot.definition), securityDigest: hash(snapshot.security) });

export const serviceRoot = (paths: NodePaths): string => path.join(paths.dir, "service");
const receiptFile = (paths: NodePaths): string => path.join(serviceRoot(paths), "receipt.json");

// Through writeJsonAtomic: a Windows hold on the target is retried (issue
// #540) and a failed write leaves no temp file behind.
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, value);
}

// #582: RegExp.test and path.isAbsolute take any value (a hand-edited ["<valid>"] passes the first, throws in the
// second), so every pattern and path check accepts a string only and anything else is simply invalid.
const matches = (pattern: RegExp, value: unknown): boolean => typeof value === "string" && pattern.test(value);
const absolute = (value: unknown): boolean => typeof value === "string" && path.isAbsolute(value);

function validSource(value: SourceIdentity | undefined, requirePin = false): value is SourceIdentity {
  return Boolean(value && absolute(value.root) && matches(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, value.commit)
    && matches(/^[0-9a-f]{64}$/, value.digest) && value.verified === true
    && (value.kind === "pin" || (!requirePin && value.kind === "checkout")));
}

function validBinding(value: ServiceBinding | undefined, legacyRollback = false): value is ServiceBinding {
  return Boolean(value && ["darwin", "win32"].includes(value.platform) && typeof value.serviceName === "string"
    && value.serviceName.length > 0 && absolute(value.workspace) && absolute(value.configRoot)
    && absolute(value.nodeExecutable) && validSource(value.source, !legacyRollback)
    && (value.logFile === undefined || (value.platform === "win32" && absolute(value.logFile)))
    && (value.platform !== "win32" || (legacyRollback && value.supervisorGeneration === undefined)
      || matches(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, value.supervisorGeneration))
    && (value.taskPath === undefined || (value.platform === "win32" && typeof value.taskPath === "string")));
}

function validReceipt(value: ServiceReceipt | undefined): value is ServiceReceipt {
  return Boolean(value && value.version === 1 && validBinding(value.binding)
    && matches(/^[0-9a-f]{64}$/, value.definitionDigest) && matches(/^[0-9a-f]{64}$/, value.securityDigest)
    && Number.isFinite(Date.parse(value.activatedAt))
    && (value.previousBackup === undefined || matches(/^[0-9]{8,14}-[0-9a-f-]{36}$/, value.previousBackup)));
}

export function readServiceReceipt(paths: NodePaths): ServiceReceipt | null {
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptFile(paths), "utf8")) as ServiceReceipt;
    if (!validReceipt(receipt)) throw new Error("managed service receipt is invalid");
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeServiceReceipt(paths: NodePaths, receipt: ServiceReceipt): void { writeJson(receiptFile(paths), receipt); }
export function removeServiceReceipt(paths: NodePaths): void { fs.rmSync(receiptFile(paths), { force: true }); }

export const CANDIDATE_COMMANDS = ["install", "upgrade", "rollback"] as const;
export interface ServiceCandidate {
  version: 1 | 2;
  phase?: "prepared" | "attested";
  preparedAt?: string;
  binding: ServiceBinding;
  definitionDigest: string;
  securityDigest: string;
  backupId?: string;
  command: typeof CANDIDATE_COMMANDS[number];
  stage?: string;
  blocker?: string;
  stopCode?: StopCode;
  failedAt?: string;
  // Rollback's safety snapshot is distinct from the receipt-bound prior backup.
  recoveryBackupId?: string;
  recoveryBinding?: ServiceBinding;
  receiptAnchor?: ServiceReceipt;
}
const candidateFile = (paths: NodePaths): string => path.join(serviceRoot(paths), "candidate.json");
const BACKUP_ID = /^[0-9]{8,14}-[0-9a-f-]{36}$/;
// #582: failedAt is printed by status, so only the shape toISOString() writes is accepted (no embedded text).
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;
// PR #599 P3-2: status echoes a record's service name, so it must be one the CLI could have selected (serviceSelector).
function selectable(binding: ServiceBinding): boolean {
  try {
    const selected = serviceSelector(binding.platform, binding.serviceName, binding.taskPath);
    return selected.serviceName === binding.serviceName && selected.taskPath === binding.taskPath;
  } catch { return false; }
}
function validCandidate(value: ServiceCandidate | undefined): value is ServiceCandidate {
  // A rollback can restore an attested legacy definition that predates managed supervisors.
  // This describes its backup target only; native validateManaged/process checks are never bypassed.
  const legacyRollback = value?.version === 2 && value.command === "rollback"
    && validReceipt(value.receiptAnchor) && validBinding(value.recoveryBinding)
    && ["platform", "serviceName", "taskPath", "workspace", "configRoot", "nodeExecutable", "logFile"]
      .every(key => value.binding?.[key as keyof ServiceBinding] === value.receiptAnchor!.binding[key as keyof ServiceBinding]);
  const failed = value?.stage !== undefined || value?.blocker !== undefined || value?.stopCode !== undefined || value?.failedAt !== undefined;
  const failure = value && matches(/^[a-z-]{1,16}$/, value.stage) && matches(/^RECOVERY_[A-Z_]{1,40}$/, value.blocker)
    && (STOP_CODES as readonly unknown[]).includes(value.stopCode)
    && matches(ISO_INSTANT, value.failedAt) && Number.isFinite(Date.parse(value.failedAt!));
  const v2 = value?.version === 2 && ["prepared", "attested"].includes(value.phase!)
    && Object.keys(value).every(key => ["version", "phase", "preparedAt", "binding", "definitionDigest", "securityDigest", "backupId",
      "command", "stage", "blocker", "stopCode", "failedAt", "receiptAnchor", "recoveryBackupId", "recoveryBinding"].includes(key))
    && matches(ISO_INSTANT, value.preparedAt) && Number.isFinite(Date.parse(value.preparedAt!))
    && (!failed || failure)
    && (value.receiptAnchor === undefined || validReceipt(value.receiptAnchor))
    && (value.recoveryBackupId === undefined ? value.recoveryBinding === undefined
      : value.command === "rollback" && matches(BACKUP_ID, value.recoveryBackupId)
        && validBinding(value.recoveryBinding) && validReceipt(value.receiptAnchor));
  return Boolean(value && (value.version === 1 ? failure && value.phase === undefined : v2)
    && validBinding(value.binding, legacyRollback) && selectable(value.binding)
    && matches(/^[0-9a-f]{64}$/, value.definitionDigest) && matches(/^[0-9a-f]{64}$/, value.securityDigest)
    && (value.backupId === undefined ? value.command === "install" : matches(BACKUP_ID, value.backupId))
    && (CANDIDATE_COMMANDS as readonly string[]).includes(value.command));
}
// #582: ENOENT -> null; every other failure, a parse error included, is the fixed message (A2 P2-A). The record is
// self-written, so its content is never quoted back.
export function readServiceCandidate(paths: NodePaths): ServiceCandidate | null {
  let text: string;
  try { text = fs.readFileSync(candidateFile(paths), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("managed service candidate record is invalid");
  }
  let candidate: ServiceCandidate | undefined;
  try { candidate = JSON.parse(text) as ServiceCandidate; } catch { candidate = undefined; }
  if (!validCandidate(candidate)) throw new Error("managed service candidate record is invalid");
  return candidate;
}
export function writeServiceCandidate(paths: NodePaths, candidate: ServiceCandidate): void {
  if (!validCandidate(candidate)) throw new Error("managed service candidate record is invalid");
  writeJson(candidateFile(paths), candidate);
  if (JSON.stringify(readServiceCandidate(paths)) !== JSON.stringify(candidate)) {
    throw new Error("managed service candidate persistence could not be verified");
  }
}
export function removeServiceCandidate(paths: NodePaths): void { fs.rmSync(candidateFile(paths), { force: true }); }

export function saveServiceBackup(paths: NodePaths, snapshot: NativeServiceSnapshot, options: {
  receipt: ServiceReceipt | null; priorSource?: SourceIdentity; now: string;
}): ServiceBackup {
  const id = `${options.now.replace(/[^0-9]/g, "").slice(0, 14)}-${crypto.randomUUID()}`;
  const backups = path.join(serviceRoot(paths), "backups");
  const stage = path.join(backups, `.stage-${id}`);
  const destination = path.join(backups, id);
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  const backup: ServiceBackup = { version: 1, id, createdAt: options.now, ...snapshotDigests(snapshot),
    wasRunning: snapshot.running === true, priorSourceStatus: options.priorSource ? "verified" : "unknown",
    ...(options.priorSource ? { priorSource: options.priorSource } : {}),
    ...(options.receipt ? { priorReceipt: options.receipt } : {}) };
  fs.writeFileSync(path.join(stage, "definition.bin"), snapshot.definition, { mode: 0o600 });
  fs.writeFileSync(path.join(stage, "security.bin"), snapshot.security, { mode: 0o600 });
  writeJson(path.join(stage, "backup.json"), backup);
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  fs.renameSync(stage, destination);
  return backup;
}

export function readServiceBackup(paths: NodePaths, id: string): { backup: ServiceBackup; snapshot: NativeServiceSnapshot } {
  if (!/^[0-9]{8,14}-[0-9a-f-]{36}$/.test(id)) throw new Error("managed service backup id is invalid");
  const dir = path.join(serviceRoot(paths), "backups", id);
  const backup = JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8")) as ServiceBackup;
  const snapshot = { definition: fs.readFileSync(path.join(dir, "definition.bin")),
    security: fs.readFileSync(path.join(dir, "security.bin")), running: backup.wasRunning } satisfies NativeServiceSnapshot;
  const digests = snapshotDigests(snapshot);
  if (backup.version !== 1 || (backup.priorSourceStatus !== "verified" && backup.priorSourceStatus !== "unknown")
    || (backup.priorSourceStatus === "verified") !== Boolean(backup.priorSource)
    || (backup.priorSource !== undefined && !validSource(backup.priorSource))
    || (backup.priorReceipt !== undefined && !validReceipt(backup.priorReceipt))
    || digests.definitionDigest !== backup.definitionDigest || digests.securityDigest !== backup.securityDigest) {
    throw new Error("managed service backup is corrupt");
  }
  return { backup, snapshot };
}

export function acquireServiceLock(paths: NodePaths, probe?: ServiceOwnerProbe): () => void {
  const root = serviceRoot(paths);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "transaction.lock");
  return acquireServiceOwnerFile(file, "another managed service transaction is already active", probe);
}
