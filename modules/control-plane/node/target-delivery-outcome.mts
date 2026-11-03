import path from 'node:path';
import {readSelected} from './inbox-selected-read.mts';
import {parseProcessingReceipt,processingReceiptMatches,type ProcessingAck} from './target-delivery-processing.mts';
import { canonical, uuid } from './target-delivery-state.mts';
import { parseRouteOutcome, type ExecutionContext, type RouteOutcome, type RouteReservation, type RouteTransition } from './target-delivery-operation.mts';
import { addRouteExecutionAlias, routeMembersCurrent, routeSnapshot, withProcessingAckRoute, withRoute } from './target-delivery-route.mts';
import { compareReplaceTargetMessage, getMessage, type InboxRecord } from './inbox.mts';
import type { NodePaths } from './config.mts';

const fields=['toSession','delivery','closedTo','closedAttempt','codexOffer','state','offers','offeredAt','offeredBy','retry','reason','targetAttempt'];
function patch(before:InboxRecord,after:InboxRecord):NonNullable<RouteTransition['patch']> {
  const set:Record<string,unknown>={},unset:string[]=[];
  for(const key of fields)if(canonical((before as unknown as Record<string,unknown>)[key])!==canonical((after as unknown as Record<string,unknown>)[key])) {
    const value=(after as unknown as Record<string,unknown>)[key];if(value===undefined)unset.push(key);else set[key]=value;
  }
  return {set,unset};
}
function apply(row:InboxRecord,p:NonNullable<RouteTransition['patch']>):InboxRecord {
  const next={...row} as unknown as Record<string,unknown>;
  for(const key of p.unset)delete next[key];Object.assign(next,p.set);return next as unknown as InboxRecord;
}
function replay(paths:NodePaths,s:RouteReservation,save:(s:RouteReservation)=>void):RouteReservation {
  for(let i=0;i<s.transitions.length;i++) {
    const t=s.transitions[i];if(t.applied===true)continue;
    if(!t.patch)throw Error('legacy transition remains fenced');
    const row=getMessage(paths.inbox,t.messageId);if(!row)throw Error('transition member missing');
    if(s.processing&&t.patch.set.state==='delivered'&&!t.ack)throw Error('explicit processing ACK missing');
    if(t.ack){const receipt=readSelected(path.join(paths.inbox,'codex-offers',t.ack.token+'.json'));const rows=s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!);
      if(!processingReceiptMatches(s,receipt,rows)||row.codexOffer?.generation!==t.ack.generation||row.codexOffer.fingerprint!==t.ack.fingerprint||t.ack.owner!==s.owner)throw Error('processing ACK replay differs');}
    const current=routeSnapshot(row);
    if(current!==t.after) {
      if(current!==t.before)throw Error('transition member conflicts');
      const after=apply(row,t.patch);if(routeSnapshot(after)!==t.after)throw Error('transition patch differs');
      compareReplaceTargetMessage(paths.inbox,row,after);
    }
    if(routeSnapshot(getMessage(paths.inbox,t.messageId)!)!==t.after)throw Error('transition readback differs');
    s={...s,transitions:s.transitions.map((x,n)=>n===i?{...x,applied:true}:x)};save(s);
  }
  return s;
}
export function replayRouteTransition(paths:NodePaths,context:ExecutionContext):void {
  if(context.kind!=='message')throw Error('message context required');
  withRoute(paths,context.handle,(s,save)=>{replay(paths,s,save);});
}
// Persist only bounded local field patches. Peer text/origin never enter this
// journal again. Every pending member must be exactly before or exactly after.
export function transitionRouteMessages(paths:NodePaths,context:ExecutionContext,change:(r:InboxRecord)=>InboxRecord):InboxRecord[] {
  if(context.kind!=='message')throw Error('message context required');
  return withRoute(paths,context.handle,(initial,save)=>{
    let s=replay(paths,initial,save);
    if(!routeMembersCurrent(paths,s))throw Error('route transition source changed');
    const before=s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!);
    const after=before.map(r=>({...change(r),targetAttempt:s.handle}));
    const planned:RouteTransition[]=[];
    for(let i=0;i<before.length;i++) {
      const p=patch(before[i],after[i]);
      if(s.processing&&(after[i].toSession!==before[i].toSession||after[i].state==='delivered'&&before[i].state!=='delivered'||before[i].state!=='accepted'&&canonical(before[i])!==canonical(after[i])))throw Error('explicit processing requires exact ACK');
      if(canonical(apply(before[i],p))!==canonical(after[i]))throw Error('immutable message transition');
      if(routeSnapshot(before[i])!==routeSnapshot(after[i]))planned.push({messageId:before[i].messageId,before:routeSnapshot(before[i]),after:routeSnapshot(after[i]),patch:p,applied:false});
    }
    if(planned.length){s={...s,transitions:[...s.transitions,...planned]};save(s);replay(paths,s,save);}
    return before.map(r=>getMessage(paths.inbox,r.messageId)!);
  });
}
// This is the only writer of ACK evidence. Reload the actual receipt under
// the existing owner locks; a caller flag cannot settle a marked route.
export function acknowledgeRouteOffers(paths:NodePaths,handle:import('./target-delivery-reservation.mts').TargetHandle,owner:string,token:string,runtime:"codex"|"claude-code"):void {
 if(!uuid(owner)||!uuid(token))throw Error('processing ACK identity invalid');
 withProcessingAckRoute(paths,handle,{owner,runtime,token},(initial,save)=>{
  let s=replay(paths,initial,save);
  const receipt=parseProcessingReceipt(readSelected(path.join(paths.inbox,'codex-offers',token+'.json')));
  const rows=s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!);
  if(runtime!==s.group.binding.runtime||owner!==receipt.owner||!routeMembersCurrent(paths,s)||!processingReceiptMatches(s,receipt,rows))throw Error('processing ACK membership differs');
  const planned:RouteTransition[]=[];
  for(const [i,row] of rows.entries()){
   const e=receipt.entries[i],ack:ProcessingAck={version:1,token,owner,generation:e.generation,fingerprint:e.fingerprint};
   const existing=s.transitions.filter(t=>t.messageId===row.messageId&&t.ack);
   if(existing.length){if(existing.length!==1||existing[0].applied!==true||canonical(existing[0].ack)!==canonical(ack)||row.state!=='delivered')throw Error('processing ACK changed');continue;}
   if(row.state!=='offered')throw Error('delivered without processing evidence');
   const after={...row,state:'delivered' as const};
   planned.push({messageId:row.messageId,before:routeSnapshot(row),after:routeSnapshot(after),patch:patch(row,after),applied:false,ack});
  }
  if(planned.length){s={...s,transitions:[...s.transitions,...planned]};save(s);replay(paths,s,save);}
 });
}
export function finishRouteEffect(paths:NodePaths,context:ExecutionContext,outcomeValue:RouteOutcome):void {
  if(context.kind!=='message')return;
  const outcome=parseRouteOutcome(outcomeValue);
  withRoute(paths,context.handle,(s,save)=>{
    const kind=(s.consumer??s.group.operation).kind;
    const wanted=kind==='queue'?'queue':kind==='fork'?'fork':kind==='hook-continue'?'hook':kind==='handover'?'handover':'exec';
    if(outcome.kind!=='uncertain'&&outcome.kind!==wanted)throw Error('wrong operation outcome');
    if(!['executing','uncertain','settled','handover'].includes(s.phase))throw Error('route effect did not begin');
    if(canonical(outcome)===canonical(s.outcome)){if(s.phase==='uncertain'&&s.originalResume&&outcome.kind==='exec'&&outcome.threadId===s.owner)save({...s,phase:'settled'});return;}
    if(outcome.kind==='uncertain'&&s.outcome&&s.outcome.kind!=='uncertain'){
      if(s.phase!=='uncertain')save({...s,phase:'uncertain'});return;
    }
    if(s.originalResume&&outcome.kind==='exec'&&outcome.threadId!==s.owner)throw Error('original result identity differs');
    const successor=s.originalResume&&['committed','started','unknown'].includes(s.originalResume.phase)&&s.outcome?.kind==='queue'&&outcome.kind==='exec';
    if(!successor&&s.outcome&&s.outcome.kind!=='uncertain'&&!(s.outcome.kind==='handover'&&s.consumer)) {
      const old=s.outcome as unknown as Record<string,unknown>,next=outcome as unknown as Record<string,unknown>;
      const conflict=s.outcome.kind!==outcome.kind||Object.keys(old).some(key=>old[key]!==null&&canonical(old[key])!==canonical(next[key]));
      if(conflict){
        const conflicts=s.conflicts??[];
        if(!conflicts.some(x=>canonical(x)===canonical(outcome))&&conflicts.length<16)save({...s,conflicts:[...conflicts,outcome]});
        throw Error('conflicting late identity');
      }
    }
    save({...s,phase:outcome.kind==='uncertain'?'uncertain':kind==='handover'?'handover':outcome.kind==='exec'&&outcome.threadId===null||outcome.kind==='fork'&&outcome.turnId===null?'executing':'settled',outcome,outcomes:[...s.outcomes,outcome]});
  });
}
export function bindRouteExecutionSession(paths:NodePaths,context:ExecutionContext,sessionId:string):void {
  if(context.kind!=='message'||!uuid(sessionId))throw Error('execution session unknown');
  addRouteExecutionAlias(paths,context.handle,sessionId);
}
