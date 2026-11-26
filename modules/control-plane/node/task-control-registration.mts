import path from "node:path";

import type {
  TaskControlErrorCode, TaskControlRegisterBody, TaskControlRegistrationReceiptBody,
} from "../protocol-task-control.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { getMessage, messageIds, readJson, writeJsonAtomic, type InboxRecord } from "./inbox.mts";

type RegistrationRecord = {
  version: 1;
  body: TaskControlRegisterBody;
  state: "pending" | "registered" | "denied";
  createdAt: string;
  updatedAt: string;
  receipt?: TaskControlRegistrationReceiptBody;
  retryAt?: string;
};

export type RegistrationAuthority = {
  version: 1;
  taskId: string;
  ownerNodeId: string;
  targetNodeId: string;
  runtime: "claude" | "codex";
  sources: Record<string, { grantVersion: number; associationVersion: number }>;
  updatedAt: string;
};

const RETRY_MS = 30_000;
const RETRYABLE = new Set<TaskControlErrorCode>([
  "capability_required", "source_not_found", "unsupported_runtime", "policy_disabled", "target_offline",
]);
const iso = (now: number): string => new Date(now).toISOString();
const registrationsDir = (paths: NodePaths): string => path.join(paths.taskControl, "registrations");
const authoritiesDir = (paths: NodePaths): string => path.join(paths.taskControl, "authorities");
const registrationHistoryDir = (paths: NodePaths): string => path.join(paths.taskControl, "registration-history");
const registrationFile = (paths: NodePaths, sourceMessageId: string): string =>
  path.join(registrationsDir(paths), sourceMessageId + ".json");
const authorityFile = (paths: NodePaths, taskId: string): string => path.join(authoritiesDir(paths), taskId + ".json");
const historyFile = (paths: NodePaths, registrationId: string): string =>
  path.join(registrationHistoryDir(paths), registrationId + ".json");

function readRegistration(paths: NodePaths, sourceMessageId: string): RegistrationRecord | null {
  return readJson<RegistrationRecord>(registrationFile(paths, sourceMessageId));
}

export function readRegistrationAuthority(paths: NodePaths, taskId: string): RegistrationAuthority | null {
  return readJson<RegistrationAuthority>(authorityFile(paths, taskId));
}

function nextRegistration(sourceMessageId: string, taskId: string, runtime: "claude" | "codex",
  associationVersion: number, now: number): RegistrationRecord {
  const at = iso(now);
  return {
    version: 1,
    body: { name: "task.control.register", registrationId: crypto.randomUUID(), taskId, runtime, sourceMessageId,
      associationVersion },
    state: "pending", createdAt: at, updatedAt: at,
  };
}

// records: the caller's inbox snapshot (issue #1012, the exchange round's index
// read); without it the inbox is listed and each record read as it is reached.
function* deliveries(paths: NodePaths, records?: InboxRecord[]): Generator<[string, InboxRecord["delivery"]]> {
  if (records) for (const record of records) yield [record.messageId, record.delivery];
  else for (const id of messageIds(paths.inbox)) yield [id, getMessage(paths.inbox, id)?.delivery];
}

export function ensureDeliveryRegistrations(paths: NodePaths, now: number = Date.now(), records?: InboxRecord[]): void {
  ensureDir(registrationsDir(paths));
  for (const [sourceMessageId, delivery] of deliveries(paths, records)) {
    if (!delivery) continue;
    const existing = readRegistration(paths, sourceMessageId);
    if (existing?.body.taskId === delivery.taskId && existing.body.runtime === delivery.runtime) continue;
    const associationVersion = (existing?.body.associationVersion ?? 0) + 1;
    if (existing) {
      ensureDir(registrationHistoryDir(paths));
      writeJsonAtomic(historyFile(paths, existing.body.registrationId), existing);
    }
    writeJsonAtomic(registrationFile(paths, sourceMessageId),
      nextRegistration(sourceMessageId, delivery.taskId, delivery.runtime, associationVersion, now));
  }
}

export function pendingRegistrations(paths: NodePaths, now: number = Date.now()): TaskControlRegisterBody[] {
  return messageIds(registrationsDir(paths)).flatMap((sourceMessageId) => {
    try {
      const record = readRegistration(paths, sourceMessageId);
      return record?.state === "pending" && (!record.retryAt || Date.parse(record.retryAt) <= now) ? [record.body] : [];
    } catch {
      return [];
    }
  });
}

function storeAuthority(paths: NodePaths, record: RegistrationRecord,
  receipt: Extract<TaskControlRegistrationReceiptBody, { ok: true }>, now: number): boolean {
  const sourceMessageId = record.body.sourceMessageId;
  const message = getMessage(paths.inbox, sourceMessageId);
  if (receipt.taskId !== record.body.taskId || receipt.runtime !== record.body.runtime
    || receipt.associationVersion !== record.body.associationVersion
    || receipt.origin.kind !== "source-message" || receipt.origin.sourceMessageId !== sourceMessageId
    || message?.from.nodeId !== receipt.ownerNodeId) return false;
  const existing = readRegistrationAuthority(paths, receipt.taskId);
  if (existing && (existing.ownerNodeId !== receipt.ownerNodeId || existing.targetNodeId !== receipt.targetNodeId
    || existing.runtime !== receipt.runtime)) return false;
  const prior = existing?.sources[sourceMessageId];
  if (prior && prior.associationVersion > receipt.associationVersion) return true;
  if (prior && prior.associationVersion === receipt.associationVersion) {
    return prior.grantVersion === receipt.grantVersion;
  }
  const authority: RegistrationAuthority = existing
    ? { ...existing, sources: { ...existing.sources,
      [sourceMessageId]: { grantVersion: receipt.grantVersion, associationVersion: receipt.associationVersion } },
      updatedAt: iso(now) }
    : { version: 1, taskId: receipt.taskId, ownerNodeId: receipt.ownerNodeId, targetNodeId: receipt.targetNodeId,
      runtime: receipt.runtime, sources: {
        [sourceMessageId]: { grantVersion: receipt.grantVersion, associationVersion: receipt.associationVersion },
      }, updatedAt: iso(now) };
  ensureDir(authoritiesDir(paths));
  writeJsonAtomic(authorityFile(paths, receipt.taskId), authority);
  return true;
}

export function recordRegistrationReceipt(paths: NodePaths, receipt: TaskControlRegistrationReceiptBody,
  now: number = Date.now()): void {
  const files = [
    ...messageIds(registrationsDir(paths)).map((id) => registrationFile(paths, id)),
    ...messageIds(registrationHistoryDir(paths)).map((id) => historyFile(paths, id)),
  ];
  for (const file of files) {
    const record = readJson<RegistrationRecord>(file);
    if (!record || record.body.registrationId !== receipt.registrationId || record.state !== "pending") continue;
    if (receipt.ok) {
      const accepted = storeAuthority(paths, record, receipt, now);
      writeJsonAtomic(file, { ...record, state: accepted ? "registered" : "denied",
        receipt, retryAt: undefined, updatedAt: iso(now) });
    } else if (file.startsWith(registrationsDir(paths)) && RETRYABLE.has(receipt.errorCode)) {
      writeJsonAtomic(file, { ...record, state: "pending", receipt,
        retryAt: iso(now + RETRY_MS), updatedAt: iso(now) });
    } else {
      writeJsonAtomic(file, { ...record, state: "denied", receipt,
        retryAt: undefined, updatedAt: iso(now) });
    }
    return;
  }
}
