import { messageOwnerMatches } from "./message-owner.mts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMessageId } from "../protocol-messages.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { getMessage, getReceipt, replaceInboxRecordLocked, writeJsonAtomic, type InboxRecord, type OfferedBy } from "./inbox.mts";
import { readSelected } from "./inbox-selected-read.mts";
import { withRecordLock } from "./inbox-record-lock.mts";

interface Entry { messageId: string; generation: string; fingerprint: string }
interface OfferReceipt { version: 1; owner: string; entries: Entry[] }
const receiptDir = (paths: NodePaths): string => path.join(paths.inbox, "codex-offers");
const receiptFile = (paths: NodePaths, token: string): string => path.join(receiptDir(paths), `${token}.json`);
const fingerprint = (r: InboxRecord): string => crypto.createHash("sha256").update(JSON.stringify([
  r.messageId, r.from, r.toSession, r.text, r.createdAt, r.receivedAt, r.inReplyTo, r.proxyOf, r.taskId,
  r.delivery, r.binding, r.closedTo, r.closedAttempt, r.offers, r.offeredAt, r.offeredBy,
])).digest("hex");

export function codexAckInstruction(owner: string, cli: string, token: string): string {
  return `After actually processing the complete peer messages above, run \`${cli} msg inbox --ack ${token} --from ${owner}\`. `
    + "If tool output is truncated, do not ACK. Fetch and Stop do not acknowledge processing. The Maestro performs this ACK; do not ask the user to do it. "
    + "ACK commits locally; remote Worker persistence and sender receipt are separate.";
}

// Only complete blocks selected for output call this seam. The receipt contains
// IDs and opaque generation fingerprints, never another copy of peer bodies.
export function prepareCodexOffers(paths: NodePaths, records: InboxRecord[], owner: string, token: string,
  now: number, offeredBy: OfferedBy): InboxRecord[] {
  const entries: Entry[] = [], emitted: InboxRecord[] = [];
  ensureDir(receiptDir(paths));
  if (fs.lstatSync(receiptDir(paths)).isSymbolicLink()) throw new Error("invalid Codex receipt directory");
  for (const snapshot of records) withRecordLock(paths.inbox, snapshot.messageId, () => {
    const current = getMessage(paths.inbox, snapshot.messageId);
    if (!current || !messageOwnerMatches(current, { sessionId: owner, runtime: "codex" }, [current.toSession]) || fingerprint(current) !== fingerprint(snapshot)
      || (current.state !== "accepted" && current.state !== "offered")) return;
    const next: InboxRecord = current.state === "accepted" ? { ...current, state: "offered", offers: (current.offers ?? 0) + 1,
      offeredAt: new Date(now).toISOString(), offeredBy } : { ...current };
    const hash = fingerprint(next);
    const previous = next.codexOffer;
    next.codexOffer = previous?.owner === owner && previous.fingerprint === hash ? previous
      : { owner, generation: crypto.randomUUID(), fingerprint: hash };
    entries.push({ messageId: next.messageId, generation: next.codexOffer.generation, fingerprint: hash });
    replaceInboxRecordLocked(paths.inbox, next.messageId, next);
    // Persist before the block can escape. A failed receipt write emits no content.
    writeJsonAtomic(receiptFile(paths, token), { version: 1, owner, entries } satisfies OfferReceipt);
    emitted.push(next);
  });
  return emitted;
}

export function acknowledgeCodexOffer(paths: NodePaths, owner: string, token: string, refs: string[]): string {
  if (!isMessageId(token)) throw new Error("invalid Codex offer receipt");
  const saved = readSelected(receiptFile(paths, token)) as OfferReceipt;
  if (!saved || saved.version !== 1 || saved.owner !== owner || !Array.isArray(saved.entries)
    || saved.entries.length === 0 || saved.entries.length > 10
    || new Set(saved.entries.map(e => e.messageId)).size !== saved.entries.length
    || !saved.entries.every(e => isMessageId(e.messageId) && isMessageId(e.generation) && /^[0-9a-f]{64}$/.test(e.fingerprint))) {
    throw new Error("invalid or wrong-owner Codex offer receipt");
  }
  const matches = (r: InboxRecord | null, e: Entry): r is InboxRecord => !!r && messageOwnerMatches(r, { sessionId: owner, runtime: "codex" }, refs)
    && (r.state === "offered" || r.state === "delivered") && r.codexOffer?.owner === owner
    && r.codexOffer.generation === e.generation && fingerprint(r) === e.fingerprint;
  // Preflight avoids partial commits for already-stale batches. Each mutation
  // checks again under its lock; a racing change fails closed for that record.
  if (!saved.entries.every(e => matches(getMessage(paths.inbox, e.messageId), e))) throw new Error("stale or unavailable Codex offer");
  for (const entry of saved.entries) withRecordLock(paths.inbox, entry.messageId, () => {
    const current = getMessage(paths.inbox, entry.messageId);
    if (!matches(current, entry)) throw new Error("Codex offer changed; ACK incomplete, retry current offer");
    if (current.state !== "delivered") replaceInboxRecordLocked(paths.inbox, entry.messageId, { ...current, state: "delivered" });
  });
  const persisted = saved.entries.every(e => {
    const receipt = getReceipt(paths.inbox, e.messageId);
    return receipt?.reportedState === "delivered" && ["delivered", "replied"].includes(receipt.workerState);
  });
  return `local processing ACK committed for ${saved.entries.length} message(s); Worker ${persisted ? "persistence verified (persisted)" : "persistence pending"}; sender receipt not verified here`;
}
