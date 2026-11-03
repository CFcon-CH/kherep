import {offerFingerprint as fingerprint,parseProcessingReceipt} from './target-delivery-processing.mts';
import { withRoute } from "./target-delivery-route.mts";
import { acknowledgeRouteOffers, transitionRouteMessages } from "./target-delivery-outcome.mts";
import { readTargetRecord } from "./target-delivery-files.mts";
import { effectiveRouteSession, parseRouteReservation, type RouteReservation } from "./target-delivery-operation.mts";
import { readTask } from './task-records.mts';
import { messageOwnerMatches } from "./message-owner.mts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMessageId } from "../protocol-messages.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { getMessage, getReceipt, replaceInboxRecordLocked, writeJsonAtomic, type InboxRecord, type OfferedBy } from "./inbox.mts";
import { readSelected } from "./inbox-selected-read.mts";
import { withRecordLock } from "./inbox-record-lock.mts";

interface Entry { messageId: string; generation: string; fingerprint: string; address?:string }
interface OfferReceipt { version: 1; owner: string; entries: Entry[] }
function passiveHandover(paths:NodePaths,s:RouteReservation,owner:string):boolean {
  const op=s.group.operation;
  if(op.kind!=='handover'||s.consumer||s.budget||s.phase!=='handover'||op.execution.runtime!=='codex'
    ||s.adoptions?.some(a=>a.phase!=='converged')||effectiveRouteSession(s)!==owner||!op.execution.taskId)return false;
  const task=readTask(paths,op.execution.taskId);
  return !!task&&task.local==='intercom'&&task.runtime==='codex'&&task.sessionId===owner;
}
const receiptDir = (paths: NodePaths): string => path.join(paths.inbox, "codex-offers");
const receiptFile = (paths: NodePaths, token: string): string => path.join(receiptDir(paths), `${token}.json`);

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
  const raw=readTargetRecord(path.join(paths.dir,"codex-native-pending",`${owner}.json`));
  const reference=records.find(r=>r.targetAttempt)?.targetAttempt;
  const route=reference?withRoute(paths,reference,s=>s):raw&&typeof raw==="object"&&(raw as {version?:unknown}).version===3?parseRouteReservation(raw):null;
  const routed=new Set<string>();
  if(route&&(["queue","exec-resume","task-start","hook-continue"].includes((route.consumer??route.group.operation).kind)||passiveHandover(paths,route,owner))) {
    const op=route.consumer??route.group.operation;
    if(owner!==route.owner&&owner!==op.execution.sessionId&&owner!==effectiveRouteSession(route))throw Error("Codex consumer owner differs");
    const selected=records.filter(r=>route.group.binding.members.some(m=>m.messageId===r.messageId));
    if(route.processing&&(records.length!==route.group.binding.members.length||selected.length!==records.length||selected.some((r,i)=>r.messageId!==route.group.binding.members[i].messageId||r.toSession!==route.group.binding.members[i].to.session)))throw Error('complete explicit offer membership required');
    const snapshots=new Map(selected.map(r=>[r.messageId,r]));
    const planned=new Set<string>();
    const changed=transitionRouteMessages(paths,{kind:"message",handle:route.handle},r=>{
      const snapshot=snapshots.get(r.messageId);
      if(!messageOwnerMatches(r,{sessionId:owner,runtime:route.processing?route.group.binding.runtime:"codex"},[r.toSession])||!snapshot||fingerprint(r)!==fingerprint(snapshot)||(r.state!=='accepted'&&r.state!=='offered'))return r;
      const next:InboxRecord=r.state==="accepted"?{...r,state:"offered",offers:(r.offers??0)+1,offeredAt:new Date(now).toISOString(),offeredBy}:{...r};
      const value=fingerprint(next),old=next.codexOffer;
      next.codexOffer=old?.owner===owner&&old.fingerprint===value?old:{owner,generation:crypto.randomUUID(),fingerprint:value};
      planned.add(r.messageId);return next;
    });
    for(const next of changed)if(planned.has(next.messageId)) {
      routed.add(next.messageId);entries.push({messageId:next.messageId,generation:next.codexOffer!.generation,fingerprint:next.codexOffer!.fingerprint,...(route.processing?{address:next.toSession}:{})});emitted.push(next);
    }
    if(entries.length)writeJsonAtomic(receiptFile(paths,token),route.processing?parseProcessingReceipt({version:2,owner,handle:route.handle,entries}):{version:1,owner,entries} satisfies OfferReceipt);
    if(route.processing)return emitted;
  }
  for (const snapshot of records.filter(r=>!routed.has(r.messageId)&&!r.targetAttempt)) withRecordLock(paths.inbox, snapshot.messageId, () => {
    const current = getMessage(paths.inbox, snapshot.messageId);
    if (!current || current.targetAttempt || !messageOwnerMatches(current,{sessionId:owner,runtime:"codex"},[current.toSession]) || fingerprint(current) !== fingerprint(snapshot)
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

export function acknowledgeCodexOffer(paths: NodePaths, owner: string, token: string, refs: string[], runtime?:"codex"|"claude-code"): string {
  if (!isMessageId(token)) throw new Error("invalid Codex offer receipt");
  const value=readSelected(receiptFile(paths, token));
  if(value&&typeof value==='object'&&(value as {version?:unknown}).version===2){
    const saved=parseProcessingReceipt(value);
    if(saved.owner!==owner||!refs.includes(owner))throw Error('wrong processing receipt owner');
    if(runtime!=="codex"&&runtime!=="claude-code")throw Error("processing ACK runtime unavailable");
    acknowledgeRouteOffers(paths,saved.handle,owner,token,runtime);
    return `local processing ACK committed for ${saved.entries.length} message(s); Worker persistence pending; sender receipt not verified`;
  }
  const saved = value as OfferReceipt;
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
  const grouped=new Map<string,NonNullable<InboxRecord["targetAttempt"]>>();
  for(const entry of saved.entries){const r=getMessage(paths.inbox,entry.messageId);if(r?.targetAttempt)grouped.set(r.targetAttempt.groupId,r.targetAttempt);}
  for(const handle of grouped.values())if(withRoute(paths,handle,s=>!!s.processing))throw Error('version 2 processing receipt required');
  for(const handle of grouped.values())transitionRouteMessages(paths,{kind:"message",handle},r=>{
    const entry=saved.entries.find(e=>e.messageId===r.messageId);if(!entry)return r;
    if(!matches(r,entry))throw Error('Codex offer changed before journal ACK');
    return {...r,state:'delivered'};
  });
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
