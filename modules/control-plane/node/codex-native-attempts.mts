import { routeQueueGroups } from "./target-delivery-queue.mts";
import fs from "node:fs";
import path from "node:path";
import { isMessageId } from "../protocol-messages.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import { isQueueBinding, type QueueBinding } from "./codex-queue-binding.mts";
import { sameIdentity } from "./codex-queue-cleanup.mts";
import { nativeQueueText } from "./codex-queue-text.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { getMessage, writeJsonAtomic } from "./inbox.mts";
import { canonical, keys, object, parseTargetGroup, targetGroupFingerprint, targetProcessedMembersMatch } from "./target-delivery-state.mts";
import { parseTargetReference, targetReference, type TargetReference, type TargetReservation } from "./target-delivery-reservation.mts";
import { readTargetRecord, writeTargetRecord } from "./target-delivery-files.mts";

export const MAX_NATIVE_ATTEMPTS = 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Attempt = {
  version: 1; owner: string; messageId: string; attemptedAt: number; state: string;
  producer: QueueBinding["producer"]; queueId?: string;
  groupMessageIds?: string[]; expectedInput?: QueueBinding["expectedInput"]; targetGroup?: TargetReference;
};
export interface NativeQueueGroup extends QueueBinding { batchRecorded: boolean; targetGroup?: TargetReference }

