import crypto from 'node:crypto';
import {isSenderOrigin} from '../message-origin.mts';
import {canonical,hash,keys,object,uuid} from './target-delivery-state.mts';
import type {InboxRecord} from './inbox.mts';
import type {RouteReservation} from './target-delivery-operation.mts';
import {parseTargetHandle,type TargetHandle} from './target-delivery-reservation.mts';

export interface ProcessingAck {version:1;token:string;owner:string;generation:string;fingerprint:string}
export interface ProcessingEntry {messageId:string;generation:string;fingerprint:string;address:string}
export interface ProcessingReceipt {version:2;owner:string;handle:TargetHandle;entries:ProcessingEntry[]}
export function offerFingerprint(r:InboxRecord):string {
 const hasOrigin='senderOrigin' in r;
 if(hasOrigin&&(!isSenderOrigin(r.senderOrigin)||r.senderOrigin.nodeId!==r.from.nodeId))throw Error('invalid Codex offer origin');
 return crypto.createHash('sha256').update(JSON.stringify([
  r.messageId,...(hasOrigin?[r.senderOrigin,r.loop??null]:[]),r.from,r.toSession,r.text,r.createdAt,r.receivedAt,r.inReplyTo,r.proxyOf,r.taskId,
  r.delivery,r.binding,r.closedTo,r.closedAttempt,r.offers,r.offeredAt,r.offeredBy,
 ])).digest('hex');
}
export function parseProcessingAck(x:unknown):ProcessingAck {
 if(!object(x)||!keys(x,['version','token','owner','generation','fingerprint'])||x.version!==1||!uuid(x.token)||!uuid(x.owner)||!uuid(x.generation)||!hash(x.fingerprint))throw Error('invalid processing ACK');
 return {...x} as unknown as ProcessingAck;
}
export function parseProcessingReceipt(x:unknown):ProcessingReceipt {
 if(!object(x)||!keys(x,['version','owner','handle','entries'])||x.version!==2||!uuid(x.owner)||!Array.isArray(x.entries)||!x.entries.length||x.entries.length>8
  ||new Set(x.entries.map(e=>object(e)?e.messageId:null)).size!==x.entries.length
  ||!x.entries.every(e=>object(e)&&keys(e,['messageId','generation','fingerprint','address'])&&uuid(e.messageId)&&uuid(e.generation)&&hash(e.fingerprint)&&typeof e.address==='string'&&e.address.length>0&&e.address.length<=200))throw Error('invalid processing receipt');
 return {...x,handle:parseTargetHandle(x.handle)} as unknown as ProcessingReceipt;
}
export function processingReceiptMatches(s:RouteReservation,value:unknown,rows:readonly InboxRecord[]):boolean {
 try {
  const receipt=parseProcessingReceipt(value),members=s.group.binding.members,op=s.consumer??s.group.operation;
  return s.processing?.mode==='explicit-ack'&&receipt.owner===s.owner&&op.execution.sessionId===s.owner
   &&canonical(receipt.handle)===canonical(s.handle)&&rows.length===members.length&&receipt.entries.length===members.length
   &&members.every((m,i)=>{
    const r=rows[i],e=receipt.entries[i];
    return r?.messageId===m.messageId&&e.messageId===m.messageId&&e.address===m.to.session&&r.toSession===m.to.session
     &&canonical(r.targetAttempt)===canonical(s.handle)&&(r.state==='offered'||r.state==='delivered')
     &&r.codexOffer?.owner===receipt.owner&&r.codexOffer.generation===e.generation&&r.codexOffer.fingerprint===e.fingerprint&&offerFingerprint(r)===e.fingerprint;
   });
 }catch{return false;}
}
// Exact applied journal evidence, not delivered state, is processing proof.
export function explicitProcessingComplete(s:RouteReservation,rows:readonly InboxRecord[],receiptFor:(token:string)=>unknown):boolean {
 if(!s.processing)return !s.targetResume&&!s.originalResume;
 if(rows.length!==s.group.binding.members.length||s.transitions.some(t=>t.applied!==true))return false;
 return rows.every(r=>{
  if(r.state!=='delivered'||!r.codexOffer)return false;
  const tags=s.transitions.filter(t=>t.messageId===r.messageId&&t.ack);
  if(tags.length!==1)return false;
  const ack=tags[0].ack!;
  return ack.owner===s.owner&&ack.owner===r.codexOffer.owner&&ack.generation===r.codexOffer.generation
   &&ack.fingerprint===r.codexOffer.fingerprint&&offerFingerprint(r)===ack.fingerprint&&processingReceiptMatches(s,receiptFor(ack.token),rows);
 });
}
