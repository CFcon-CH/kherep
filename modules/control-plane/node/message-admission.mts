import {assertTargetAddresses} from './target-resume-address.mts';
import {freezeMemberGrants,grantTimesValid} from './message-grant.mts';
import fs from 'node:fs';
import {checkOrigin} from '../message-origin.mts';
import {getMessage,type InboxRecord} from './inbox.mts';
import {readTask,type TaskRecord} from './task-records.mts';
import {authorityAllows,type AdmissionAuthority} from './session-authority.mts';
import {closedFallbackGeneration,livenessAdmission,readLivenessSnapshot,sessionVerdict} from './session-lifecycle.mts';
import {messagePolicyCurrent,type MessageRoute,type PolicyDeps} from './message-admission-policy.mts';
import {checkExecution,routeSnapshot,withCheckedMessageExecution,consumeFreshOriginalRouteContext} from './target-delivery-route.mts';
import {canonical} from './target-delivery-state.mts';
import {verifyPreparedLaunchAgainstReservation} from './target-delivery-launch.mts';
import {producerFile} from './target-delivery-producer.mts';
import type {ExecutionContext,OperationKind,RouteReservation} from './target-delivery-operation.mts';

export type MessageBoundary='queue-spawn'|'outer-spawn'|'prompt-release'|'inner-spawn'|'inner-input'|'fork-helper'|'thread-fork'|'turn-start'|'continuation-output';
export type AdmissionCode='context-unavailable'|'context-changed'|'policy-unavailable'|'authority-unavailable'|'lifecycle-changed'|'producer-changed'|'origin-invalid'|'deadline';
export type AdmissionDecision={ok:true}|{ok:false;code:AdmissionCode};
export interface MessageAdmission {readonly currentRun:unique symbol}
interface State {
  deps:PolicyDeps;authority:AdmissionAuthority|undefined;clock:()=>number;selection:Readonly<MessageRoute>;
  snapshots:Map<string,string>;transitionCount:number;transitionPrefix:string;
  handle:string;operation:string;taskIdentity:string|undefined;executorLifecycle:number|undefined;
}
const contexts=new WeakMap<MessageAdmission,State>();
const taskIdentity=(task:TaskRecord|null):string|undefined=>task?canonical([task.taskId,task.runtime,task.sessionId,task.name,task.permissionMode,fs.realpathSync.native(task.cwd),task.local,task.requestedBy]):undefined;
export interface AdmissionDeps extends PolicyDeps {livenessAuthority?:AdmissionAuthority;now?:()=>number}
// The opaque reference remains process-local. Serializing a handle cannot produce it.
export function bindMessageAdmission(deps:AdmissionDeps,context:ExecutionContext,selection:MessageRoute,records?:readonly InboxRecord[]):ExecutionContext {
  if(context.kind!=='message')throw Error('message admission context missing');
  const s=checkExecution(deps.paths,context,['queue','exec-resume','task-start','fork','hook-continue','handover'])!;
  if(s.originalResume)throw Error('successor requires original admission provenance');
  if(selection.route==='target-queue'||selection.route==='target-resume'){if(s.phase!=='ready'||s.outcomes.length||s.transitions.length||s.targetResume)throw Error('original admission already used');consumeFreshOriginalRouteContext(context);}
  const op=s.consumer??s.group.operation,clock=deps.now??Date.now;
  const members=records??s.group.binding.members.map(m=>getMessage(deps.paths.inbox,m.messageId)!);
  if(members.length!==s.group.binding.members.length||new Set(members.map(m=>m?.messageId)).size!==members.length
    ||s.group.binding.members.some(m=>!members.some(row=>row?.messageId===m.messageId)))throw Error('complete admission membership missing');
  const admission=Object.freeze({}) as MessageAdmission;
  const executor=op.execution.sessionId;
  contexts.set(admission,{deps:{...deps},authority:deps.livenessAuthority,clock,
    selection:Object.freeze({...selection,...(selection.grant==='members'?{memberGrants:freezeMemberGrants(members,selection.memberGrants??[])}:{})}),
    snapshots:new Map(members.map(m=>[m.messageId,routeSnapshot(m)])),transitionCount:s.transitions.length,transitionPrefix:canonical(s.transitions),
    handle:canonical(context.handle),operation:canonical(op),taskIdentity:selection.taskId?taskIdentity(readTask(deps.paths,selection.taskId)):undefined,
    executorLifecycle:executor&&executor!==s.owner?sessionVerdict(deps.paths,{runtime:op.execution.runtime,sessionId:executor},clock()).lifecycleGeneration:undefined});
  return {...context,admission};
}
const kinds:Record<MessageBoundary,OperationKind[]>={
  'queue-spawn':['queue'],'outer-spawn':['exec-resume','task-start'],'prompt-release':['exec-resume','task-start'],
  'inner-spawn':['exec-resume','task-start'],'inner-input':['exec-resume','task-start'],'fork-helper':['fork'],
  'thread-fork':['fork'],'turn-start':['fork'],'continuation-output':['hook-continue'],
};
function evaluateMessageEffect(deps:Pick<PolicyDeps,'paths'>,context:Extract<ExecutionContext,{kind:'message'}>,boundary:MessageBoundary,state:State,s:RouteReservation,purpose:'effect'|'completion'='effect'):AdmissionDecision {
  if(!(purpose==='completion'&&s.phase==='settled'||s.phase==='executing'||boundary==='continuation-output'&&s.phase==='settled'&&s.outcome?.kind==='hook')||canonical(s.consumer??s.group.operation)!==state.operation)return {ok:false,code:'context-changed'};
  const group=s.group.binding,op=s.consumer??s.group.operation;
  try {
    const records=group.members.map(m=>getMessage(deps.paths.inbox,m.messageId)!);
    if(canonical(s.transitions.slice(0,state.transitionCount))!==state.transitionPrefix)return {ok:false,code:'context-changed'};
    for(const row of records) {
      let snapshot=state.snapshots.get(row.messageId);
      for(const transition of s.transitions.slice(state.transitionCount).filter(t=>t.messageId===row.messageId)) {
        if(transition.before!==snapshot||transition.applied!==true)return {ok:false,code:'context-changed'};
        snapshot=transition.after;
      }
      if(routeSnapshot(row)!==snapshot)return {ok:false,code:'context-changed'};
    }
    const now=state.clock();
    if(!Number.isSafeInteger(now)||now<0)return {ok:false,code:'origin-invalid'};
    if(state.taskIdentity!==undefined&&state.taskIdentity!==taskIdentity(readTask(deps.paths,state.selection.taskId!)))return {ok:false,code:'context-changed'};
    const grantBounds=messagePolicyCurrent(state.deps,state.selection,s,records,now,context);
    if(grantBounds===null)return {ok:false,code:'policy-unavailable'};
    const target={runtime:group.runtime,sessionId:group.originalId};
    const publication=readLivenessSnapshot(deps.paths);
    if(!publication||!authorityAllows(state.authority,deps.paths,target,publication.generation,now))return {ok:false,code:'authority-unavailable'};
    const verdict=sessionVerdict(deps.paths,target,now);
    if(verdict.lifecycleGeneration!==group.lifecycleGeneration)return {ok:false,code:'lifecycle-changed'};
    const closed=state.selection.route==='target-resume'||state.selection.route==='target-queue'||state.selection.route==='closed-start'||state.selection.route==='closed-resume'||s.group.operation.kind==='handover';
    if(purpose!=='completion'&&(closed?closedFallbackGeneration(deps.paths,target,now,undefined,state.authority)
      :livenessAdmission(deps.paths,target,state.selection.route==='task-wake'||state.selection.route==='fork-reply'?'wake':'queue',now,undefined,state.authority))===null)return {ok:false,code:'authority-unavailable'};
    const executor=op.execution.sessionId;
    if(executor&&executor!==group.originalId) {
      const target={runtime:op.execution.runtime,sessionId:executor},v=sessionVerdict(deps.paths,target,now);
      if(state.executorLifecycle===undefined||v.lifecycleGeneration!==state.executorLifecycle
        ||(state.selection.route==='closed-resume'?closedFallbackGeneration(deps.paths,target,now,undefined,state.authority):livenessAdmission(deps.paths,target,'wake',now,undefined,state.authority))===null)return {ok:false,code:'authority-unavailable'};
    }
    if(op.producer?.kind==='command') {
      if(!context.launch)return {ok:false,code:'producer-changed'};
      verifyPreparedLaunchAgainstReservation(s,context.launch);
    } else if(!op.producer||op.producer.files.some(f=>canonical(producerFile(f.path))!==canonical(f)))return {ok:false,code:'producer-changed'};
    // Finish disk reads before the final sample; only pure checks follow it.
    const originRows=group.members.map(member=>getMessage(deps.paths.inbox,member.messageId));
    // Sample after synchronous policy/producer reads as well. No grace interval.
    if(s.processing&&purpose==='effect')assertTargetAddresses(deps.paths,originRows.filter((r):r is InboxRecord=>r!==null),{sessionId:s.owner,runtime:s.group.binding.runtime,lifecycleGeneration:s.group.binding.lifecycleGeneration},state.clock());
    const finalNow=state.clock();
    if(!Number.isSafeInteger(finalNow)||finalNow<now)return {ok:false,code:'origin-invalid'};
    if(!grantTimesValid(grantBounds,finalNow))return {ok:false,code:'policy-unavailable'};
    let minimum=Infinity;
    for(const [index,member] of group.members.entries()) {
      const current=originRows[index];
      if(!current||canonical(current.from)!==canonical(member.from)||canonical(current.senderOrigin)!==canonical(member.origin))return {ok:false,code:'origin-invalid'};
      const checked=checkOrigin(current.senderOrigin,member.from.nodeId,purpose==='completion'?Math.min(finalNow,member.deadlineMs-1):finalNow);
      if(!checked.ok)return {ok:false,code:checked.code==='origin-expired'?'deadline':'origin-invalid'};
      if(checked.deadlineMs!==member.deadlineMs)return {ok:false,code:'origin-invalid'};
      minimum=Math.min(minimum,checked.deadlineMs);
    }
    if(minimum!==group.deadlineMs||purpose!=='completion'&&finalNow>=minimum)return {ok:false,code:'deadline'};
    // Re-evaluate authority freshness against the final sample, never a cached decision.
    if(!authorityAllows(state.authority,deps.paths,target,publication.generation,finalNow)
      ||executor&&executor!==group.originalId&&!authorityAllows(state.authority,deps.paths,{runtime:op.execution.runtime,sessionId:executor},publication.generation,finalNow))return {ok:false,code:'authority-unavailable'};
    return {ok:true};
  }catch{return {ok:false,code:'policy-unavailable'};}
}
export function checkMessageEffect(deps:Pick<PolicyDeps,'paths'>,context:ExecutionContext|undefined,boundary:MessageBoundary):AdmissionDecision {
  if(context?.kind==='operator'||context?.kind==='read-only')return {ok:true};
  const state=context?.kind==='message'&&context.admission?contexts.get(context.admission):undefined;
  if(!state||context?.kind!=='message'||state.deps.paths.dir!==deps.paths.dir||state.handle!==canonical(context.handle))return {ok:false,code:'context-unavailable'};
  let s:RouteReservation;
  try {
    s=checkExecution(deps.paths,context,kinds[boundary])!;
  }catch{return {ok:false,code:'context-changed'};}
  return evaluateMessageEffect(deps,context,boundary,state,s);
}
export function withAdmittedHookEffect(deps:Pick<PolicyDeps,'paths'>,context:ExecutionContext|undefined,body:(s:RouteReservation)=>undefined):AdmissionDecision {
  const state=context?.kind==='message'&&context.admission?contexts.get(context.admission):undefined;
  if(!state||context?.kind!=='message'||state.deps.paths.dir!==deps.paths.dir||state.handle!==canonical(context.handle))return {ok:false,code:'context-unavailable'};
  let started=false;
  try {
    return withCheckedMessageExecution(deps.paths,context,['hook-continue'],s=>{
      const decision=evaluateMessageEffect(deps,context,'continuation-output',state,s);
      if(!decision.ok)return decision;
      started=true;
      if(body(s)!==undefined)throw Error('hook admission body must return undefined synchronously');
      return {ok:true};
    });
  }catch(error){if(started)throw error;return {ok:false,code:'context-changed'};}
}

