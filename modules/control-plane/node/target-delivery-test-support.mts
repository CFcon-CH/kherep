import {captureListedGrant,type MemberGrant} from './message-grant.mts';
import {checkExecution} from './target-delivery-route.mts';
import {readLocalSessions} from './exchange-sessions.mts';
import fs from 'node:fs';
import path from 'node:path';
import { writeConfig, type NodePaths } from './config.mts';
import { writeJsonAtomic, storeMessage } from './inbox.mts';
import { livenessFile } from './session-lifecycle.mts';
import { producerFile } from './target-delivery-producer.mts';
import { claimRoute } from './target-delivery-route.mts';
import { buildMessageLaunch } from './target-delivery-launch.mts';
import type { RouteProducer, ExecutionContext } from './target-delivery-operation.mts';
import type { RunnerDeps } from './session-runner.mts';

// Generated, owned synthetic facts only. Never used by production entrypoints.
export function syntheticHookProducer(paths:NodePaths,owner:string,runtime:'codex'|'claude-code',now:number):RouteProducer {
  fs.mkdirSync(paths.dir,{recursive:true});
  if(!fs.existsSync(paths.config))writeConfig(paths.config,{version:1,controlUrl:'https://control.example.invalid',nodeId:'00000000-0000-4000-8000-0000000000aa',name:'synthetic',publicKey:'',privateKeyFile:'',policyFile:paths.policy,enrolledAt:new Date(now).toISOString()});
  if(!fs.existsSync(paths.policy))fs.writeFileSync(paths.policy,JSON.stringify({version:1,allowedCommands:[]}));
  const file=path.join(paths.dir,'synthetic-hook.mts');if(!fs.existsSync(file))fs.writeFileSync(file,'// public generated hook fixture\n');
  const snapshot=fs.existsSync(livenessFile(paths))?JSON.parse(fs.readFileSync(livenessFile(paths),'utf8')):{version:1,generation:91,sessions:[],tombstones:[]};
  snapshot.sessions=snapshot.sessions.filter((s:{runtime:string;sessionId:string})=>s.runtime!==runtime||s.sessionId!==owner);
  snapshot.sessions.push({runtime,sessionId:owner,state:'running',observedAt:now,reasonCode:'observed',lifecycleGeneration:7});writeJsonAtomic(livenessFile(paths),snapshot);
  return {version:1,kind:'hook',runtime,launchFile:file,launchPrefix:[],files:[producerFile(file)],home:null,route:'local',argsFingerprint:'b'.repeat(64),consumer:{source:'native-hook',identity:'c'.repeat(64),epoch:'00000000-0000-4000-8000-000000000991'}};
}
export function syntheticQueueContext(deps:RunnerDeps,args:string[]):{deps:RunnerDeps;context:ExecutionContext} {
  const now=deps.now?.()??Date.now(),owner=args[2];
  const scoped={...deps,codex:{...deps.codex,home:deps.codex?.home??deps.paths.dir}};
  const launch=buildMessageLaunch(scoped,{runtime:'codex',args,cwd:process.cwd(),detached:(deps.codex?.platform??process.platform)!=='win32'});
  const node=JSON.parse(fs.readFileSync(deps.paths.config,'utf8')).nodeId;
  const row=storeMessage(deps.paths.inbox,{messageId:crypto.randomUUID(),from:{nodeId:node,session:'synthetic'},toSession:owner,text:'public fixture',createdAt:new Date(now).toISOString(),senderOrigin:{nodeId:node,sentAt:new Date(now).toISOString()}},now);
  const setup=syntheticLaunchFacts(deps.paths,owner,launch,{taskId:null,sessionId:owner},deps.now??Date.now,{route:'native-queue',grant:'listed',permissionMode:'default'});
  const result=claimRoute(deps.paths,[row],{version:1,kind:'queue',producer:launch.producer,budgetOwner:owner,execution:{runtime:'codex',sessionId:owner,taskId:null}},
    setup.facts,now,{perHour:100,perDay:100,spacingMs:0});
  if(result.status!=='granted'||result.context.kind!=='message')throw Error('synthetic queue context refused');
  return {deps:{...scoped,policy:setup.deps.policy,livenessAuthority:setup.deps.livenessAuthority},context:setup.bind({...result.context,launch})};
}

