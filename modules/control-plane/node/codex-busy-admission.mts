import path from "node:path";

import { listenerDir } from "./autonomy.mts";
import { isBusyHintAdmission, type BusyHintAdmission } from "./codex-busy-ticket.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";

// CP-only bookkeeping. Native queue ledgers and bindings are never read or
// changed. A retry retains the authorized generation, including when its
// metadata could not be persisted; restart without it requires fresh admission.
export interface BusyAdmission {
  ticket: BusyHintAdmission;
  messageIds: string[];
  publishedAt?: number;
  invalidated?: boolean;
  recovery?: { messageId: string; firstPublishedAt: number; lastPublishedAt: number; fastRecovered: boolean }[];
}
const volatile = new Map<string, BusyAdmission>();
const file = (paths: NodePaths, owner: string): string => path.join(listenerDir(paths), `${owner}.busy-admission.json`);

export function readBusyAdmission(paths: NodePaths, owner: string): BusyAdmission | null {
  const key = file(paths, owner);
  const memory = volatile.get(key);
  if (memory) return memory;
  let stored: BusyAdmission | null;
  try { stored = readJson<BusyAdmission>(key); } catch { return null; }
  if (!stored || !isBusyHintAdmission(stored.ticket) || stored.ticket.owner !== owner
    || !Array.isArray(stored.messageIds) || !stored.messageIds.length
    || !stored.messageIds.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))
    || (stored.invalidated !== undefined && typeof stored.invalidated !== "boolean")
    || (stored.recovery !== undefined && (!Array.isArray(stored.recovery)
      || new Set(stored.recovery.map(item => item?.messageId)).size !== stored.recovery.length
      || !stored.recovery.every(item => item && stored!.messageIds.includes(item.messageId)
        && Number.isSafeInteger(item.firstPublishedAt) && item.firstPublishedAt >= 0
        && Number.isSafeInteger(item.lastPublishedAt) && item.lastPublishedAt >= item.firstPublishedAt && typeof item.fastRecovered === "boolean")))
    || !stored.ticket.messages.every(({ messageId }) => stored.messageIds.includes(messageId))
    || (stored.publishedAt !== undefined && (!Number.isSafeInteger(stored.publishedAt)
      || stored.publishedAt < stored.ticket.admittedAt || stored.publishedAt >= stored.ticket.expiresAt))) return null;
  return stored;
}

export function saveBusyAdmission(paths: NodePaths, value: BusyAdmission): void {
  const key = file(paths, value.ticket.owner);
  volatile.set(key, value);
  ensureDir(path.dirname(key));
  writeJsonAtomic(key, value);
  volatile.delete(key);
}