export function requireMessageEffect(deps:Pick<PolicyDeps,'paths'>,context:ExecutionContext|undefined,boundary:MessageBoundary):void {
  const decision=checkMessageEffect(deps,context,boundary);
  if(!decision.ok)throw Error(`message admission refused: ${decision.code}`);
}

export function withAdmittedOriginalSuccessor<T>(deps:Pick<PolicyDeps,'paths'>,context:Extract<ExecutionContext,{kind:'message'}>,s:RouteReservation,body:(bind:(next:RouteReservation,launch:NonNullable<typeof context.launch>)=>Extract<ExecutionContext,{kind:'message'}>)=>T):T {
 const state=context.admission&&contexts.get(context.admission);
 if(!state||state.selection.route!=='target-queue'||state.selection.grant!=='resumeTarget'||state.handle!==canonical(context.handle)||state.deps.paths.dir!==deps.paths.dir)throw Error('original admission unavailable');
 const decision=evaluateMessageEffect(deps,context,'queue-spawn',state,{...s,phase:'executing'});if(!decision.ok)throw Error('original admission changed');
 let active=true,used=false;try{return body((next,launch)=>{if(!active||used)throw Error('successor admission transfer ended');used=true;const op=next.consumer??next.group.operation;
  if(next.originalResume?.phase!=='committed'||op.kind!=='exec-resume')throw Error('successor not committed');
  const admission=Object.freeze({}) as MessageAdmission;
  contexts.set(admission,{...state,selection:Object.freeze({...state.selection,route:'target-resume'}),operation:canonical(op)});
  return {...context,launch,admission};});}finally{active=false;}
}
export function withOriginalCompletionAdmission<T>(deps:Pick<PolicyDeps,'paths'>,context:Extract<ExecutionContext,{kind:'message'}>,body:(s:RouteReservation)=>T):T {
 const state=context.admission&&contexts.get(context.admission);
 if(!state||state.selection.route!=='target-resume'||state.selection.grant!=='resumeTarget'||state.handle!==canonical(context.handle)||state.deps.paths.dir!==deps.paths.dir)throw Error('completion admission unavailable');
 return withCheckedMessageExecution(deps.paths,context,['exec-resume'],s=>{const d=evaluateMessageEffect(deps,context,'outer-spawn',state,s,'completion');if(!d.ok)throw Error('completion admission changed');return body(s);});
}