import {publishSynthetic,fixtureEvidence} from './session-authority-fixture.mts';
import {readPolicy} from './policy.mts';
import {busyPolicyFingerprint} from './codex-busy-policy.mts';
import {bindMessageAdmission} from './message-admission.mts';
import type {MessageRoute} from './message-admission-policy.mts';
import {recordCodexSession} from './codex-sessions.mts';
import {writeTask} from './task-records.mts';
export function syntheticAuthority(paths:NodePaths,owner:string,runtime:'codex'|'claude-code',now:number,state:'running'|'idle-loaded'|'closed') {
  return publishSynthetic(paths,[{...fixtureEvidence({runtime,sessionId:owner},state,now),
    lifecycle:{status:'value',value:{state:'restored',generation:7},source:'native-lifecycle',observedAt:now,complete:true,reasonCode:'observed'}}],
    now,[...readLocalSessions(paths,now).filter(r=>r.sessionId!==owner||r.runtime!==runtime).flatMap(r=>typeof r.runtime==='string'?[{sessionId:r.sessionId,runtime:r.runtime,state:r.state??'unknown',...(r.name?{name:r.name}:{})}]:[]),{...readLocalSessions(paths,now).find(r=>r.sessionId===owner&&r.runtime===runtime),runtime,sessionId:owner,state}]);
}
// Explicit positive fixture: generated producer AND independently published current-run Authority.
export function syntheticHookFacts(paths:NodePaths,owner:string,runtime:'codex'|'claude-code',now:number) {
  const messageProducer=syntheticHookProducer(paths,owner,runtime,now);
  return {messageProducer,livenessAuthority:syntheticAuthority(paths,owner,runtime,now,'running')};
}
export function syntheticLaunchFacts(paths:NodePaths,owner:string,launch:import('./target-delivery-launch.mts').PreparedMessageLaunch,
  execution:{taskId:string|null;sessionId:string|null},clock:()=>number,selection:MessageRoute|(Omit<MessageRoute,'grant'>&{grant:'listed'})) {
  const runtime=launch.binding.runtime,now=clock(),state=selection.route==='closed-start'||selection.route==='closed-resume'?'closed':selection.route==='native-queue'?'running':'idle-loaded';
  fs.writeFileSync(paths.policy,JSON.stringify({version:1,allowedCommands:[],wake:{enabled:true,sessions:[owner],nativeQueue:true},
    messaging:{accept:[{session:'*',from:['*']}],resumeClosed:true},
    sessions:{enabled:true,runtimes:['codex','claude'],workspaceRoots:[launch.binding.cwd],delegate:{accept:true}}}));
  const policy=readPolicy(paths.policy,true)!;
  const basis=selection.grant==='listed'?captureListedGrant(policy,{runtime:launch.binding.runtime,sessionId:owner}):null;
  const livenessAuthority=syntheticAuthority(paths,owner,runtime,now,state);
  if(selection.route==='native-queue')recordCodexSession(paths,owner,launch.binding.cwd,now,'default');
  if(execution.taskId)writeTask(paths,{taskId:execution.taskId,name:'synthetic-task',runtime:runtime==='codex'?'codex':'claude',
    permissionMode:'default',cwd:launch.binding.cwd,state:'done',...(execution.sessionId?{sessionId:execution.sessionId}:{}),
    startedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),deadline:new Date(now+60000).toISOString()},now);
  const deps={paths,policy,now:clock,livenessAuthority,codex:{home:launch.binding.home??paths.dir}};
  return {deps,facts:{policyFingerprint:busyPolicyFingerprint(policy),lifecycleGeneration:7},
    bind:(context:ExecutionContext&{launch?:import('./target-delivery-launch.mts').PreparedMessageLaunch})=>bindMessageAdmission(deps,context,selection.grant==='listed'?{...selection,grant:'members',memberGrants:checkExecution(paths,context,['queue','exec-resume','task-start','fork'])!.group.binding.members.map(m=>({...basis!,messageId:m.messageId}))}:selection)};
}

import {canonical,targetProcessedMembersMatch} from './target-delivery-state.mts';
import {withRoute,routeMembersCurrent} from './target-delivery-route.mts';
import {getMessage} from './inbox.mts';
import type {RouteReservation} from './target-delivery-operation.mts';
import type {CompletedHookTurn,HookCompletionProvider,HookCompletionExpectation,HookRetirementResult} from './target-delivery-hook-completion.mts';
// Synthetic trusted composition only: a private lease registers at actual writer output,
// and a separate modeled native completion follows real prompt delivery + processing ACK.
export function syntheticHookCompletion(paths:NodePaths) {
 let original:CompletedHookTurn|undefined,completed=false,expired=false,held=false;
 const expectation=(s:RouteReservation):HookCompletionExpectation=>({handle:s.handle,operation:s.consumer??s.group.operation,lifecycleGeneration:s.group.binding.lifecycleGeneration});
 const make=(valid:()=>boolean):HookCompletionProvider=>({withCompletedTurnFence(want,consume){
  if(!original||!valid()||held)return {status:'unavailable'};
  const base={handle:want.handle,operation:want.operation,lifecycleGeneration:want.lifecycleGeneration};
  if(canonical(base)!==canonical({handle:original.handle,operation:original.operation,lifecycleGeneration:original.lifecycleGeneration})
   ||'turnId' in want&&canonical(want)!==canonical(original))return {status:'refused'};
  held=true;try{return consume(structuredClone(original));}finally{held=false;}
 }});
 const provider=make(()=>completed&&!expired);
 return {provider,
  register(s:RouteReservation):void {
   if(original||s.outcome?.kind!=='hook'||s.phase!=='settled')throw Error('synthetic writer registration invalid');
   const facts=expectation(s);if(!facts.operation.execution.sessionId)throw Error('synthetic hook session missing');
   original=structuredClone({...facts,threadId:facts.operation.execution.sessionId,turnId:crypto.randomUUID()});
  },
  complete():boolean {
   if(!original||expired)return false;
   completed=withRoute(paths,original.handle,s=>canonical(expectation(s))===canonical({handle:original!.handle,operation:original!.operation,lifecycleGeneration:original!.lifecycleGeneration})
    &&s.phase==='settled'&&s.outcome?.kind==='hook'&&s.transitions.every(t=>t.applied===true)&&routeMembersCurrent(paths,s)
    &&targetProcessedMembersMatch(s.group.binding,s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!),s.group.binding.nodeId));
   return completed;
  },
  expire():void {expired=true;},
  // A new independently modeled native qualification of the ORIGINAL captured completed turn.
  // Never reads a receipt and cannot reconstruct a turn from serialized state.
  restartQualified():HookCompletionProvider {const qualified=completed&&!!original;return make(()=>qualified);},
 };
}
