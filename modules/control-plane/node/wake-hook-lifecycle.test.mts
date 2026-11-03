// Generated stores and same-process Authority only; no native/vendor probes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {setup,SELF,T0,arriveReply,arriveTaskMessage,sentOriginal,dispatchedRequest} from './wake-fixture.mts';
import {runWake,emitWakeResult,retireCompletedWakeResult,WAKE_POLL_MS,wakeText} from './wake-hook.mts';
import {runHook} from './deliver-hook.mts';
import {syntheticHookFacts,syntheticHookCompletion} from './target-delivery-test-support.mts';
import {getMessage,writeJsonAtomic} from './inbox.mts';
import {budgetFile} from './budget-store.mts';
import {routeMembersCurrent} from './target-delivery-route.mts';
import {decideMessageRoute} from './target-delivery-producer.mts';
import {readPolicy} from './policy.mts';
import {captureUnlistedGrant} from './wake-reply.mts';
import {revokeAuthority} from './session-authority.mts';
import {DISPLAY_TTL_MS} from './session-liveness.mts';
import type {RouteReservation} from './target-delivery-operation.mts';

async function fixture(t:test.TestContext) {
  const {paths}=setup(t,{wake:{enabled:true,replies:true}});
  sentOriginal(paths);dispatchedRequest(paths);
  let clock=T0;
  const facts=syntheticHookFacts(paths,SELF,'claude-code',clock);
  const input=(event:string)=>({session_id:SELF,hook_event_name:event,permission_mode:'default',cwd:paths.dir});
  const deps={paths,...facts,pid:4242,now:()=>clock,maxWaitMs:20000,parentAlive:()=>true,
    sleep:async(ms:number)=>{clock+=ms;if(clock===T0+2*WAKE_POLL_MS){arriveReply(paths,1,clock);arriveTaskMessage(paths,2,clock);}},
    launchMode:async()=> 'ok' as const,runMode:async()=> 'interactive' as const};
  const result=await runWake(input('Stop'),deps);
  assert.deepEqual(result,{code:2,text:wakeText(2)},'first wake positive control');
  let totalWrites=0;
  const emit=()=>{let calls=0;const emitted=emitWakeResult(result,deps,()=>{calls++;totalWrites++;});return {emitted,calls};};
  assert.deepEqual(emit(),{emitted:true,calls:1},'actual first writer positive control');
  const ownerFile=path.join(paths.dir,'codex-native-pending',SELF+'.json');
  const current=():RouteReservation=>JSON.parse(fs.readFileSync(ownerFile,'utf8'));
  const rows=()=>current().group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!);
  const fence=()=>({owner:fs.readFileSync(ownerFile),budget:fs.readFileSync(budgetFile(paths,SELF))});
  const hook=(event:string)=>{
    const writes:string[]=[],warnings:string[]=[];
    runHook(JSON.stringify(input(event)),{paths,now:()=>clock,replyCommand:'synthetic'},text=>writes.push(text),line=>warnings.push(line));
    return {writes,warnings};
  };
  const claim=(records=rows(),producer=facts.messageProducer)=>{
    const policy=readPolicy(paths.policy,true)!;
    return decideMessageRoute({...deps,policy,messageRoute:{route:'claude-wake',grant:'members',
      memberGrants:records.map(row=>captureUnlistedGrant(paths,policy,[SELF,'review'],undefined,row,clock)!),permissionMode:'default'}},
      records,SELF,'hook-continue',{runtime:'claude-code',sessionId:SELF,taskId:null},producer);
  };
  return {paths,facts,result,current,rows,emit,hook,fence,claim,totalWrites:()=>totalWrites,advance:(ms:number)=>{clock+=ms;},now:()=>clock};
}

function coherent(f:Awaited<ReturnType<typeof fixture>>,initial:RouteReservation,budget:Buffer) {
  const current=f.current();
  assert.deepEqual(current.group,initial.group,'immutable complete mixed group');
  assert.deepEqual(current.handle,initial.handle,'exact original handle');
  assert.deepEqual(current.budget,initial.budget,'same debit identity');
  assert.deepEqual(fs.readFileSync(budgetFile(f.paths,SELF)),budget,'no new turn/debit');
  assert.ok(current.transitions.every(t=>t.applied===true));
  assert.equal(routeMembersCurrent(f.paths,current),true);
  assert.ok(f.rows().every(row=>JSON.stringify(row.targetAttempt)===JSON.stringify(current.handle)));
  assert.equal(current.phase,'settled','passive delivery does not retire owner');
}

test('wake attaches exact references before output; real prompt and Stop journal complete mixed membership',async t=>{
  const f=await fixture(t),initial=f.current(),budget=f.fence().budget;
  assert.equal(initial.group.binding.members.length,2);
  assert.deepEqual(f.rows().map(row=>row.targetAttempt),[initial.handle,initial.handle],'passive reference attachment');
  assert.equal(initial.transitions.length,2);
  coherent(f,initial,budget);
  const prompt=f.hook('UserPromptSubmit');assert.deepEqual(prompt.warnings,[]);assert.equal(prompt.writes.length,1);
  for(const row of f.rows()){assert.ok(prompt.writes[0].includes(row.messageId));assert.equal(row.state,'offered');assert.equal(row.offeredBy,'wake');}
  assert.equal(f.current().transitions.length,4);coherent(f,initial,budget);
  assert.deepEqual(f.hook('Stop'),{writes:[],warnings:[]});
  assert.ok(f.rows().every(row=>row.state==='delivered'));assert.equal(f.current().transitions.length,6);coherent(f,initial,budget);
  const done=f.fence();assert.deepEqual(f.hook('Stop'),{writes:[],warnings:[]});assert.deepEqual(f.fence(),done,'duplicate Stop preserves fence');
  f.advance(60000);const next=arriveReply(f.paths,3,f.now());
  assert.deepEqual(f.claim([getMessage(f.paths.inbox,next)!]),{status:'owned',reason:'owned'},'delivered rows alone do not exclude native consumer');
  assert.deepEqual(f.fence(),done);
});

