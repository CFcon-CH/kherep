import {placeFreshProcessing,processingPlacementCurrent} from './target-delivery-placement.mts';
import {parseProcessingReceipt,processingReceiptMatches} from './target-delivery-processing.mts';
import {readSelected} from './inbox-selected-read.mts';
import {consumeOriginalPointerToken,type OriginalPointerToken} from './target-resume-fence.mts';
import type {OriginalPointerExpectation} from './target-resume-port.mts';
import { cancelUnchargedRoute, recoverOccupiedCancellation } from "./target-delivery-cancel.mts";
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { debitGroup, budgetFile, verifyGroupDebit } from './budget-store.mts';
import { outstandingNativeAttempts } from './codex-native-attempts.mts';
import { withNativeOwnerRecords } from './codex-native-pending.mts';
import { readConfig, type NodePaths } from './config.mts';
import { getMessage, type InboxRecord } from './inbox.mts';
import type { TurnBudget } from './policy.mts';
import { createTargetGroup, canonical, targetMembersMatch, uuid } from './target-delivery-state.mts';
import { parseTargetHandle, type TargetHandle } from './target-delivery-reservation.mts';
import { readTargetRecord, writeTargetRecord } from './target-delivery-files.mts';
import { digest, effectiveRouteSession, parseRouteReservation, parseTargetOperation, type TargetOperation, type RouteReservation, type ExecutionContext, type RouteDecision } from './target-delivery-operation.mts';