export function nativeAttemptsPath(paths: NodePaths, owner: string): string {
  return path.join(paths.dir, "codex-native-attempts", owner);
}
function receipts(paths: NodePaths, owner: string): string {
  return path.join(paths.dir, "codex-native-reconciled", owner);
}
export function nativeQueueInput(owner: string, count: number): QueueBinding["expectedInput"] {
  if (!isCodexSessionId(owner)) throw new Error("codex session id is not a plain name");
  return [{ type: "text", text: nativeQueueText(count), text_elements: [] }];
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function read(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("invalid native queue record");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// One complete bounded snapshot. A failed/partial read is never an empty group.
function attempts(paths: NodePaths, owner: string): Attempt[] {
  const dir = nativeAttemptsPath(paths, owner);
  let names: string[];
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("invalid native attempt directory");
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > MAX_NATIVE_ATTEMPTS) throw new Error("native attempt snapshot exceeds bound");
  return names.map((name) => {
    if (!name.endsWith(".json") || !isMessageId(name.slice(0, -5))) throw new Error("incomplete native attempt snapshot");
    const value = read(path.join(dir, name)) as Attempt | null;
    if (!value || value.version !== 1 || value.owner !== owner || value.messageId !== name.slice(0, -5)
      || !Number.isSafeInteger(value.attemptedAt) || value.attemptedAt < 0
      || !["attempted", "submitted", "uncertain", "cancelled-before-submit"].includes(value.state)) {
      throw new Error("invalid native attempt");
    }
    if (value.targetGroup !== undefined) {
      const reference = parseTargetReference(value.targetGroup), group = targetHistory(paths, reference);
      if (reference.owner !== owner || !group.members.some(m => m.messageId === value.messageId)
        || canonical(group.producer) !== canonical(value.producer) || reference.chargedAt !== value.attemptedAt) throw Error("unbound target attempt");
    }
    return value;
  });
}

export function nativeQueueGroups(paths: NodePaths, owner: string): NativeQueueGroup[] {
  if (!isCodexSessionId(owner)) return [];
  const records = attempts(paths, owner);
  const groups = new Map<string, Attempt[]>();
  for (const record of records) {
    if (record.state !== "submitted") continue;
    if (!record.queueId || !UUID.test(record.queueId)) throw new Error("invalid native queue identity");
    const group = groups.get(record.queueId) ?? [];
    group.push(record); groups.set(record.queueId, group);
  }
  const result: NativeQueueGroup[] = routeQueueGroups(paths, owner);
  for (const [queuedSubmissionId, group] of groups) {
    const first = group[0]!;
    const ids = group.map((record) => record.messageId).sort();
    const binding: NativeQueueGroup = { version: 1, owner, queuedSubmissionId, admissionComplete: true,
      batchRecorded: group.every((record) => Array.isArray(record.groupMessageIds)),
      admissionMessageIds: ids, expectedInput: nativeQueueInput(owner, ids.length), producer: first.producer,
      ...(first.targetGroup ? { targetGroup: first.targetGroup } : {}) };
    if (!isQueueBinding(binding)) continue;
    if (!group.every((record) => {
      if (canonical(record.targetGroup ?? null) !== canonical(first.targetGroup ?? null)) return false;
      if (record.attemptedAt !== first.attemptedAt || !sameIdentity(binding.producer, record.producer)) return false;
      if (record.groupMessageIds === undefined && record.expectedInput === undefined) return true; // v1: exact native count corroborates completeness
      return Array.isArray(record.groupMessageIds) && equal([...record.groupMessageIds].sort(), ids)
        && equal(record.expectedInput, binding.expectedInput);
    })) continue;
    const receipt = path.join(receipts(paths, owner), `${queuedSubmissionId}.json`);
    try {
      const saved = read(receipt);
      if (equal(saved, binding)) continue;
      throw new Error("conflicting native queue receipt");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    result.push(binding);
  }
  return result;
}

// Keep every original attempt: retirement must never authorize another enqueue.
export function retireNativeQueue(paths: NodePaths, binding: QueueBinding): void {
  const dir = receipts(paths, binding.owner);
  ensureDir(dir);
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("invalid native receipt directory");
  writeJsonAtomic(path.join(dir, `${binding.queuedSubmissionId}.json`), binding);
}

// Strict full-history admission check for the one outstanding owner fence.
// Submitted rows clear only with the exact existing reconciliation receipt.
export function outstandingNativeAttempts(paths: NodePaths, owner: string): string[] {
  return attempts(paths, owner).filter(record => {
    if (record.state === "cancelled-before-submit") return false;
    if (record.state !== "submitted" || !record.queueId || !UUID.test(record.queueId)) return true;
    try {
      const saved = read(path.join(receipts(paths, owner), `${record.queueId}.json`)) as NativeQueueGroup;
      return !isQueueBinding(saved) || saved.owner !== owner || saved.queuedSubmissionId !== record.queueId
        || !saved.admissionMessageIds.includes(record.messageId) || !sameIdentity(saved.producer, record.producer)
        || (record.groupMessageIds !== undefined && !equal([...record.groupMessageIds].sort(), [...saved.admissionMessageIds].sort()))
        || (record.expectedInput !== undefined && !equal(record.expectedInput, saved.expectedInput))
        || (record.targetGroup !== undefined && canonical(record.targetGroup) !== canonical(saved.targetGroup ?? null));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }).map(record => record.messageId);
}

const groupFile = (paths: NodePaths, saved: TargetReservation): string =>
  path.join(paths.dir, "target-delivery-groups", saved.owner, `${saved.group.groupId}.json`);
function targetHistory(paths: NodePaths, reference: TargetReference) {
  const value = readTargetRecord(path.join(paths.dir, "target-delivery-groups", reference.owner, `${reference.groupId}.json`));
  if (!object(value) || !keys(value, ["version", "group", "reference"]) || value.version !== 1
    || canonical(parseTargetReference(value.reference)) !== canonical(reference)) throw Error("incomplete target group history");
  const group = parseTargetGroup(value.group);
  if (group.originalId !== reference.owner || group.groupId !== reference.groupId || group.generation !== reference.generation
    || targetGroupFingerprint(group) !== reference.groupFingerprint) throw Error("unbound target group history");
  return group;
}
function completeGroup(paths: NodePaths, saved: TargetReservation): void {
  if (canonical(targetHistory(paths, targetReference(saved))) !== canonical(saved.group)) throw Error("target group history differs");
}
function targetRows(paths: NodePaths, saved: TargetReservation): Attempt[] {
  completeGroup(paths, saved);
  const ids = saved.group.members.map(m => m.messageId), reference = targetReference(saved);
  const rows = attempts(paths, saved.owner).filter(r => r.targetGroup?.groupId === saved.group.groupId);
  if (rows.length !== ids.length || rows.some(r => !ids.includes(r.messageId) || canonical(r.targetGroup) !== canonical(reference)
    || canonical(r.producer) !== canonical(saved.group.producer) || r.attemptedAt !== saved.budget!.chargedAt
    || canonical(r.groupMessageIds) !== canonical(ids) || canonical(r.expectedInput) !== canonical(nativeQueueInput(saved.owner, ids.length)))) throw Error("incomplete target attempt group");
  return rows;
}
// Owner lock is held by the core throughout every write. Partial exclusive
// creates remain fences; only complete identical rows can resume a debit phase.
export function recordTargetAttempts(paths: NodePaths, saved: TargetReservation): void {
  const all = attempts(paths, saved.owner), ids = saved.group.members.map(m => m.messageId);
  if (all.length + ids.filter(id => !all.some(r => r.messageId === id)).length > MAX_NATIVE_ATTEMPTS) throw Error("target attempt capacity full");
  const full = { version: 1, group: saved.group, reference: targetReference(saved) };
  const file = groupFile(paths, saved), previous = readTargetRecord(file);
  if (previous !== null) completeGroup(paths, saved);
  else {
    let count = 0; try { count = fs.readdirSync(path.dirname(file)).length; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (count >= MAX_NATIVE_ATTEMPTS) throw Error("target group capacity full");
    writeTargetRecord(file, full, true);
  }
  for (const messageId of ids) {
    const row = { version: 1, owner: saved.owner, messageId, attemptedAt: saved.budget!.chargedAt, state: "attempted",
      producer: saved.group.producer, groupMessageIds: ids, expectedInput: nativeQueueInput(saved.owner, ids.length), targetGroup: targetReference(saved) };
    const file = path.join(nativeAttemptsPath(paths, saved.owner), `${messageId}.json`), old = readTargetRecord(file);
    if (old !== null) { if (canonical(old) !== canonical(row)) throw Error("target attempt conflicts"); }
    else writeTargetRecord(file, row, true);
  }
  targetRows(paths, saved);
}
export function targetAttemptsInState(paths: NodePaths, saved: TargetReservation, state: string): boolean {
  return targetRows(paths, saved).every(r => r.state === state && (state !== "submitted" || r.queueId === saved.queueId));
}
export function settleTargetAttempts(paths: NodePaths, saved: TargetReservation, state: "uncertain" | "submitted" | "cancelled-before-submit", queueId?: string): void {
  if (state === "submitted" && (!queueId || !UUID.test(queueId))) throw Error("invalid target queue ID");
  for (const row of targetRows(paths, saved)) {
    if (!["attempted", "uncertain"].includes(row.state) && !(row.state === state && row.queueId === queueId)) throw Error("target attempt already settled differently");
    writeTargetRecord(path.join(nativeAttemptsPath(paths, saved.owner), `${row.messageId}.json`),
      { ...row, state, ...(queueId ? { queueId } : {}) });
  }
}
export function targetQueueReconciled(paths: NodePaths, saved: TargetReservation): boolean {
  if (saved.phase !== "submitted" || !saved.queueId || !targetAttemptsInState(paths, saved, "submitted")) return false;
  const records = saved.group.members.map(m => getMessage(paths.inbox, m.messageId));
  if (records.some(r => !r || r.state !== "delivered") || !targetProcessedMembersMatch(saved.group, records as NonNullable<typeof records[number]>[], saved.group.nodeId)) return false;
  const value = readTargetRecord(path.join(receipts(paths, saved.owner), `${saved.queueId}.json`));
  if (!isQueueBinding(value)) return false;
  const receipt = value as NativeQueueGroup;
  return canonical(receipt.targetGroup ?? null) === canonical(targetReference(saved)) && receipt.owner === saved.owner
    && receipt.queuedSubmissionId === saved.queueId && canonical(receipt.admissionMessageIds.slice().sort()) === canonical(saved.group.members.map(m => m.messageId).sort())
    && canonical(receipt.expectedInput) === canonical(nativeQueueInput(saved.owner, saved.group.members.length))
    && canonical(receipt.producer) === canonical(saved.group.producer) && outstandingNativeAttempts(paths, saved.owner).length === 0;
}
