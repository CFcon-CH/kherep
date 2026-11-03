import type {ProcessingPlacement} from './target-delivery-placement.mts';
import {parseProcessingAck,type ProcessingAck} from './target-delivery-processing.mts';
import type { LaunchBinding, PreparedMessageLaunch } from "./target-delivery-launch.mts";
import { createHash } from 'node:crypto';
import { canonical, hash, integer, keys, object, parseTargetGroup, uuid, type TargetDeliveryGroup } from './target-delivery-state.mts';
import { parseTargetHandle, type TargetHandle, type TargetDebit } from './target-delivery-reservation.mts';

export type OperationKind = 'queue' | 'exec-resume' | 'task-start' | 'fork' | 'hook-continue' | 'handover';
export interface ProducerFile { path:string; realpath:string; sha256:string }
export interface RouteProducer {
  version:1|2; launch?:LaunchBinding; kind:'command'|'hook'; runtime:'codex'|'claude-code'; launchFile:string; launchPrefix:string[];
  files:ProducerFile[]; home:string|null; route:'local'; argsFingerprint:string;
  consumer: { source:'native-hook'; identity:string; epoch:string } | null;
}
export interface TargetOperation {
  version:1; kind:OperationKind; producer:RouteProducer|null; budgetOwner:string;
  execution:{ runtime:'codex'|'claude-code'; sessionId:string|null; taskId:string|null };
}
export interface OperationGroup { version:2; binding:TargetDeliveryGroup; operation:TargetOperation }
export type RouteOutcome =
  | { kind:'queue'; queueId:string }
  | { kind:'exec'; pid:number; pidStart:string|null; threadId:string|null }
  | { kind:'fork'; forkId:string|null; turnId:string|null }
  | { kind:'hook'; emitted:true }
  | { kind:'handover'; sessionId:string }
  | { kind:'uncertain' };