export const routeHistory = (paths:NodePaths,h:TargetHandle):string => path.join(paths.dir,'target-delivery-groups',h.owner,`${h.groupId}.route.json`);
const budgetHistory=(paths:NodePaths,s:RouteReservation):string=>path.join(paths.dir,'target-delivery-groups',(s.consumer??s.group.operation).budgetOwner,`${s.handle.groupId}.route.json`);
export const routeAliases=(s:RouteReservation):string[] => [...new Set([s.owner,s.group.operation.execution.sessionId,s.consumer?.execution.sessionId,s.executionSessionId,...(s.adoptions??[]).flatMap(a=>[a.fromSession,a.toSession])].filter((x):x is string=>!!x))].sort();
const aliases=routeAliases;
const freshClaims=new WeakSet<object>();
export function consumeFreshOriginalRouteContext(context:Extract<ExecutionContext,{kind:'message'}>):void {if(!context.freshClaim||!freshClaims.delete(context.freshClaim))throw Error('fresh original claim unavailable');}
const aliasRecord=(s:RouteReservation,owner:string)=>({version:4,owner,handle:s.handle});
function withRouteInternal<T>(paths:NodePaths,handleValue:TargetHandle,body:(s:RouteReservation,save:(n:RouteReservation)=>void)=>T,successor?:{token:OriginalPointerToken;expected:OriginalPointerExpectation},ack?:{owner:string;runtime:"codex"|"claude-code";token:string}):T {
  const handle=parseTargetHandle(handleValue);
  // Read only to discover aliases, then reread every identity under the same locks.
  const initial=parseRouteReservation(readTargetRecord(path.join(paths.dir,'codex-native-pending',`${handle.owner}.json`)));
  return withNativeOwnerRecords(paths,aliases(initial),file=>{
    let s=parseRouteReservation(readTargetRecord(file(handle.owner)));
    if(!processingPlacementCurrent(paths,s))throw Error('processing placement not committed');
    if(canonical(s.handle)!==canonical(handle)) throw Error('route context differs');
    for(const owner of aliases(s)) if(owner!==s.owner&&canonical(readTargetRecord(file(owner)))!==canonical(aliasRecord(s,owner))) throw Error('partial route owner claim');
    if(s.budget&&(canonical(readTargetRecord(routeHistory(paths,handle)))!==canonical(s)||canonical(readTargetRecord(budgetHistory(paths,s)))!==canonical(s))) throw Error('route history incomplete');
    if(successor)consumeOriginalPointerToken(successor.token,successor.expected);
    const receipt=ack?parseProcessingReceipt(readSelected(path.join(paths.inbox,'codex-offers',ack.token+'.json'))):undefined;
    if(ack&&(ack.owner!==s.owner||ack.runtime!==s.group.binding.runtime||!processingReceiptMatches(s,receipt,s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!))))throw Error('processing ACK authority differs');
    let active=true;try{const result=body(s,next=>{
      if(!active)throw Error('route writer ended');
      const n=parseRouteReservation(next);
      if(!s.originalResume&&n.originalResume&&!successor)throw Error('specialized successor required');
      if(!s.consumer&&n.consumer&&!successor&&s.group.operation.kind!=='handover')throw Error('specialized consumer required');
      if(s.originalResume){const old=s.originalResume,r=n.originalResume;
       const allowed:Record<string,string[]>={prepared:['committed','unknown'],committed:['started','unknown'],started:['observed','unknown'],observed:[],unknown:['observed']};
       if(!r||canonical({...r,phase:old.phase})!==canonical(old)||r.phase!==old.phase&&!allowed[old.phase].includes(r.phase))throw Error('successor phase changed');}
      if(successor&&n.originalResume&&(canonical(n.originalResume.successor.producer)!==canonical(successor.expected.resumeProducer)||canonical(n.handle)!==canonical(successor.expected.handle)))throw Error('successor lease differs');
      if(canonical(n.processing)!==canonical(s.processing)||canonical(n.group)!==canonical(s.group)||canonical(n.handle)!==canonical(s.handle)||s.budget&&canonical(n.budget)!==canonical(s.budget)
        ||s.targetResume&&canonical(n.targetResume)!==canonical(s.targetResume)
        ||s.consumer&&canonical(n.consumer)!==canonical(s.consumer)||s.executionSessionId!==n.executionSessionId||s.innerStarted&&!n.innerStarted||canonical(n.outcomes.slice(0,s.outcomes.length))!==canonical(s.outcomes)) throw Error('immutable route binding changed');
      for(const t of n.transitions.slice(s.transitions.length))if(t.ack){const e=receipt?.entries.find(e=>e.messageId===t.messageId);if(!ack||!e||getMessage(paths.inbox,t.messageId)?.state!=='offered'||t.before===t.after||t.applied!==false||canonical(t.ack)!==canonical({version:1,token:ack.token,owner:ack.owner,generation:e.generation,fingerprint:e.fingerprint})||routeSnapshot(getMessage(paths.inbox,t.messageId)!)!==t.before)throw Error('specialized processing ACK required');}
      if(n.transitions.length<s.transitions.length||s.transitions.some((t,i)=>{
        const {applied:old,...binding}=t,next=n.transitions[i],{applied:current,...nextBinding}=next;
        return canonical(binding)!==canonical(nextBinding)||old===true&&current!==true||old===false&&current===true&&routeSnapshot(getMessage(paths.inbox,t.messageId)!)!==t.after;
      }))throw Error('transition history changed');
      const phases=['intent','addressed','converged'];
      if((n.adoptions??[]).length<(s.adoptions??[]).length||(s.adoptions??[]).some((a,i)=>{
        const {phase,...binding}=a,next=n.adoptions?.[i];if(!next)return true;
        const {phase:nextPhase,...nextBinding}=next;
        return canonical(binding)!==canonical(nextBinding)||phases.indexOf(nextPhase)<phases.indexOf(phase);
      }))throw Error('copy adoption history changed');
      writeTargetRecord(file(s.owner),n);
      if(n.budget)for(const history of new Set([routeHistory(paths,handle),budgetHistory(paths,n)]))writeTargetRecord(history,n,readTargetRecord(history)===null);s=n;
    });if(successor&&result&&typeof result==='object'&&'then' in result)throw Error('successor callback must be synchronous');return result;}finally{active=false;}
  });
}
export function withRoute<T>(paths:NodePaths,handle:TargetHandle,body:(s:RouteReservation,save:(n:RouteReservation)=>void)=>T):T {return withRouteInternal(paths,handle,body);}
export function withProcessingAckRoute<T>(paths:NodePaths,handle:TargetHandle,ack:{owner:string;runtime:'codex'|'claude-code';token:string},body:(s:RouteReservation,save:(n:RouteReservation)=>void)=>T):T {return withRouteInternal(paths,handle,body,undefined,ack);}
export function withTargetResumeSuccessor<T>(paths:NodePaths,handle:TargetHandle,token:OriginalPointerToken,expected:OriginalPointerExpectation,body:(s:RouteReservation,save:(n:RouteReservation)=>void)=>T):T {
 return withRouteInternal(paths,handle,(s,save)=>{
  if(!s.processing||s.originalResume||s.consumer||!(s.group.operation.kind==='queue'&&s.outcome?.kind==='queue'&&s.targetResume?.queueId===expected.queueId&&s.phase==='settled'||s.group.operation.kind==='exec-resume'&&expected.queueId===null&&s.phase==='ready')||s.conflicts?.length||s.adoptions?.length||s.transitions.some(t=>t.applied!==true)||!routeMembersCurrent(paths,s))throw Error('successor predecessor differs');
  if(canonical(s.group.operation)!==canonical(expected.operation)||s.group.binding.lifecycleGeneration!==expected.target.lifecycleGeneration||s.owner!==expected.target.sessionId||s.group.binding.runtime!==expected.target.runtime||canonical(s.group.binding.members.map(m=>m.messageId))!==canonical(expected.members))throw Error('native predecessor differs');
  verifyRouteDebit(paths,s);return body(s,save);
 },{token,expected});
}
const debitKey=(s:RouteReservation)=>({groupId:s.handle.groupId,groupFingerprint:s.handle.groupFingerprint,reservationId:s.handle.reservationId});
export function routeSnapshot(record:InboxRecord):string {
  const {messageId,from,toSession,text,createdAt,senderOrigin,inReplyTo,proxyOf,taskId,depth,delivery,closedTo,closedAttempt,codexOffer,state,offers,offeredAt,offeredBy,retry,reason,targetAttempt,binding,loop}=record;
  return digest(JSON.parse(JSON.stringify({messageId,from,toSession,text,createdAt,senderOrigin,inReplyTo,proxyOf,taskId,depth,delivery,closedTo,closedAttempt,codexOffer,state,offers,offeredAt,offeredBy,retry,reason,targetAttempt,binding,loop})));
}
export function routeMembersCurrent(paths:NodePaths,s:RouteReservation):boolean {
  return s.group.binding.members.every(m=>{
    const row=getMessage(paths.inbox,m.messageId);if(!row)return false;
    const changes=s.transitions.filter(t=>t.messageId===m.messageId);
    if(changes.length)return routeSnapshot(row)===changes.at(-1)!.after;
    return targetMembersMatch({...s.group.binding,members:[m],deadlineMs:m.deadlineMs},[row],s.group.binding.nodeId);
  });
}
export function prepareRoute(paths:NodePaths,handle:TargetHandle,now:number,budget:TurnBudget,consumer?:TargetOperation):RouteDecision {
  let result:RouteDecision;
  try {result=withRoute(paths,handle,(s,save)=>{
    if(!routeMembersCurrent(paths,s)||s.adoptions?.some(a=>a.phase!=='converged')||now>=s.group.binding.deadlineMs)throw Error('route members or deadline changed');
    const op=s.consumer??s.group.operation;
    if(op.kind==='handover') {
      if(!consumer)throw Error('handover needs exact consuming operation');
      const chosen=parseTargetOperation(consumer);
      if(chosen.kind==='handover'||chosen.execution.sessionId!==effectiveRouteSession(s)||chosen.budgetOwner!==op.budgetOwner)throw Error('handover consumer differs');
      s={...s,consumer:chosen};save(s);
    }
    if(s.phase!=='reserved'&&s.phase!=='handover'&&s.phase!=='ready')throw Error('route already executed');
    if(!s.budget) {
      const receipt=debitGroup(budgetFile(paths,(s.consumer??s.group.operation).budgetOwner),debitKey(s),now,budget);
      if(receipt.status==='spacing'||receipt.status==='exhausted')return {status:'denied-no-debit' as const,reason:receipt.status,handle:s.handle,referenceRetained:!!s.consumer};
      if(receipt.status!=='debited'&&receipt.status!=='already-debited')return {status:'unknown-fenced' as const,reason:'budget-unknown' as const,handle:s.handle};
      s={...s,phase:'ready',budget:{budgetId:receipt.budgetId,chargedAt:receipt.debit.chargedAt}};save(s);
    }
    verifyRouteDebit(paths,s);return {status:'granted' as const,context:{kind:'message' as const,handle:s.handle}};
  });}catch{return {status:'unknown-fenced',reason:'context-changed',handle};}
  if(result.status==='denied-no-debit'&&!result.referenceRetained)try {
    if(!cancelUnchargedRoute(paths,handle,result.reason))return {status:'unknown-fenced',reason:'budget-unknown',handle};
  }catch{return {status:'unknown-fenced',reason:'budget-unknown',handle};}
  return result;
}
function claimKnownRoute(paths:NodePaths,records:InboxRecord[],operationValue:TargetOperation,
  facts:{policyFingerprint:string;lifecycleGeneration:number;originalId?:string;processing?:{version:1;mode:'explicit-ack'}},now:number,budget:TurnBudget):RouteDecision {
  if(!Number.isSafeInteger(facts.lifecycleGeneration)||facts.lifecycleGeneration<1)throw Error("lifecycle generation unknown");
  const operation=parseTargetOperation(operationValue);
  if(operation.producer?.kind==='command'&&operation.producer.version!==2)return {status:'unknown-fenced',reason:'producer-unknown'};
  const config=readConfig(paths.config);
  if(!config||!records.length||records.length>8)throw Error('route selection unavailable');
  // A downstream handover resolves the original reference, never a new group/budget.
  const references=records.map(r=>r.targetAttempt);
  if(references.some(Boolean)) {
    if(!references.every(h=>h&&canonical(h)===canonical(references[0])))throw Error('mixed route references');
    const h=references[0]!;
    const exact=withRoute(paths,h,s=>canonical(records.map(r=>r.messageId).sort())===canonical(s.group.binding.members.map(m=>m.messageId).sort()));
    if(!exact)return {status:'unknown-fenced',reason:'selection-invalid',handle:h};
    return prepareRoute(paths,h,now,budget,operation);
  }
  const original=facts.originalId??records[0].closedTo??records[0].toSession;
  if(!uuid(original)||!facts.originalId&&records.some(r=>(r.closedTo??r.toSession)!==original))throw Error('original route identity unknown');
  const binding=createTargetGroup({runtime:operation.execution.runtime,originalId:original,nodeId:config.nodeId,policyFingerprint:facts.policyFingerprint,lifecycleGeneration:facts.lifecycleGeneration,producer:null},records,now);
  const group={version:2 as const,binding,operation};
  const handle:TargetHandle={owner:original,groupId:binding.groupId,generation:binding.generation,groupFingerprint:digest(group),reservationId:crypto.randomUUID(),attemptToken:crypto.randomUUID()};
  let saved:RouteReservation={...(facts.processing?{processing:facts.processing}:{}),version:3,owner:original,handle,group,phase:operation.kind==='handover'?'handover':'reserved',budget:null,consumer:null,executionSessionId:null,innerStarted:false,outcomes:[],conflicts:[],transitions:[],outcome:null,adoptions:[]};
  if(!saved.processing)parseRouteReservation(saved);
  if(saved.processing&&(!['queue','exec-resume'].includes(operation.kind)||operation.execution.sessionId!==original||operation.budgetOwner!==original))throw Error('processing operation differs');
  recoverOccupiedCancellation(paths,aliases(saved));
  const claimed=withNativeOwnerRecords(paths,aliases(saved),file=>{
    // Bound the actual common history, including cancellation receipts. Unknown
    // entries cannot be treated as empty space in a partially retained store.
    for(const owner of new Set([original,operation.budgetOwner])) {
      const dir=path.join(paths.dir,'target-delivery-groups',owner);
      if(fs.existsSync(dir)) {
        const entries=fs.readdirSync(dir,{withFileTypes:true});
        if(entries.length>=1024||entries.some(e=>!e.isFile()||!/^[-0-9a-f]+\.(route|cancel)\.json$/.test(e.name)))return false;
      }
    }
    for(const owner of aliases(saved))if(readTargetRecord(file(owner))!==null||outstandingNativeAttempts(paths,owner).length)return false;
    if(saved.processing){saved=placeFreshProcessing(paths,saved,records,(next,create)=>{parseRouteReservation(next);writeTargetRecord(file(original),next,create);if(canonical(readTargetRecord(file(original)))!==canonical(next))throw Error('placement owner readback differs');});}
    else for(const owner of aliases(saved))writeTargetRecord(file(owner),owner===original?saved:aliasRecord(saved,owner),true);

    return true;
  });
  if(!claimed)return {status:'owned',reason:'owned'};
  if(operation.kind==='handover')return {status:'granted',context:{kind:'message',handle}};
  const result=prepareRoute(paths,handle,now,budget);if(result.status==='granted'&&result.context.kind==='message'){const freshClaim=Object.freeze({});freshClaims.add(freshClaim);result.context={...result.context,freshClaim};}return result;
}
export function verifyRouteDebit(paths:NodePaths,s:RouteReservation):void {
  if(!s.budget||!verifyGroupDebit(budgetFile(paths,(s.consumer??s.group.operation).budgetOwner),debitKey(s),s.budget))throw Error('route debit differs');
}
function validateExecutionReservation(paths:NodePaths,context:Extract<ExecutionContext,{kind:'message'}>,s:RouteReservation,kinds:string[],expectedSession?:string,expected?:import('./target-delivery-launch.mts').ExecutionExpectation):void {
    const op=s.consumer??s.group.operation;
    if(expected&&(op.execution.runtime!==expected.runtime||expected.taskId!==undefined&&op.execution.taskId!==expected.taskId
      ||expected.sessionId!==undefined&&op.execution.sessionId!==expected.sessionId||expected.phase!==undefined&&s.phase!==expected.phase))throw Error('execution task/runtime/session/phase differs');
    if(op.producer?.kind==='command'&&op.producer.version!==2)throw Error('legacy producer is a fence');
    if(!kinds.includes(op.kind)||!['ready','executing','uncertain','settled'].includes(s.phase)||expectedSession&&op.execution.sessionId!==expectedSession
      ||s.adoptions?.some(a=>a.phase!=='converged')||s.transitions.some(t=>t.applied===false)||!routeMembersCurrent(paths,s))throw Error('execution context incoherent');
    verifyRouteDebit(paths,s);
}
export function withCheckedMessageExecution<T>(paths:NodePaths,context:Extract<ExecutionContext,{kind:'message'}>,kinds:string[],
  body:(s:RouteReservation,save:(next:RouteReservation)=>void)=>T,expectedSession?:string,expected?:import('./target-delivery-launch.mts').ExecutionExpectation):T {
  if(context?.kind!=='message')throw Error('message execution context required');
  return withRoute(paths,context.handle,(s,save)=>{
    validateExecutionReservation(paths,context,s,kinds,expectedSession,expected);
    return body(s,save);
  });
}
export function checkExecution(paths:NodePaths,context:ExecutionContext|undefined,kinds:string[],expectedSession?:string,expected?:import("./target-delivery-launch.mts").ExecutionExpectation):RouteReservation|null {
  if(!context)throw Error('execution context missing');
  if(context.kind==='operator'||context.kind==='read-only')return null;
  if(context.kind!=='message')throw Error('execution context invalid');
  return withCheckedMessageExecution(paths,context,kinds,s=>s,expectedSession,expected);
}
export function beginRouteEffect(paths:NodePaths,context:ExecutionContext,kinds:string[]):void {
  if(context.kind!=='message')return;
  checkExecution(paths,context,kinds);
  withRoute(paths,context.handle,(s,save)=>{if(s.phase!=='ready')throw Error('route effect already began');save({...s,phase:'executing'});});
}

