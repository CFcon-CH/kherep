import {mayRetarget} from './message-owner.mts';
import path from 'node:path';
import type { NodePaths } from './config.mts';
import { getMessage, replaceInboxRecordLocked, listInbox, undeliverablePredicate, writeJsonAtomic, type InboxRecord, type OfferedBy, type DeliveryTaskIdentity } from './inbox.mts';
import type {SessionInfo} from '../protocol.mts';
import {isSessionRef} from '../protocol-messages.mts';
import {isTaskId,SUPPORTED_RUNTIMES} from '../protocol-tasks.mts';
import { RecordLockBusy, withRecordLock } from './inbox-record-lock.mts';
import { canonical } from './target-delivery-state.mts';
import { transitionRouteMessages } from './target-delivery-outcome.mts';

// Passive processing changes the exact current rows through their group's
// journal. It neither claims a consumer nor charges an autonomous turn.
export function mutateInboxMessages(paths:NodePaths,ids:string[],change:(row:InboxRecord)=>InboxRecord|null):InboxRecord[] {
  const selected=new Set(ids),groups=new Map<string,NonNullable<InboxRecord['targetAttempt']>>(),changed:InboxRecord[]=[];
  for(const id of selected) {
    const row=getMessage(paths.inbox,id);if(!row)continue;
    if(row.targetAttempt){groups.set(canonical(row.targetAttempt),row.targetAttempt);continue;}
    withRecordLock(paths.inbox,id,()=>{
      const fresh=getMessage(paths.inbox,id);if(!fresh)return;
      if(fresh.targetAttempt)throw Error('strict inbox mutation requires route journal');
      const next=change(fresh);if(!next)return;
      replaceInboxRecordLocked(paths.inbox,id,next);changed.push(next);
    });
  }
  for(const handle of groups.values()) {
    const written=new Set<string>();
    const rows=transitionRouteMessages(paths,{kind:'message',handle},row=>{
      if(!selected.has(row.messageId))return row;
      const next=change(row);if(!next)return row;
      written.add(row.messageId);return next;
    });
    changed.push(...rows.filter(row=>written.has(row.messageId)));
  }
  return changed;
}
function one(paths:NodePaths,id:string,change:(row:InboxRecord)=>InboxRecord|null):InboxRecord|null {
  try{return mutateInboxMessages(paths,[id],change)[0]??null;}catch(error){if(error instanceof RecordLockBusy)return null;throw error;}
}
const waiting=(r:InboxRecord)=>r.state==='accepted'||r.state==='offered';
export function offerInboxMessage(paths:NodePaths,id:string,now:number,offeredBy?:OfferedBy):InboxRecord|null {
  return one(paths,id,row=>{
    if(!waiting(row))return null;
    const {retry:_retry,...rest}=row;
    return {...rest,state:'offered',offers:(row.offers??0)+1,offeredAt:new Date(now).toISOString(),...(offeredBy?{offeredBy}:{})};
  });
}
export function answerInboxMessage(paths:NodePaths,id:string):void {
  one(paths,id,row=>waiting(row)?{...row,state:'delivered'}:null);
}
export function deliverInboxMessage(paths:NodePaths,id:string):void {
  one(paths,id,row=>row.state!=='delivered'?{...row,state:'delivered'}:null);
}
export function retryInboxMessage(paths:NodePaths,id:string):boolean {
  return one(paths,id,row=>row.state==='offered'?{...row,retry:true}:null)!==null;
}
export function refuseInboxMessage(paths:NodePaths,id:string,reason:string,still=waiting):boolean {
  return one(paths,id,row=>still(row)?{...row,state:'refused',reason}:null)!==null;
}
export function setInboxDelivery(paths:NodePaths,id:string,delivery:DeliveryTaskIdentity):void {
  if(!isTaskId(delivery.taskId)||!SUPPORTED_RUNTIMES.includes(delivery.runtime)
    ||delivery.sessionId!==undefined&&!isSessionRef(delivery.sessionId))throw Error('invalid delivery task identity');
  mutateInboxMessages(paths,[id],row=>{if(!delivery.sessionId||!mayRetarget(row,{sessionId:delivery.sessionId,runtime:delivery.runtime==='claude'?'claude-code':'codex'})){if(Object.hasOwn(row,'binding'))throw Error('bound delivery owner differs');}return {...row,delivery};});
}
export function refuseUndeliverableInbox(paths:NodePaths,sessions:SessionInfo[],now:number,afterMs:number,records=listInbox(paths.inbox),terminal=(_ref:string)=>false,closed=(_ref:string)=>false):string[] {
  const still=undeliverablePredicate(sessions,now,afterMs,terminal,closed);
  return records.filter(still).filter(r=>refuseInboxMessage(paths,r.messageId,'target session not running',still)).map(r=>r.messageId);
}
