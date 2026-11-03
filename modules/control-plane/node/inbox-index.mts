import { inboxInventory, locateInboxRecord, type InboxLocation } from "./inbox-storage.mts";

import {
  getReceipt, unreportedStatuses, type InboxRecord, type ReceiptRecord, type UnreportedStatus,
} from "./inbox.mts";

// Issue #487: the daemon's exchange round read every inbox record, its receipt
// and its progress several times every 2 s, so an idle round over the live
// population (about 1000 settled messages) took longer than the cadence.
//
// One index per daemon process keeps the parsed records in memory. Each call
// validates the cache against the files: one readdir, then one stat per
// <messageId>.json. A record is read again only when it is new or its file
// changed (mtime, size or inode); a vanished one is dropped. Hooks and the CLI
// keep writing the files directly, and their writes change those values.
//
// Fail closed: a failed directory read throws as listInbox does, it is never an
// empty inbox; a stat error re-reads that file instead of trusting the cache;
// an unparseable record throws. Every REVALIDATE_MS the whole cache, receipts
// included, is dropped and rebuilt from the files.
//
// Receipts: only one that settles a final record (delivered or refused, the
// receipt for that state) is cached, and only with the record version it
// settles. Receipts are written by the daemon alone (markReported) and only
// for the record's current state, so such a receipt cannot become unsettling
// without the record changing. Receipts and progress of waiting records are
// read from the files on every call, as before.

export const INDEX_REVALIDATE_MS = 10 * 60_000;

export interface InboxIndex {
  // The current records, oldest first, as listInbox returns them (copies).
  records(): InboxRecord[];
  invalidate(): void;
  // unreportedStatuses over records (by default the current ones).
  unreported(now: number, records?: InboxRecord[]): UnreportedStatus[];
}

interface Entry { location: InboxLocation; file: string; dev: number; ctimeMs: number; mtimeMs: number; size: number; ino: number; record: InboxRecord; receipt?: ReceiptRecord }

function final(record: InboxRecord): boolean {
  return record.state === "delivered" || record.state === "refused";
}

export function inboxIndex(dir: string, options: { now?: () => number; revalidateMs?: number } = {}): InboxIndex {
  const clock = options.now ?? Date.now;
  const revalidateMs = options.revalidateMs ?? INDEX_REVALIDATE_MS;
  const entries = new Map<string, Entry>();
  let rebuiltAt = Number.NEGATIVE_INFINITY;

  const current = (id: string): InboxRecord | null => {
    let location;
    try { location = locateInboxRecord(dir, id, entries.get(id)?.location); } catch (error) { entries.clear(); throw error; }
    if (!location) { entries.delete(id); return null; }
    const { file, stat } = location;
    const cached = entries.get(id);
    if (cached && cached.file === file && cached.dev === stat.dev && cached.ctimeMs === stat.ctimeMs && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) return cached.record;
    entries.delete(id);
    // Stat before read: a write in between leaves a newer file than the
    // cached stat, so the next call reads it again.
    const record = location.record;
    if (record) entries.set(id, { location, file, dev: stat.dev, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, record });
    return record;
  };

  const records = (): InboxRecord[] => {
    const now = clock();
    if (now - rebuiltAt >= revalidateMs) {
      entries.clear();
      rebuiltAt = now;
    }
    let inventory: ReturnType<typeof inboxInventory>;
    try { inventory = inboxInventory(dir); } catch (error) { entries.clear(); throw error; }
    const { ids } = inventory;
    const listed = new Set(ids);
    for (const id of entries.keys()) if (!listed.has(id)) entries.delete(id);
    const records = ids.map(current).filter((r): r is InboxRecord => r !== null);
    try { inventory.validateParents(); } catch (error) { entries.clear(); throw error; }
    return records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      .map((record) => ({ ...record }));
  };

  const receiptOf = (record: InboxRecord): ReceiptRecord | null => {
    const entry = entries.get(record.messageId);
    const settles = entry !== undefined && final(entry.record) && entry.record.state === record.state;
    if (settles && entry.receipt) return entry.receipt;
    const receipt = getReceipt(dir, record.messageId);
    if (settles && receipt?.reportedState === record.state) entry.receipt = receipt;
    return receipt;
  };

  return {
    invalidate: () => { entries.clear(); rebuiltAt = Number.NEGATIVE_INFINITY; },
    records,
    unreported: (now, list = records()) => unreportedStatuses(dir, now, list, receiptOf),
  };
}