// A measured new identity joins this exact attempt under the same ordered locks.
export function addRouteExecutionAlias(paths:NodePaths,handle:TargetHandle,sessionId:string,step?:(stage:'alias'|'bound')=>void):void {
  if(!uuid(sessionId))throw Error("execution identity unknown");
  const original=path.join(paths.dir,"codex-native-pending",`${handle.owner}.json`);
  const initial=parseRouteReservation(readTargetRecord(original));
  withNativeOwnerRecords(paths,[...aliases(initial),sessionId],file=>{
    const s=parseRouteReservation(readTargetRecord(file(handle.owner)));
    if(canonical(s.handle)!==canonical(handle)||s.outcome?.kind!=="exec"||s.outcome.threadId!==sessionId
      ||s.executionSessionId!==null&&s.executionSessionId!==sessionId)throw Error("execution alias not measured");
    const existing=readTargetRecord(file(sessionId));
    if(sessionId!==s.owner&&existing!==null&&canonical(existing)!==canonical(aliasRecord(s,sessionId)))throw Error("execution alias owned");
    if(sessionId!==s.owner&&existing===null)writeTargetRecord(file(sessionId),aliasRecord(s,sessionId),true);
    step?.('alias');
    if(s.executionSessionId===sessionId){
      for(const history of new Set([routeHistory(paths,handle),budgetHistory(paths,s)])){
        const old=parseRouteReservation(readTargetRecord(history));
        if(canonical(old)===canonical(s))continue;
        if(old.executionSessionId!==null||canonical({...old,executionSessionId:sessionId})!==canonical(s))throw Error('alias history conflicts');
        writeTargetRecord(history,s);
      }
      return;
    }
    const next={...s,executionSessionId:sessionId};
    writeTargetRecord(file(s.owner),next);step?.('bound');for(const history of new Set([routeHistory(paths,handle),budgetHistory(paths,next)]))writeTargetRecord(history,next);
  });
}

export function beginRouteInnerEffect(paths:NodePaths,context:ExecutionContext):void {
  if(context.kind!=="message")return;
  checkExecution(paths,context,["exec-resume","task-start"]);
  withRoute(paths,context.handle,(s,save)=>{
    if(s.phase!=="executing"||s.innerStarted)throw Error("inner message effect already began");
    save({...s,innerStarted:true});
  });
}

export function claimRouteContext(...args:Parameters<typeof claimRoute>):ExecutionContext|null {
  const result=claimRoute(...args);return result.status==='granted'?result.context:null;
}

// Consume one already handed-over immutable group before unrelated fresh rows.
// No merge, partial membership or address mutation is implied by this selection.
export function selectRouteMembers(records:InboxRecord[]):InboxRecord[] {
  const reference=records.find(r=>r.targetAttempt)?.targetAttempt;
  return reference?records.filter(r=>r.targetAttempt&&canonical(r.targetAttempt)===canonical(reference)):records;
}

export function claimRoute(...args:Parameters<typeof claimKnownRoute>):RouteDecision {
  try{return claimKnownRoute(...args);}catch{return {status:'unknown-fenced',reason:'selection-invalid'};}
}
