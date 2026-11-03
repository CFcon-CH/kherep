import {assertTargetAddresses} from './target-resume-address.mts';
import {bindMessageAdmission,type AdmissionDeps} from './message-admission.mts';
import type {MessageRoute} from './message-admission-policy.mts';
import { buildMessageLaunch, type LaunchRequest } from "./target-delivery-launch.mts";
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { queueProducerIdentity } from './codex-queue-context.mts';
import { findCodex } from './codex-binary.mts';
import { findClaude, claudeCall } from './sessions.mts';
import { sessionVerdict } from './session-lifecycle.mts';
import { busyPolicyFingerprint } from './codex-busy-policy.mts';
import { parseRouteProducer, digest, type RouteProducer, type TargetOperation, type OperationKind } from './target-delivery-operation.mts';
import { claimRoute } from './target-delivery-route.mts';
import {getMessage,type InboxRecord} from './inbox.mts';
import { wakeBudget, type NodePolicy } from './policy.mts';
import type { RunnerDeps } from './session-runner.mts';
import type { NodePaths } from './config.mts';

export function producerFile(file:string) {
  const absolute=path.resolve(file),stat=fs.statSync(absolute);
  if(!stat.isFile()||stat.size>512*1024*1024)throw Error('producer file unknown');
  const fd=fs.openSync(absolute,'r'),buffer=Buffer.alloc(64*1024),hash=createHash('sha256'),deadline=Date.now()+1000;
  try {for(;;){if(Date.now()>deadline)throw Error('producer identity timeout');const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;hash.update(buffer.subarray(0,n));}}
  finally{fs.closeSync(fd);}
  return {path:absolute,realpath:fs.realpathSync(absolute),sha256:hash.digest('hex')};
}
export function commandProducer(deps:Pick<RunnerDeps,'codex'|'findClaude'|'platform'|'comSpec'>,runtime:'codex'|'claude-code',args:string[],options:Partial<LaunchRequest>={}):RouteProducer|null {
  try{return buildMessageLaunch(deps,{runtime,args,cwd:process.cwd(),...options}).producer;}catch{return null;}
}

export interface RouteFactsDeps extends AdmissionDeps {policy:NodePolicy;messageProducer?:RouteProducer;messageRoute?:MessageRoute}
export function routeFacts(deps:RouteFactsDeps,originalId:string,runtime:'codex'|'claude-code') {
  const lifecycleGeneration=sessionVerdict(deps.paths,{runtime,sessionId:originalId},deps.now?.()??Date.now()).lifecycleGeneration;
  if(lifecycleGeneration===undefined)throw Error('lifecycle generation unknown');
  return {originalId,lifecycleGeneration,policyFingerprint:busyPolicyFingerprint(deps.policy)};
}
export function decideMessageRoute(deps:RouteFactsDeps,records:InboxRecord[],originalId:string,kind:OperationKind,
  execution:TargetOperation['execution'],producer:RouteProducer|null,budgetOwner=originalId,launch?:import("./target-delivery-launch.mts").PreparedMessageLaunch):import("./target-delivery-operation.mts").RouteDecision {
  if(kind!=="handover"&&(!deps.livenessAuthority||!deps.messageRoute))return {status:"unknown-fenced",reason:"lifecycle-unknown"};
  if(kind!=="handover"&&!producer)return {status:"unknown-fenced",reason:"producer-unknown"};
  let facts:ReturnType<typeof routeFacts>;
  try{facts=routeFacts(deps,originalId,execution.runtime);}catch{return {status:"unknown-fenced",reason:"lifecycle-unknown"};}
  try {
    const explicit=deps.messageRoute?.route==='target-queue'||deps.messageRoute?.route==='target-resume';
    if(explicit){assertTargetAddresses(deps.paths,records,{sessionId:originalId,runtime:execution.runtime,lifecycleGeneration:facts.lifecycleGeneration},deps.now?.()??Date.now());facts={...facts,processing:{version:1,mode:'explicit-ack'}} as typeof facts;}
    const result=claimRoute(deps.paths,records,{version:1,kind,execution,producer,budgetOwner},facts,deps.now?.()??Date.now(),wakeBudget(deps.policy));
    if(result.status==="granted"&&result.context.kind==="message"&&launch)result.context={...result.context,launch};
    if(result.status==="granted"&&kind!=="handover"&&deps.messageRoute)result.context=bindMessageAdmission(deps,result.context,deps.messageRoute,explicit?records.map(r=>{const current=getMessage(deps.paths.inbox,r.messageId);if(!current)throw Error('placement member missing');return current;}):records);
    return result;
  }catch{return {status:"unknown-fenced",reason:"selection-invalid"};}
}
export function claimMessageRoute(...args:Parameters<typeof decideMessageRoute>) {
  const result=decideMessageRoute(...args);return result.status==="granted"?result.context:null;
}
