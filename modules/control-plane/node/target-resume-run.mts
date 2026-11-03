import {withOriginalPointerExclusion,assertOriginalPointerLease} from './target-resume-fence.mts';
import {prepareOriginalResumeSuccessor} from './target-delivery-successor.mts';
import {beginRouteEffect,withRoute} from './target-delivery-route.mts';
import {finishRouteEffect} from './target-delivery-outcome.mts';
import {requireMessageEffect,type MessageBoundary} from './message-admission.mts';
import {getMessage} from './inbox.mts';
import {frameRecords} from './deliver-core.mts';
import {codexAckInstruction,prepareCodexOffers} from './codex-inbox-ack.mts';
import {registerOriginalResumeObservation,retireCompletedOriginalResult} from './target-resume-completion.mts';
import type {RunnerDeps} from './session-runner.mts';
import type {PendingOriginalResume} from './target-resume-state.mts';
import type {OriginalPointerExpectation,OriginalResumeGuards} from './target-resume-port.mts';
import type {TargetResumeResult} from './target-resume.mts';
export async function runOriginalResume(deps:RunnerDeps,state:PendingOriginalResume):Promise<TargetResumeResult> {
 const {prepared,target}=state;
 if(state.result){const retired=retireCompletedOriginalResult(deps,state.result);return retired.status==='retired'||retired.status==='already-retired'?{status:'completed-original',reason:'completed-original'}:{status:'resumed-original-awaiting-completion',reason:'native-completion-pending'};}
 if(state.candidate&&state.successor){try{commitOriginalObservation(deps,state);return {status:'resumed-original-awaiting-completion',reason:'native-completion-pending'};}catch{return {status:'unknown-fenced',reason:'original-execution-unknown'};}}
 if(state.attempted)return {status:'unknown-fenced',reason:'original-execution-unknown'};
 if(!prepared.resume||!prepared.withRetiredPointerFence)return {status:'unavailable',reason:'original-successor-unavailable'};
 const s=withRoute(deps.paths,state.context.handle,s=>s);
 const rows=s.group.binding.members.map(m=>getMessage(deps.paths.inbox,m.messageId)!);
 const receiptToken=crypto.randomUUID(),cli=deps.cli??'kherep-node';
 const ack=codexAckInstruction(target.sessionId,cli,receiptToken);
 const framed=frameRecords(deps.paths,rows,cli,6*1024-Buffer.byteLength(ack,'utf8')-2,true);
 if(framed.carried.length!==rows.length)return {status:'refused',reason:'original-input-incomplete'};
 const input=framed.text+'\n\n'+ack;
 const expected:OriginalPointerExpectation={target,handle:s.handle,queueId:s.targetResume?.queueId??null,members:s.group.binding.members.map(m=>m.messageId),operation:s.group.operation,resumeProducer:prepared.resumeLaunch.producer};
 try {
  const result=await withOriginalPointerExclusion(prepared,expected,async(token,epoch)=>{
   state.attempted=true;state.epoch=epoch;
   const context=state.successor??prepareOriginalResumeSuccessor(deps,state.context,prepared,token,expected);state.successor=context;
   beginRouteEffect(deps.paths,context,['exec-resume']);
   withRoute(deps.paths,context.handle,(r,save)=>save({...r,originalResume:{...r.originalResume!,phase:'started'}}));
   const offered=prepareCodexOffers(deps.paths,rows,target.sessionId,receiptToken,deps.now?.()??Date.now(),'prompt');
   if(offered.length!==rows.length||offered.some((r,i)=>r.messageId!==rows[i].messageId))throw Error('original offers incomplete');
   const seen=new Set<MessageBoundary>();
   const guard=(boundary:MessageBoundary)=>()=>{
    if(boundary!=='outer-spawn'&&!seen.has('outer-spawn')||boundary==='inner-input'&&(!seen.has('inner-spawn')||!seen.has('prompt-release')))throw Error('original effect order differs');
    if(seen.has(boundary))throw Error('original effect repeated');
    requireMessageEffect(deps,context,boundary);
    assertOriginalPointerLease(token,prepared,expected);
    seen.add(boundary);
   };
   const guards:OriginalResumeGuards={beforeOuterSpawn:guard('outer-spawn'),beforePromptRelease:guard('prompt-release'),beforeInnerSpawn:guard('inner-spawn'),beforeInnerInput:guard('inner-input')};
   const observed=await prepared.resume!(context,input,guards);
   assertOriginalPointerLease(token,prepared,expected);
   if(!seen.has('outer-spawn')||!seen.has('prompt-release')||prepared.resumeLaunch.binding.platform==='win32'&&(!seen.has('inner-spawn')||!seen.has('inner-input'))||observed.status!=='observed'||observed.sessionId!==target.sessionId||observed.runtime!==target.runtime||observed.cwd!==target.cwd||observed.permissionMode!==target.permissionMode||observed.providerEpoch!==epoch||observed.background!==true||observed.originalChat!==true)throw Error('original result unknown');
   registerOriginalResumeObservation(deps,context,prepared,observed,epoch);state.candidate=observed;commitOriginalObservation(deps,state);
   return {status:'resumed-original-awaiting-completion' as const,reason:'native-completion-pending'};
  });
  if(result.status==='original-processing')return {status:'original-processing',reason:'original-processing'};
  if(result.status==='unavailable')return {status:'unavailable',reason:'native-exclusion-unavailable'};
  if(result.status==='unknown')throw Error('original exclusion unknown');return result as TargetResumeResult;
 }catch{state.attempted=true;if(state.successor)try{finishRouteEffect(deps.paths,state.successor,{kind:'uncertain'});withRoute(deps.paths,state.successor.handle,(r,save)=>save({...r,originalResume:{...r.originalResume!,phase:'unknown'}}));}catch{/* retained */}return {status:'unknown-fenced',reason:'original-execution-unknown'};}
}

function commitOriginalObservation(deps:RunnerDeps,state:PendingOriginalResume):void {
 const context=state.successor!,observed=state.candidate!;
 registerOriginalResumeObservation(deps,context,state.prepared,observed,state.epoch!);
 finishRouteEffect(deps.paths,context,{kind:'exec',pid:observed.pid,pidStart:observed.pidStart,threadId:observed.sessionId});
 withRoute(deps.paths,context.handle,(r,save)=>{if(r.originalResume?.phase!=='observed')save({...r,originalResume:{...r.originalResume!,phase:'observed'}});});state.result=observed;
}
