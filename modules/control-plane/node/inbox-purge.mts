import type {NodePaths} from './config.mts';
import {refuseInboxMessage} from './target-delivery-inbox.mts';
import { inboxRecordLocationSteps, locateInboxRecord, BOUND_NAMESPACE, PROCESSING_NAMESPACE } from "./inbox-storage.mts";
import fs from "node:fs";
import path from "node:path";

import {
  getMessage, getReceipt, INBOX_RETENTION_MS, markRefused, progressFileOf, proxiedFileOf, receiptFileOf,
} from "./inbox.mts";
import { RecordLockBusy, withRecordLock } from "./inbox-record-lock.mts";

function temporaryStat(file: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("invalid inbox temporary file");
    return stat;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function purgeParents(dir: string): [fs.Stats | null, fs.Stats | null,fs.Stats|null] {
  const directory = (file: string): fs.Stats | null => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid inbox directory");
      return stat;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const root = directory(dir);
  return [root, root ? directory(path.join(dir, BOUND_NAMESPACE)) : null,root?directory(path.join(dir,PROCESSING_NAMESPACE)):null];
}
function checkPurgeParents(dir: string, before: ReturnType<typeof purgeParents>): void {
  const after = purgeParents(dir);
  if (!before.every((stat, i) => stat === null ? after[i] === null : after[i]?.dev === stat.dev && after[i]?.ino === stat.ino)) {
    throw new Error("inbox directory changed");
  }
}

// The inbox purge, one step per directory entry (issue #581): the start
// maintenance runs it in time-bounded slices after the daemon connected
// (inbox-start.mts); purgeInbox drains it at once.

// Removes records received more than the retention period ago, and leftover
// temp and record lock files (#627) of that age. Returns the number of records
// removed. A record is never dropped while its sender could still see it
// accepted (issue #195): a waiting one is refused first, and a final one stays
// until a receipt confirms that state, or for one more retention period when no
// receipt comes; both are judged on the record under its lock, where the
// removal happens too, never on the copy listed above (#627). It walks
// the listing taken when it starts; an entry gone since then is skipped, and
// so is one written at or after touchedSince (wall clock): the sliced pass
// leaves a record another writer changed during the pass, such as a refusal
// not yet reported (#195), to the next start.
export function* purgeInboxSteps(dir: string, now: number = Date.now(), maxAgeMs: number = INBOX_RETENTION_MS,
  touchedSince: number = Infinity,paths?:NodePaths): Generator<void, number> {
  yield;
  const parents = purgeParents(dir);
  if (!parents[0]) return 0;
  const locations = yield* inboxRecordLocationSteps(dir); // complete read-only preflight first
  const entries: { file: string; stat: fs.Stats }[] = [];
  for (const parent of [dir, path.join(dir, BOUND_NAMESPACE),path.join(dir,PROCESSING_NAMESPACE)]) {
    yield;
    checkPurgeParents(dir, parents);
    let names: string[];
    try { names = fs.readdirSync(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const name of names) {
      yield;
      checkPurgeParents(dir, parents);
      if (name.endsWith(".tmp") || name.endsWith(".lock")) {
        const file = path.join(parent, name), stat = temporaryStat(file);
        if (stat) entries.push({ file, stat });
      }
    }
  }
  let removed = 0;
  for (const location of locations) {
    yield;
    checkPurgeParents(dir, parents);
    const current = locateInboxRecord(dir, location.record.messageId);
    if (!current || current.stat.mtimeMs >= touchedSince) continue;
    const received = Date.parse(current.record.receivedAt);
    if (!Number.isFinite(received)) throw new Error("invalid inbox retention time");
    if (now - received <= maxAgeMs) continue;
    if(current.record.targetAttempt){if(paths)refuseInboxMessage(paths,current.record.messageId,'not delivered within the inbox retention period');continue;}
    if (markRefused(dir, current.record.messageId, "not delivered within the inbox retention period")) continue;
    if (removeSettled(dir, current.record.messageId, received, now, maxAgeMs, touchedSince)) removed++;
  }
  for (const { file, stat: saved } of entries) {
    yield;
    checkPurgeParents(dir, parents);
    try {
      const stat = temporaryStat(file);
      if (!stat || stat.dev !== saved.dev || stat.ino !== saved.ino || stat.size !== saved.size
        || stat.mtimeMs !== saved.mtimeMs || stat.ctimeMs !== saved.ctimeMs) continue;
      if (stat.mtimeMs < touchedSince && now - stat.mtimeMs > maxAgeMs) fs.rmSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

// Removes a record whose state is final and confirmed by a receipt, or final
// and unconfirmed for a second retention period; false when it stays. State,
// receipt and removal are judged on the record under its lock (issue #627): the
// copy the listing read is stale once a writer in another process delivered
// the record meanwhile, and a receipt that confirmed the stale state would
// have dropped a delivery no receipt confirmed (#195). A record that still
// waits (its refusal above found it locked) and a lock that stays busy wait
// for the next pass; no writer can rewrite the record around the removal.
function removeSettled(dir: string, messageId: string, received: number, now: number, maxAgeMs: number, touchedSince: number): boolean {
  try {
    return withRecordLock(dir, messageId, () => {
      const current = getMessage(dir, messageId);
      if (!current || current.state === "accepted" || current.state === "offered") return false;
      const confirmed = getReceipt(dir, messageId)?.reportedState === current.state;
      if (!confirmed && now - received <= 2 * maxAgeMs) return false;
      const location = locateInboxRecord(dir, messageId);
      if (!location || location.stat.mtimeMs >= touchedSince) return false;
      fs.unlinkSync(location.file);
      for (const file of [receiptFileOf(dir, messageId), progressFileOf(dir, messageId), proxiedFileOf(dir, messageId)]) fs.rmSync(file, { force: true });
      return true;
    });
  } catch (error) {
    if (error instanceof RecordLockBusy) return false;
    throw error;
  }
}

// Runs a step generator to its end and returns its result.
export function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

export function purgeInbox(dir: string, now: number = Date.now(), maxAgeMs: number = INBOX_RETENTION_MS,paths?:NodePaths): number {
  return drain(purgeInboxSteps(dir, now, maxAgeMs,Infinity,paths));
}
