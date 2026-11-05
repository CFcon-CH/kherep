import fs from "node:fs";
import path from "node:path";
import { isMessageId } from "../protocol-messages.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import { isQueueBinding, type QueueBinding } from "./codex-queue-binding.mts";
import { sameIdentity } from "./codex-queue-cleanup.mts";
import { nativeQueueText } from "./codex-queue-text.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { writeJsonAtomic } from "./inbox.mts";

export const MAX_NATIVE_ATTEMPTS = 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Attempt = {
  version: 1; owner: string; messageId: string; attemptedAt: number; state: string;
  producer: QueueBinding["producer"]; queueId?: string;
  groupMessageIds?: string[]; expectedInput?: QueueBinding["expectedInput"];
};
export interface NativeQueueGroup extends QueueBinding { batchRecorded: boolean }

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
  const result: NativeQueueGroup[] = [];
  for (const [queuedSubmissionId, group] of groups) {
    const first = group[0]!;
    const ids = group.map((record) => record.messageId).sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
    const binding: NativeQueueGroup = { version: 1, owner, queuedSubmissionId, admissionComplete: true,
      batchRecorded: group.every((record) => Array.isArray(record.groupMessageIds)),
      admissionMessageIds: ids, expectedInput: nativeQueueInput(owner, ids.length), producer: first.producer };
    if (!isQueueBinding(binding)) continue;
    if (!group.every((record) => {
      if (record.attemptedAt !== first.attemptedAt || !sameIdentity(binding.producer, record.producer)) return false;
      if (record.groupMessageIds === undefined && record.expectedInput === undefined) return true; // v1: exact native count corroborates completeness
      return Array.isArray(record.groupMessageIds) && equal([...record.groupMessageIds].sort((left, right) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      }), ids)
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
        || (record.groupMessageIds !== undefined && !equal([...record.groupMessageIds].sort((left, right) => {
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        }), [...saved.admissionMessageIds].sort((left, right) => {
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        })))
        || (record.expectedInput !== undefined && !equal(record.expectedInput, saved.expectedInput));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }).map(record => record.messageId);
}
