import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {withRecordLock} from './inbox-record-lock.mts';
import {locateInboxRecord,PROCESSING_NAMESPACE,decodeInboxRecord,encodeInboxRecord} from './inbox-storage.mts';
import {readSelected} from './inbox-selected-read.mts';
import {canonical} from './target-delivery-state.mts';
import {writeTargetRecord} from './target-delivery-files.mts';
import type {NodePaths} from './config.mts';
import type {InboxRecord} from './inbox.mts';
import type {RouteReservation} from './target-delivery-operation.mts';

export interface ProcessingPlacement {version:1;phase:'intent'|'committed';members:{messageId:string;source:'flat'|'bound-v1';before:string;after:string}[]}
const digest=(x:unknown)=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
function syncDirectory(dir:string):void {const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function locks<T>(dir:string,ids:string[],body:()=>T):T {const next=(i:number):T=>i===ids.length?body():withRecordLock(dir,ids[i],()=>next(i+1));return next(0);}
function safeDirectory(dir:string):fs.Stats {
 const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||process.platform!=='win32'&&(s.uid!==process.getuid?.()||(s.mode&0o022)!==0))throw Error('unsafe processing directory');return s;
}
// Caller owns route-owner locks. There is deliberately no placement recovery.
export function placeFreshProcessing(paths:NodePaths,value:RouteReservation,snapshots:readonly InboxRecord[],persist:(s:RouteReservation,create:boolean)=>void):RouteReservation {
 if(!value.processing||value.processing.placement||value.budget||value.phase!=='reserved'||snapshots.length!==value.group.binding.members.length)throw Error('fresh processing placement required');
 return locks(paths.inbox,snapshots.map(r=>r.messageId).sort(),()=>{
  const locations=snapshots.map((snapshot,i)=>{
   const loc=locateInboxRecord(paths.inbox,snapshot.messageId);
   if(!loc||loc.namespace===PROCESSING_NAMESPACE||loc.record.state!=='accepted'||loc.record.targetAttempt||loc.record.codexOffer||loc.record.offeredAt||loc.record.offers
    ||snapshot.messageId!==value.group.binding.members[i].messageId||canonical(loc.record)!==canonical(snapshot))throw Error('fresh processing snapshot changed');
   return loc;
  });
  const dir=path.join(paths.inbox,PROCESSING_NAMESPACE);
  try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const directory=safeDirectory(dir);syncDirectory(dir);syncDirectory(paths.inbox);
  for(const loc of locations)if(fs.existsSync(path.join(dir,loc.record.messageId+'.json')))throw Error('processing destination occupied');
  const members:ProcessingPlacement['members']=locations.map(loc=>({messageId:loc.record.messageId,source:loc.namespace as 'flat'|'bound-v1',before:digest(loc.record),after:digest({...loc.record,targetAttempt:value.handle})}));
  let s:RouteReservation={...value,processing:{version:1,mode:'explicit-ack',placement:{version:1,phase:'intent',members}}};persist(s,true);
  for(const loc of locations){
   const after:InboxRecord={...loc.record,targetAttempt:s.handle},destination=path.join(dir,after.messageId+'.json'),temp=path.join(dir,`.placement-${after.messageId}-${crypto.randomUUID()}.tmp`);
   writeTargetRecord(temp,encodeInboxRecord(destination,after),true);
   // Exclusive link publishes without replacing a preexisting destination.
   fs.linkSync(temp,destination);fs.unlinkSync(temp);syncDirectory(dir);
   if(digest(decodeInboxRecord(readSelected(destination),after.messageId,PROCESSING_NAMESPACE))!==digest(after))throw Error('processing target readback differs');
   const current=fs.lstatSync(loc.file);
   if(current.dev!==loc.stat.dev||current.ino!==loc.stat.ino||current.size!==loc.stat.size||current.mtimeMs!==loc.stat.mtimeMs||current.ctimeMs!==loc.stat.ctimeMs||digest(readSelected(loc.file))!==digest(loc.record))throw Error('processing source changed');
   fs.unlinkSync(loc.file);syncDirectory(path.dirname(loc.file));
  }
  const root=fs.lstatSync(paths.inbox);if(locations.some(loc=>loc.parents[0]?.dev!==root.dev||loc.parents[0]?.ino!==root.ino))throw Error('processing root changed');
  const finalDirectory=safeDirectory(dir);if(finalDirectory.dev!==directory.dev||finalDirectory.ino!==directory.ino)throw Error('processing parent changed');
  for(const [i,m] of members.entries()){
   const loc=locateInboxRecord(paths.inbox,m.messageId);if(!loc||loc.namespace!==PROCESSING_NAMESPACE||digest(loc.record)!==m.after||canonical(loc.record.targetAttempt)!==canonical(s.handle))throw Error('processing placement incomplete');
   if(fs.existsSync(locations[i].file))throw Error('processing source remains');
  }
  s={...s,processing:{...s.processing!,placement:{...s.processing!.placement!,phase:'committed'}}};persist(s,false);
  if(!processingPlacementCurrent(paths,s))throw Error('processing commit readback differs');return s;
 });
}
export function processingPlacementCurrent(paths:NodePaths,s:RouteReservation):boolean {
 if(!s.processing)return s.group.binding.members.every(m=>locateInboxRecord(paths.inbox,m.messageId)?.namespace!==PROCESSING_NAMESPACE);
 const placement=s.processing.placement;
 if(!placement||placement.phase!=='committed'||placement.members.length!==s.group.binding.members.length)return false;
 return placement.members.every((member,i)=>{
  const loc=locateInboxRecord(paths.inbox,member.messageId);
  return member.messageId===s.group.binding.members[i].messageId&&loc?.namespace===PROCESSING_NAMESPACE&&canonical(loc.record.targetAttempt)===canonical(s.handle);
 });
}