test('StopFailure journals retry without retirement; next prompt and Stop preserve group and debit',async t=>{
  const f=await fixture(t),initial=f.current(),budget=f.fence().budget;
  assert.equal(f.hook('UserPromptSubmit').writes.length,1);
  assert.deepEqual(f.hook('StopFailure'),{writes:[],warnings:[]});
  assert.ok(f.rows().every(row=>row.state==='offered'&&row.retry===true));coherent(f,initial,budget);
  assert.equal(f.hook('UserPromptSubmit').writes.length,1);
  assert.ok(f.rows().every(row=>row.offers===2&&row.retry===undefined));
  assert.deepEqual(f.hook('Stop'),{writes:[],warnings:[]});assert.ok(f.rows().every(row=>row.state==='delivered'));coherent(f,initial,budget);
});

for(const drift of ['revoked-authority','stale-authority','producer','wrong-owner','partial-reference','member'] as const)
test(`final wake writer refuses ${drift} and retains owner/debit`,async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.rows().map(row=>row.targetAttempt),[f.current().handle,f.current().handle]);
  if(drift==='revoked-authority')revokeAuthority(f.facts.livenessAuthority);
  if(drift==='stale-authority')f.advance(DISPLAY_TTL_MS+1);
  if(drift==='producer')fs.appendFileSync(f.facts.messageProducer.files[0].path,'// changed producer\n');
  if(drift==='wrong-owner'||drift==='partial-reference'||drift==='member'){
    const row=f.rows()[0];
    const changed=drift==='wrong-owner'?{...row,targetAttempt:{...row.targetAttempt!,owner:'00000000-0000-4000-8000-000000000999'}}
      :drift==='member'?{...row,text:'changed generated member'}:{...row,targetAttempt:undefined};
    writeJsonAtomic(path.join(f.paths.inbox,row.messageId+'.json'),changed);
  }
  const frozen=f.fence();assert.deepEqual(f.emit(),{emitted:false,calls:0});assert.deepEqual(f.fence(),frozen);
});

test('partial selection and a wrong producer cannot reclaim an already executed group',async t=>{
  const f=await fixture(t),frozen=f.fence();
  assert.deepEqual(f.rows().map(row=>row.targetAttempt),[f.current().handle,f.current().handle]);
  assert.equal(f.claim(f.rows().slice(0,1)).status,'unknown-fenced');
  assert.equal(f.claim(f.rows(),{...f.facts.messageProducer,argsFingerprint:'f'.repeat(64)}).status,'unknown-fenced');
  assert.deepEqual(f.fence(),frozen);
});

test('only original emitted WakeResult retires after explicit exact provider completion; JSON and copies refuse',async t=>{
 const f=await fixture(t),completion=syntheticHookCompletion(f.paths),budget=f.fence().budget;
 completion.register(f.current());
 assert.equal(retireCompletedWakeResult(f.result,{paths:f.paths},undefined).status,'unavailable');
 assert.equal(retireCompletedWakeResult(f.result,{paths:f.paths},completion.provider).status,'unavailable');
 assert.equal(retireCompletedWakeResult({...f.result},{paths:f.paths},completion.provider).status,'refused');
 assert.equal(retireCompletedWakeResult(JSON.parse(JSON.stringify(f.result)),{paths:f.paths},completion.provider).status,'refused');
 assert.equal(f.hook('UserPromptSubmit').writes.length,1);f.hook('Stop');assert.equal(completion.complete(),true);
 assert.equal(retireCompletedWakeResult(f.result,{paths:f.paths},completion.provider).status,'retired');
 assert.deepEqual(fs.readFileSync(budgetFile(f.paths,SELF)),budget);assert.deepEqual(f.emit(),{emitted:false,calls:0});
 assert.equal(retireCompletedWakeResult(f.result,{paths:f.paths},completion.restartQualified()).status,'already-retired');
});

test('actual writer output remains emitted across committed cleanup failure and recovery, without another output or debit',async t=>{
 const f=await fixture(t),completion=syntheticHookCompletion(f.paths),budget=f.fence().budget;
 completion.register(f.current());assert.equal(f.hook('UserPromptSubmit').writes.length,1);f.hook('Stop');assert.equal(completion.complete(),true);
 const owner=path.join(f.paths.dir,'codex-native-pending',SELF+'.json'),unlink=fs.unlinkSync;
 fs.unlinkSync=((file:any)=>{if(String(file)===owner)throw Error('synthetic cleanup crash');return unlink(file);}) as typeof unlink;
 try{assert.equal(retireCompletedWakeResult(f.result,{paths:f.paths},completion.provider).status,'unknown');}finally{fs.unlinkSync=unlink;}
 assert.deepEqual(f.result,{code:2,text:wakeText(2)});assert.equal(f.totalWrites(),1);
 assert.equal(retireCompletedWakeResult(f.result,{paths:f.paths},completion.restartQualified()).status,'retired');
 assert.equal(f.totalWrites(),1);assert.deepEqual(fs.readFileSync(budgetFile(f.paths,SELF)),budget);
});