export interface RouteTransition { ack?:ProcessingAck; messageId:string; before:string; after:string; patch?:{set:Record<string,unknown>;unset:string[]}; applied?:boolean }
export interface RouteAdoption {
  taskId:string; runtime:'codex'|'claude'; fromSession:string; toSession:string;
  mappingFingerprint:string; members:{messageId:string;before:string}[];
  phase:'intent'|'addressed'|'converged';
}
export interface OriginalResumeState {version:1;source:'queue'|'direct';successor:TargetOperation;phase:'prepared'|'committed'|'started'|'observed'|'unknown'}
export interface RouteReservation {
  processing?:{version:1;mode:'explicit-ack';placement?:ProcessingPlacement};
  originalResume?:OriginalResumeState;
  targetResume?: {version:1;queueId:string;submittedAt:number;dueAt:number};
  version:3; owner:string; handle:TargetHandle; group:OperationGroup;
  phase:'reserved'|'ready'|'executing'|'uncertain'|'settled'|'handover'|'cancelled-before-debit';
  budget:TargetDebit|null; consumer:TargetOperation|null; executionSessionId:string|null; innerStarted:boolean; outcomes:RouteOutcome[]; conflicts?:RouteOutcome[]; transitions:RouteTransition[]; outcome:RouteOutcome|null; adoptions?:RouteAdoption[];
}
export const effectiveRouteSession=(s:RouteReservation):string|null=>s.adoptions?.filter(a=>a.phase==='converged').at(-1)?.toSession??s.executionSessionId??(s.consumer??s.group.operation).execution.sessionId;
export type ExecutionContext = { kind:'operator' } | { kind:'read-only' } | { kind:'message'; handle:TargetHandle; freshClaim?:object; launch?:PreparedMessageLaunch; admission?:import('./message-admission.mts').MessageAdmission };
export const digest = (value:unknown):string => createHash('sha256').update(canonical(value)).digest('hex');
const text = (x:unknown):x is string => typeof x==='string' && x.length>0 && x.length<=4096 && !x.includes('\0');
export function parseRouteProducer(x:unknown):RouteProducer {
  if(!object(x)||!keys(x,['version','kind','runtime','launchFile','launchPrefix','files','home','route','argsFingerprint','consumer',...(Object.hasOwn(x,'launch')?['launch']:[])])
    ||![1,2].includes(x.version as number)||!['command','hook'].includes(x.kind as string)||!['codex','claude-code'].includes(x.runtime as string)
    ||!text(x.launchFile)||!Array.isArray(x.launchPrefix)||x.launchPrefix.length>32||!x.launchPrefix.every(text)
    ||!Array.isArray(x.files)||x.files.length<1||x.files.length>64||!x.files.every(f=>object(f)&&keys(f,['path','realpath','sha256'])&&text(f.path)&&text(f.realpath)&&hash(f.sha256))
    ||x.home!==null&&!text(x.home)||x.route!=='local'||!hash(x.argsFingerprint)) throw Error('producer facts unknown');
  if(x.version===2) {
    const l=x.launch;
    if(x.kind!=='command'||!object(l)||!keys(l,['version','runtime','executable','platform','inner','outer','cwd','detached','windowsVerbatimArguments','home'])||l.version!==1||l.runtime!==x.runtime||!text(l.executable)||!text(l.cwd)||typeof l.detached!=='boolean'||typeof l.windowsVerbatimArguments!=='boolean'
      ||!['aix','android','darwin','freebsd','haiku','linux','openbsd','sunos','win32','cygwin','netbsd'].includes(l.platform as string)||l.home!==x.home
      ||!object(l.inner)||!keys(l.inner,['file','argsFingerprint'])||!text(l.inner.file)||!hash(l.inner.argsFingerprint)
      ||!object(l.outer)||!keys(l.outer,['file','argsFingerprint'])||!text(l.outer.file)||!hash(l.outer.argsFingerprint))throw Error('complete launch facts unknown');
  }else if(x.launch!==undefined)throw Error('legacy producer cannot acquire launch facts');
  if(x.kind==='hook' ? !object(x.consumer)||!keys(x.consumer,['source','identity','epoch'])||x.consumer.source!=='native-hook'||!hash(x.consumer.identity)||!uuid(x.consumer.epoch) : x.consumer!==null) throw Error('hook producer facts unknown');
  return JSON.parse(JSON.stringify(x)) as RouteProducer;
}
export function parseTargetOperation(x:unknown):TargetOperation {
  if(!object(x)||!keys(x,['version','kind','producer','budgetOwner','execution'])||x.version!==1
    ||!['queue','exec-resume','task-start','fork','hook-continue','handover'].includes(x.kind as string)||!uuid(x.budgetOwner)
    ||!object(x.execution)||!keys(x.execution,['runtime','sessionId','taskId'])||!['codex','claude-code'].includes(x.execution.runtime as string)
    ||x.execution.sessionId!==null&&!uuid(x.execution.sessionId)||x.execution.taskId!==null&&!uuid(x.execution.taskId)) throw Error('invalid target operation');
  const producer=x.producer===null?null:parseRouteProducer(x.producer);
  if(x.kind!=='handover'&&!producer || producer&&producer.runtime!==x.execution.runtime
    ||['queue','exec-resume','hook-continue'].includes(x.kind as string)&&!uuid(x.execution.sessionId)
    ||x.kind==='task-start'&&!uuid(x.execution.taskId)||x.kind==='handover'&&!uuid(x.execution.sessionId)
    ||x.kind==='hook-continue'&&producer?.kind!=='hook'||x.kind!=='hook-continue'&&producer?.kind==='hook') throw Error('operation facts unknown');
  return JSON.parse(JSON.stringify(x)) as TargetOperation;
}
export function parseOperationGroup(x:unknown):OperationGroup {
  if(!object(x)||!keys(x,['version','binding','operation'])||x.version!==2) throw Error('invalid operation group');
  const binding=parseTargetGroup(x.binding),operation=parseTargetOperation(x.operation);
  return {version:2,binding,operation};
}
export function parseRouteOutcome(x:unknown):RouteOutcome {
  if(!object(x)) throw Error('invalid route outcome');
  const shape=(fields:string[])=>keys(x,['kind',...fields]);
  if(x.kind==='uncertain'&&shape([])||x.kind==='queue'&&shape(['queueId'])&&uuid(x.queueId)
    ||x.kind==='hook'&&shape(['emitted'])&&x.emitted===true||x.kind==='handover'&&shape(['sessionId'])&&uuid(x.sessionId)
    ||x.kind==='exec'&&shape(['pid','pidStart','threadId'])&&integer(x.pid)&&(x.pid as number)>0&&(x.pidStart===null||text(x.pidStart))&&(x.threadId===null||uuid(x.threadId))
    ||x.kind==='fork'&&shape(['forkId','turnId'])&&(x.forkId===null||uuid(x.forkId))&&(x.turnId===null||text(x.turnId))) return {...x} as unknown as RouteOutcome;
  throw Error('invalid route outcome');
}
export function parseRouteReservation(x:unknown):RouteReservation {
  if(!object(x)||!keys(x,['version','owner','handle','group','phase','budget','consumer','executionSessionId','innerStarted','outcomes','transitions','outcome',...(Object.hasOwn(x,'conflicts')?['conflicts']:[]),...(Object.hasOwn(x,'adoptions')?['adoptions']:[]),...(Object.hasOwn(x,'targetResume')?['targetResume']:[]),...(Object.hasOwn(x,'originalResume')?['originalResume']:[]),...(Object.hasOwn(x,'processing')?['processing']:[])])||x.version!==3) throw Error('invalid route reservation');
  if(x.processing!==undefined&&(!object(x.processing)||!keys(x.processing,['version','mode','placement'])||x.processing.version!==1||x.processing.mode!=='explicit-ack'))throw Error('processing mode invalid');
  const group=parseOperationGroup(x.group),handle=parseTargetHandle(x.handle);
  if(x.processing){const p=(x.processing as Record<string,unknown>).placement;
    if(!object(p)||!keys(p,['version','phase','members'])||p.version!==1||!['intent','committed'].includes(p.phase as string)||!Array.isArray(p.members)||p.members.length!==group.binding.members.length
      ||p.members.some((m,i)=>!object(m)||!keys(m,['messageId','source','before','after'])||m.messageId!==group.binding.members[i].messageId||!['flat','bound-v1'].includes(m.source as string)||!hash(m.before)||!hash(m.after)))throw Error('processing placement invalid');}
  if(x.owner!==group.binding.originalId||handle.owner!==x.owner||handle.groupId!==group.binding.groupId||handle.generation!==group.binding.generation
    ||handle.groupFingerprint!==digest(group)||!['reserved','ready','executing','uncertain','settled','handover','cancelled-before-debit'].includes(x.phase as string)
    ||x.budget!==null&&(!object(x.budget)||!keys(x.budget,['budgetId','chargedAt'])||!uuid(x.budget.budgetId)||!integer(x.budget.chargedAt))
    ||!Array.isArray(x.transitions)||x.transitions.length>64||!x.transitions.every(t=>object(t)&&keys(t,['messageId','before','after',...(Object.hasOwn(t,'patch')?['patch','applied']:[]),...(Object.hasOwn(t,'ack')?['ack']:[])])&&group.binding.members.some(m=>m.messageId===t.messageId)&&hash(t.before)&&hash(t.after))) throw Error('unbound route reservation');
  if(typeof x.innerStarted!=="boolean"||!Array.isArray(x.outcomes)||x.outcomes.length>16)throw Error("invalid route effect history");
  x.outcomes.forEach(parseRouteOutcome);
  if(x.conflicts!==undefined){if(!Array.isArray(x.conflicts)||x.conflicts.length>16)throw Error('invalid outcome conflicts');x.conflicts.forEach(parseRouteOutcome);}
  for(const t of x.transitions as Record<string,unknown>[]){
    if(t.ack!==undefined){const a=parseProcessingAck(t.ack);if(!x.processing||a.owner!==x.owner||!t.patch)throw Error('processing ACK route differs');}
    if(t.patch===undefined)continue;
    const p=t.patch,fields=['toSession','delivery','closedTo','closedAttempt','codexOffer','state','offers','offeredAt','offeredBy','retry','reason','targetAttempt'];
    if(!object(p)||!keys(p,['set','unset'])||!object(p.set)||!Array.isArray(p.unset)||typeof t.applied!=='boolean'
      ||[...Object.keys(p.set),...p.unset].some(k=>typeof k!=='string'||!fields.includes(k))||Buffer.byteLength(JSON.stringify(p))>16384)throw Error('invalid transition patch');
    if(t.ack&&(!keys(p.set,['state'])||p.set.state!=='delivered'||p.unset.length))throw Error('processing ACK patch invalid');
  }
  if(x.targetResume!==undefined) {
    const t=x.targetResume;
    if(!object(t)||!keys(t,['version','queueId','submittedAt','dueAt'])||t.version!==1||!uuid(t.queueId)
      ||!integer(t.submittedAt)||!integer(t.dueAt)||(t.dueAt as number)-(t.submittedAt as number)!==600_000
      ||group.operation.kind!=='queue'||group.operation.execution.sessionId!==x.owner||group.operation.budgetOwner!==x.owner
      ||!x.outcomes.some(o=>object(o)&&o.kind==='queue'&&o.queueId===t.queueId))throw Error('target resume queue facts invalid');
  }
  if(x.originalResume!==undefined) {
    const r=x.originalResume;
    if(!object(r)||!keys(r,['version','source','successor','phase'])||r.version!==1||!['queue','direct'].includes(r.source as string)||!['prepared','committed','started','observed','unknown'].includes(r.phase as string))throw Error('original successor invalid');
    const op=parseTargetOperation(r.successor);
    if(r.phase==='prepared'&&x.consumer!==null||r.source==='queue'&&(x.outcomes.filter(o=>object(o)&&o.kind==='queue').length!==1||x.outcomes.some(o=>object(o)&&!['queue','exec','uncertain'].includes(o.kind as string)))||r.source==='direct'&&x.outcomes.some(o=>object(o)&&!['exec','uncertain'].includes(o.kind as string))||x.outcomes.filter(o=>object(o)&&o.kind==='exec').length>1||r.phase==='observed'&&(!object(x.outcome)||x.outcome.kind!=='exec'||x.outcome.threadId!==x.owner))throw Error('original outcome history differs');
    if(op.kind!=='exec-resume'||op.execution.sessionId!==x.owner||op.execution.runtime!==group.binding.runtime||op.execution.taskId!==null||op.budgetOwner!==x.owner||!op.producer||op.producer.version!==2||op.producer.launch?.detached!==true
      ||(x.adoptions as unknown[]|undefined)?.length||(x.conflicts as unknown[]|undefined)?.length
      ||r.source==='queue'&&(!x.targetResume||group.operation.kind!=='queue')||r.source==='direct'&&(x.targetResume!==undefined||canonical(op)!==canonical(group.operation))
      ||r.phase!=='prepared'&&canonical(x.consumer??group.operation)!==canonical(op))throw Error('original successor binding differs');
  }
  if(x.executionSessionId!==null&&!uuid(x.executionSessionId))throw Error("invalid execution session");
  if(x.consumer!==null) parseTargetOperation(x.consumer);
  if(x.adoptions!==undefined) {
    if(!Array.isArray(x.adoptions)||x.adoptions.length>16)throw Error('copy adoption capacity');
    for(let i=0;i<x.adoptions.length;i++) {
      const a=x.adoptions[i];
      if(!object(a)||!keys(a,['taskId','runtime','fromSession','toSession','mappingFingerprint','members','phase'])
        ||!uuid(a.taskId)||!['codex','claude'].includes(a.runtime as string)||!uuid(a.fromSession)||!uuid(a.toSession)||a.fromSession===a.toSession
        ||!hash(a.mappingFingerprint)||!['intent','addressed','converged'].includes(a.phase as string)
        ||!Array.isArray(a.members)||a.members.length!==group.binding.members.length
        ||a.members.some((m,n)=>!object(m)||!keys(m,['messageId','before'])||m.messageId!==group.binding.members[n].messageId||!hash(m.before))
        ||i>0&&(x.adoptions[i-1].phase!=='converged'||a.fromSession!==x.adoptions[i-1].toSession||a.taskId!==x.adoptions[i-1].taskId||a.runtime!==x.adoptions[i-1].runtime))throw Error('copy adoption binding differs');
    }
  }
  if(x.outcome!==null) parseRouteOutcome(x.outcome);
  if(!['reserved','handover','cancelled-before-debit'].includes(x.phase as string)&&x.budget===null) throw Error('missing route debit');
  return JSON.parse(JSON.stringify(x)) as RouteReservation;
}

export type RouteReason='spacing'|'exhausted'|'owned'|'producer-unknown'|'lifecycle-unknown'|'context-changed'|'budget-unknown'|'selection-invalid'|'deadline';
export type RouteDecision={status:'granted';context:ExecutionContext}|{status:'owned';reason:'owned'}
  |{status:'denied-no-debit';reason:'spacing'|'exhausted';handle:TargetHandle;referenceRetained:boolean}
  |{status:'unknown-fenced';reason:RouteReason;handle?:TargetHandle};
export function grantedContext(result:RouteDecision):ExecutionContext|null{return result.status==='granted'?result.context:null;}
