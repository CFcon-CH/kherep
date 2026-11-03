import {syntheticLaunchFacts} from './target-delivery-test-support.mts';
// Public generated stores and fake children/RPC only. No native discovery or process launch.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {targetFixture,TARGET_OWNER,TARGET_T,TARGET_LIMITS,targetId} from './target-delivery-fixture.mts';
import {claimRouteContext} from './target-delivery-route.mts';
import {buildMessageLaunch} from './target-delivery-launch.mts';
import {spawnCodex,codexFiles} from './codex-process.mts';

test('actual Codex stdin releases no bytes when process identity awaits across SEND deadline',async t=>{
  const f=targetFixture(t),bin=path.join(f.root,'generated-command');fs.writeFileSync(bin,'public fixture');
  let clock=TARGET_T;
  const launch=buildMessageLaunch({codex:{home:f.root,findCodex:()=>bin}},{runtime:'codex',args:['exec'],cwd:process.cwd()});
  const setup=syntheticLaunchFacts(f.paths,TARGET_OWNER,launch,{taskId:null,sessionId:TARGET_OWNER},()=>clock,{route:'task-wake',grant:'listed',permissionMode:'default'});
  const context=setup.bind({...claimRouteContext(f.paths,f.rows,{version:1,kind:'exec-resume',producer:launch.producer,budgetOwner:TARGET_OWNER,
    execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},setup.facts,clock,TARGET_LIMITS)!,launch});
  const input=new PassThrough();let bytes='';input.on('data',chunk=>bytes+=chunk);
  const start=(()=>{const child=Object.assign(new EventEmitter(),{pid:42001,stdin:input,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}) as never;
  await assert.rejects(spawnCodex({spawn:start,processStart:async()=>{clock=TARGET_T+86400000;return 'generated-start';}},bin,launch.rawArgs,process.cwd(),
    codexFiles(f.paths,targetId(901)),{CODEX_HOME:f.root},'public prompt',true,context,f.paths,{taskId:null,sessionId:TARGET_OWNER}),/before stdin/);
  assert.equal(bytes,'');
  const state=JSON.parse(fs.readFileSync(f.reservation,'utf8'));assert.equal(state.phase,'uncertain');assert.equal(state.outcome.pid,42001);assert.ok(state.budget);
});

import {runQueue,queueArgs} from './codex-queue-run.mts';
import {runClaude} from './session-runner.mts';
import {beginRouteEffect,checkExecution} from './target-delivery-route.mts';
import {finishRouteEffect} from './target-delivery-outcome.mts';
import {faultAuthority,revokeAuthority,stopAuthority} from './session-authority.mts';
import {writeJsonAtomic,getMessage} from './inbox.mts';
import {testServiceOwner,T0} from './task-fixture.mts';
import {publishSynthetic,fixtureEvidence} from './session-authority-fixture.mts';
import {runFork,RECORD} from './codex-fork-run-fixture.mts';
import {forkAttemptsPath} from './codex-fork-attempts.mts';
import {FORK_OWNER} from './codex-fork-fixture.mts';
import {runWindowless} from './codex-windowless.mts';
import {windowControl} from './target-delivery-window.mts';

function boundaryFixture(t:test.TestContext,kind:'queue'|'exec-resume',runtime:'codex'|'claude-code'='codex',platform:NodeJS.Platform='linux') {
  const f=targetFixture(t,2),bin=path.join(f.root,'generated-command');fs.writeFileSync(bin,'public fixture');let clock=TARGET_T;
  const args=kind==='queue'?queueArgs(TARGET_OWNER,2):['exec'];
  const launch=buildMessageLaunch({codex:{home:f.root,findCodex:()=>bin,platform},findClaude:()=>bin,platform},{runtime,args,cwd:platform==='win32'?process.cwd():fs.realpathSync.native(f.root),detached:runtime==='codex'});
  const rows=f.rows.map(r=>({...r,senderOrigin:{...r.senderOrigin!,sentAt:new Date(TARGET_T-86400000+1000).toISOString()}}));
  for(const row of rows)writeJsonAtomic(path.join(f.paths.inbox,`${row.messageId}.json`),row);
  const selection={route:kind==='queue'?'native-queue' as const:'task-wake' as const,grant:'listed' as const,permissionMode:'default'};
  const setup=syntheticLaunchFacts(f.paths,TARGET_OWNER,launch,{taskId:null,sessionId:TARGET_OWNER},()=>clock,selection);
  const context=setup.bind({...claimRouteContext(f.paths,rows,{version:1,kind,producer:launch.producer,budgetOwner:TARGET_OWNER,execution:{runtime,sessionId:TARGET_OWNER,taskId:null}},setup.facts,clock,TARGET_LIMITS)!,launch});
  const publish=(generation=7)=>publishSynthetic(f.paths,[{...fixtureEvidence({runtime,sessionId:TARGET_OWNER},kind==='queue'?'running':'idle-loaded',clock),lifecycle:{status:'value',value:{state:'restored',generation},source:'native-lifecycle',observedAt:clock,complete:true,reasonCode:'observed'}}],clock,[{runtime,sessionId:TARGET_OWNER,state:kind==='queue'?'running':'idle-loaded'}],setup.deps.livenessAuthority);
  const mutate=(name:string)=>{
    if(name==='equality'||name==='expired')clock=TARGET_T+(name==='equality'?1000:1001);
    if(name==='revoked')revokeAuthority(setup.deps.livenessAuthority);
    if(name==='faulted')faultAuthority(setup.deps.livenessAuthority);
    if(name==='stopped')stopAuthority(setup.deps.livenessAuthority);
    if(name==='lifecycle')publish(8);
    if(name==='policy'){const p=JSON.parse(fs.readFileSync(f.paths.policy,'utf8'));p.wake.sessions=[];fs.writeFileSync(f.paths.policy,JSON.stringify(p));}
    if(name==='killswitch')fs.writeFileSync(path.join(f.paths.dir,'wake.disabled'),'');
    if(name==='producer')fs.appendFileSync(bin,' drift');
    if(name==='offer'||name==='member'){const r=getMessage(f.paths.inbox,rows[0].messageId)!;writeJsonAtomic(path.join(f.paths.inbox,`${r.messageId}.json`),{...r,...(name==='offer'?{offers:42}:{text:'drift'})});}
  };
  return {...f,rows,bin,args,launch,setup,context,mutate,publish,setClock:(v:number)=>{clock=v;}};
}
const drifts=['equality','expired','revoked','faulted','stopped','lifecycle','policy','killswitch','producer','offer','member'];
for(const effect of ['queue','outer','stdin','claude'] as const)for(const drift of drifts)test(`actual ${effect} denies ${drift} at its effect boundary`,async t=>{
  const f=boundaryFixture(t,effect==='queue'?'queue':'exec-resume',effect==='claude'?'claude-code':'codex');let spawns=0,bytes='';const input=new PassThrough();input.on('data',b=>bytes+=b);
  const start=(()=>{spawns++;const child=Object.assign(new EventEmitter(),{pid:42100,stdin:input,stdout:new PassThrough(),stderr:new PassThrough(),unref(){}});queueMicrotask(()=>{child.emit('spawn');if(effect==='queue'){child.emit('exit',0,null);child.emit('close',0,null);}});return child;}) as never;
  if(effect!=='stdin'){await Promise.resolve();f.mutate(drift);}
  if(effect==='queue')await assert.rejects(runQueue({...f.setup.deps,serviceOwner:testServiceOwner,codex:{findCodex:()=>f.bin,home:f.root,spawn:start}},f.args,undefined,undefined,f.context));
  else if(effect==='claude')await assert.rejects(runClaude({...f.setup.deps,exec:async()=>{spawns++;return '';},findClaude:()=>f.bin},f.args,f.launch.binding.cwd,f.context,{taskId:null,sessionId:TARGET_OWNER}));
  else await assert.rejects(spawnCodex({spawn:start,processStart:async()=>{if(effect==='stdin')f.mutate(drift);return 'generated-start';}},f.bin,f.args,f.launch.binding.cwd,codexFiles(f.paths,targetId(901)),{CODEX_HOME:f.root},'public prompt',true,f.context,f.paths,{taskId:null,sessionId:TARGET_OWNER}));
  assert.equal(bytes,'');assert.equal(spawns,effect==='stdin'?1:0);
  const s=JSON.parse(fs.readFileSync(f.reservation,'utf8'));assert.ok(s.budget);if(effect==='stdin'){assert.equal(s.phase,'uncertain');assert.equal(s.outcome.pid,42100);}
});
test('actual Queue submission at deadline-1 may settle after expiry without another debit',async t=>{
  const f=boundaryFixture(t,'queue');f.setClock(TARGET_T+999);let spawns=0;
  const start=(()=>{spawns++;const child=Object.assign(new EventEmitter(),{pid:42101,stdout:new PassThrough(),stderr:new PassThrough()});queueMicrotask(()=>{f.setClock(TARGET_T+2000);stopAuthority(f.setup.deps.livenessAuthority);child.stdout.write(`Queued message ${targetId(991)} for thread ${TARGET_OWNER}.\n`);child.emit('exit',0,null);child.emit('close',0,null);});return child;}) as never;
  const result=await runQueue({...f.setup.deps,serviceOwner:testServiceOwner,codex:{findCodex:()=>f.bin,home:f.root,spawn:start}},f.args,undefined,undefined,f.context);
  assert.equal(spawns,1);finishRouteEffect(f.paths,f.context,{kind:'queue',queueId:result.queueId!});assert.equal(checkExecution(f.paths,f.context,['queue'])!.phase,'settled');
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
});
for(const at of ['helper','thread','turn'] as const)for(const drift of ['equality','revoked','faulted','stopped','policy','killswitch','lifecycle','member','producer','attempt'] as const)test(`actual fork ${at} denies ${drift} after preparation/RPC await`,async t=>{
  let change=()=>{};let observed:{app:{runs:unknown[]};paths:{dir:string}}|undefined;
  const scenario={onRequest:(method:string,params:Record<string,unknown>)=>{if(at==='thread'&&method==='thread/goal/get'&&params.threadId===FORK_OWNER||at==='turn'&&method==='thread/goal/get'&&params.threadId!==FORK_OWNER)change();}};
  const pending=runFork(t,scenario,{}, {},facts=>{
    observed=facts;
    change=()=>{
      if(drift==='equality')facts.setClock(T0+86400000);
      if(drift==='revoked')revokeAuthority(facts.authority);if(drift==='faulted')faultAuthority(facts.authority);if(drift==='stopped')stopAuthority(facts.authority);
      if(drift==='policy'){const p=JSON.parse(fs.readFileSync(facts.paths.policy,'utf8'));p.wake.codexFork.sessions=[];fs.writeFileSync(facts.paths.policy,JSON.stringify(p));}
      if(drift==='killswitch')fs.writeFileSync(path.join(facts.paths.dir,'wake.disabled'),'');
      if(drift==='lifecycle')publishSynthetic(facts.paths,[{...fixtureEvidence({runtime:'codex',sessionId:FORK_OWNER},'idle-loaded',T0),lifecycle:{status:'value',value:{state:'restored',generation:8},source:'native-lifecycle',observedAt:T0,complete:true,reasonCode:'observed'}}],T0,[{runtime:'codex',sessionId:FORK_OWNER,state:'idle-loaded'}],facts.authority);
      if(drift==='member'){const file=path.join(facts.paths.inbox,`${RECORD.messageId}.json`),row=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...row,text:'drift'}));}
      if(drift==='producer'&&facts.context.kind==='message')fs.appendFileSync(facts.context.launch!.binding.executable,' drift');
      if(drift==='attempt'){const file=path.join(forkAttemptsPath(facts.paths,FORK_OWNER),`${RECORD.messageId}.json`),record=JSON.parse(fs.readFileSync(file,'utf8'));record.attemptId=targetId(997);fs.writeFileSync(file,JSON.stringify(record));}
    };if(at==='helper')change();
  });
  let r:Awaited<typeof pending>;try{r=await pending;}catch(error){if(at!=='helper')throw error;assert.equal(observed?.app.runs.length,0);assert.ok(fs.existsSync(path.join(observed!.paths.dir,'codex-native-pending',`${FORK_OWNER}.json`)));return;}
  assert.ok(r.outcome.state==='failed'||r.outcome.state==='uncertain');assert.equal(r.app.runs.length,at==='helper'?0:1);
  const methods=r.app.runs.flatMap(run=>run.requests.map(q=>q.method));assert.equal(methods.includes(at==='turn'?'turn/start':'thread/fork'),false);
  assert.ok(fs.existsSync(path.join(r.paths.dir,'codex-native-pending',`${FORK_OWNER}.json`)));
});
test('Windows serialized handle has no Authority, while an explicit same-process adapter is checked after every input await',async t=>{
  for(const adapter of [false,true])await t.test(String(adapter),async sub=>{
    const f=boundaryFixture(sub,'exec-resume','codex','win32');beginRouteEffect(f.paths,f.context,['exec-resume']);
    const wrapper=new URL('./codex-windowless.mts',import.meta.url).pathname,input=new PassThrough();let spawns=0,bytes='',killed=0;
    const childInput=new PassThrough();childInput.on('data',b=>bytes+=b);
    const start=(()=>{spawns++;const child=Object.assign(new EventEmitter(),{stdin:childInput,stdout:new PassThrough(),stderr:new PassThrough(),kill(){killed++;child.emit('close',1);}});queueMicrotask(()=>{f.mutate('stopped');input.end('not released');});return child;}) as never;
    input.write(windowControl(f.context,f.paths,f.launch.inner.file,f.launch.inner.args,wrapper));if(!adapter)input.end();
    await assert.rejects(runWindowless(f.launch.inner.file,f.launch.inner.args,input,new PassThrough(),new PassThrough(),start,wrapper,1000,{CODEX_HOME:f.root},adapter?{contextFor:()=>f.context}:undefined),adapter?/input context refused/:/authority unavailable/);
    assert.equal(bytes,'');assert.equal(spawns,adapter?1:0);assert.equal(killed,adapter?1:0);
  });
});

import {syntheticHookFacts,syntheticHookProducer} from './target-delivery-test-support.mts';
import {runHook,deliverForHook} from './deliver-hook.mts';
import {runWake,emitWakeResult,REARM_TEXT} from './wake-hook.mts';
import {closedNode,deliver,SESSION} from './closed-fixture.mts';
import {deliverToClosed} from './closed-delivery.mts';
import {nativeQueueNode,NATIVE_OWNER} from './codex-queue-producer-fixture.mts';
import {scheduleNativeQueue,nativeQueueIdle} from './codex-queue-producer.mts';
import {pollCodexInbound} from './codex-wake.mts';
import {taskNode,TASK} from './task-fixture.mts';
import {writeTask} from './task-records.mts';
for(const runtime of ['claude','codex'] as const)test(`actual ${runtime} Stop writer rechecks current Authority after framing and journal settlement`,t=>{
  const f=targetFixture(t,1),facts=syntheticHookFacts(f.paths,TARGET_OWNER,runtime==='codex'?'codex':'claude-code',TARGET_T);let writes=0;
  runHook(JSON.stringify({session_id:TARGET_OWNER,hook_event_name:'Stop',permission_mode:'default'}),
    {paths:f.paths,...facts,now:()=>TARGET_T,onContinuation:()=>stopAuthority(facts.livenessAuthority)},()=>{writes++;},()=>{},runtime);
  assert.equal(writes,0);assert.ok(fs.existsSync(f.reservation));assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
});
test('hook producer and disk lifecycle alone never authorize an autonomous continuation',t=>{
  const f=targetFixture(t,1),producer=syntheticHookProducer(f.paths,TARGET_OWNER,'claude-code',TARGET_T);
  assert.equal(deliverForHook({session_id:TARGET_OWNER,hook_event_name:'Stop',permission_mode:'default'},{paths:f.paths,messageProducer:producer,now:()=>TARGET_T}),'');
  assert.equal(fs.existsSync(f.budget),false);
});
for(const drift of ['none','stopped','policy','deadline'])test(`actual async wake final writer after Promise resumption: ${drift}`,async t=>{
  const f=targetFixture(t,1);writeJsonAtomic(path.join(f.paths.inbox,`${f.rows[0].messageId}.json`),{...f.rows[0],state:'delivered'});
  fs.writeFileSync(f.paths.policy,JSON.stringify({version:1,allowedCommands:[],wake:{enabled:true,sessions:[TARGET_OWNER]}}));
  let clock=TARGET_T,arrived=false;const facts=syntheticHookFacts(f.paths,TARGET_OWNER,'claude-code',clock);
  const result=await runWake({session_id:TARGET_OWNER,hook_event_name:'Stop',permission_mode:'default',cwd:fs.realpathSync.native(f.root)},
    {paths:f.paths,...facts,pid:4242,now:()=>clock,parentAlive:()=>true,maxWaitMs:10000,runMode:async()=> 'interactive',launchMode:async()=> 'ok',
    sleep:async ms=>{clock+=ms;if(!arrived&&clock>=TARGET_T+4000){arrived=true;writeJsonAtomic(path.join(f.paths.inbox,`${targetId(701)}.json`),{...f.rows[0],messageId:targetId(701),receivedAt:new Date(clock).toISOString(),createdAt:new Date(clock).toISOString(),senderOrigin:{...f.rows[0].senderOrigin!,sentAt:new Date(clock-86400000+1000).toISOString()}});}}});
  assert.equal(result.code,2);assert.notDeepEqual(result,{code:2,text:REARM_TEXT});assert.ok(fs.existsSync(f.reservation));
  if(drift==='stopped')stopAuthority(facts.livenessAuthority);if(drift==='policy')fs.writeFileSync(path.join(f.paths.dir,'wake.disabled'),'');if(drift==='deadline')clock+=1000;
  let writes=0;assert.equal(emitWakeResult(result,{paths:f.paths},()=>{writes++;}),drift==='none');assert.equal(writes,drift==='none'?1:0);
});
test('listener-only rearm stays independent of message admission and absent Authority',async t=>{
  const f=targetFixture(t,1);writeJsonAtomic(path.join(f.paths.inbox,`${f.rows[0].messageId}.json`),{...f.rows[0],state:'delivered'});let clock=TARGET_T;
  fs.writeFileSync(f.paths.policy,JSON.stringify({version:1,allowedCommands:[],wake:{enabled:true,sessions:[TARGET_OWNER]}}));
  const result=await runWake({session_id:TARGET_OWNER,hook_event_name:'Stop',permission_mode:'default',cwd:fs.realpathSync.native(f.root)},
    {paths:f.paths,pid:4242,now:()=>clock,parentAlive:()=>true,maxWaitMs:10000,runMode:async()=> 'interactive',launchMode:async()=> 'ok',sleep:async ms=>{clock+=ms;}});
  assert.deepEqual(result,{code:2,text:REARM_TEXT});let writes=0;assert.equal(emitWakeResult(result,{paths:f.paths},()=>{writes++;}),true);assert.equal(writes,1);
});
test('closed legacy new-task readiness await cannot revive stopped original Authority',async t=>{
  const f=closedNode(t);deliver(f);let checks=0;
  await deliverToClosed({...f.deps(),readiness:{check:async()=>{checks++;stopAuthority(f.livenessAuthority);return {ready:true,at:T0};},peek:()=>({ready:true,at:T0}),revalidate(){},invalidate(){},ready:()=>[],stop:async()=>{}}});
  assert.equal(checks,1);assert.equal(f.calls.filter(c=>c.args[0]!=='agents').length,0);assert.ok(fs.existsSync(path.join(f.paths.dir,'codex-native-pending',`${SESSION}.json`)));
});
test('native queue scheduler reevaluates policy after launch preparation await',async t=>{
  const f=nativeQueueNode(t),id=f.add();let spawns=0,finds=0;
  const deps=f.deps();scheduleNativeQueue({...deps,codex:{...deps.codex,findCodex:()=>{finds++;queueMicrotask(()=>fs.writeFileSync(path.join(f.paths.dir,'wake.disabled'),''));return f.fake.file;},spawn:(()=>{spawns++;throw Error('must not spawn');}) as never}},NATIVE_OWNER,[id],undefined,()=>{});
  await nativeQueueIdle();assert.equal(finds,1);assert.equal(spawns,0);
});
test('actual task wake reevaluates stopped Authority after process-liveness await',async t=>{
  const n=taskNode(t,{runtimes:['codex']},{wake:{enabled:true,sessions:[TARGET_OWNER]}}),bin=path.join(n.root,'generated-command');fs.writeFileSync(bin,'public');
  writeTask(n.paths,{taskId:TASK,name:'task-fixture',runtime:'codex',sessionId:TARGET_OWNER,permissionMode:'default',state:'done',cwd:n.workspace,pid:4242,pidStart:'generated-start',startedAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()},T0);
  const target={runtime:'codex',sessionId:TARGET_OWNER};publishSynthetic(n.paths,[{...fixtureEvidence(target,'idle-loaded',T0),lifecycle:{status:'value',value:{state:'restored',generation:7},source:'native-lifecycle',observedAt:T0,complete:true,reasonCode:'observed'}}],T0,[{...target,state:'idle-loaded'}],n.livenessAuthority);
  fs.mkdirSync(n.paths.inbox,{recursive:true});
  writeJsonAtomic(path.join(n.paths.inbox,`${targetId(799)}.json`),{messageId:targetId(799),from:{nodeId:targetId(777),session:'peer'},toSession:TARGET_OWNER,text:'public',createdAt:new Date(T0).toISOString(),receivedAt:new Date(T0).toISOString(),state:'accepted',senderOrigin:{nodeId:targetId(777),sentAt:new Date(T0).toISOString()}});
  let spawns=0;await pollCodexInbound({...n.deps(),codex:{findCodex:()=>bin,home:n.root,processStart:async()=>{stopAuthority(n.livenessAuthority);return null;},spawn:(()=>{spawns++;throw Error('must not spawn');}) as never}});assert.equal(spawns,0);
});

import {deliverForCodex} from './deliver-codex.mts';
import {acknowledgeCodexOffer} from './codex-inbox-ack.mts';
test('actual original-owner processing ACK remains possible after sender expiry and stopped launch Authority',async t=>{
  const f=boundaryFixture(t,'queue');f.setClock(TARGET_T+999);
  const start=(()=>{const child=Object.assign(new EventEmitter(),{pid:42102,stdout:new PassThrough(),stderr:new PassThrough()});queueMicrotask(()=>{child.stdout.write(`Queued message ${targetId(992)} for thread ${TARGET_OWNER}.\n`);child.emit('exit',0,null);child.emit('close',0,null);});return child;}) as never;
  const result=await runQueue({...f.setup.deps,serviceOwner:testServiceOwner,codex:{findCodex:()=>f.bin,home:f.root,spawn:start}},f.args,undefined,undefined,f.context);
  finishRouteEffect(f.paths,f.context,{kind:'queue',queueId:result.queueId!});f.setClock(TARGET_T+1001);stopAuthority(f.setup.deps.livenessAuthority);
  const output=deliverForCodex({session_id:TARGET_OWNER,hook_event_name:'UserPromptSubmit',cwd:f.root,permission_mode:'default'},f.setup.deps);
  const token=output.match(/msg inbox --ack ([0-9a-f-]{36}) --from /)?.[1];assert.ok(token);
  acknowledgeCodexOffer(f.paths,TARGET_OWNER,token,[TARGET_OWNER]);assert.ok(f.rows.every(r=>getMessage(f.paths.inbox,r.messageId)?.state==='delivered'));
});
test('actual prompt release accepts a fresh publication of the same lifecycle after process identity await',async t=>{
  const f=boundaryFixture(t,'exec-resume');let bytes='';const input=new PassThrough();input.on('data',b=>bytes+=b);
  const start=(()=>{const child=Object.assign(new EventEmitter(),{pid:42103,stdin:input,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}) as never;
  await spawnCodex({spawn:start,processStart:async()=>{f.publish();return 'generated-start';}},f.bin,f.args,f.launch.binding.cwd,codexFiles(f.paths,targetId(901)),{CODEX_HOME:f.root},'public prompt',true,f.context,f.paths,{taskId:null,sessionId:TARGET_OWNER});assert.equal(bytes,'public prompt');
});

for(const runtime of ['codex','claude-code'] as const)for(const drift of ['none','original','executor'])test(`actual closed ${runtime} reuse requires both original and executor lifecycle: ${drift}`,async t=>{
  const f=targetFixture(t,1),bin=path.join(f.root,'generated-command'),executor=targetId(902),taskId=targetId(903),cwd=fs.realpathSync.native(f.root);fs.writeFileSync(bin,'public');
  const launch=buildMessageLaunch({codex:{findCodex:()=>bin,home:f.root},findClaude:()=>bin},{runtime,args:['exec'],cwd});
  const setup=syntheticLaunchFacts(f.paths,TARGET_OWNER,launch,{taskId,sessionId:executor},()=>TARGET_T,{route:'closed-resume',grant:'resumeClosed',permissionMode:'default',taskId});
  const publish=(original=7,execution=7)=>publishSynthetic(f.paths,[[TARGET_OWNER,original],[executor,execution]].map(([sessionId,generation])=>({...fixtureEvidence({runtime,sessionId:sessionId as string},'closed',TARGET_T),lifecycle:{status:'value' as const,value:{state:'restored' as const,generation:generation as number},source:'native-lifecycle' as const,observedAt:TARGET_T,complete:true,reasonCode:'observed' as const}})),TARGET_T,[],setup.deps.livenessAuthority);
  publish();const raw=claimRouteContext(f.paths,f.rows,{version:1,kind:'exec-resume',producer:launch.producer,budgetOwner:executor,execution:{runtime,sessionId:executor,taskId}},setup.facts,TARGET_T,TARGET_LIMITS)!;
  const context=setup.bind({...raw,launch});await Promise.resolve();if(drift==='original')publish(8,7);if(drift==='executor')publish(7,8);
  let calls=0;const input=new PassThrough();const start=(()=>{calls++;const child=Object.assign(new EventEmitter(),{pid:42104,stdin:input,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}) as never;
  const run=runtime==='codex'?spawnCodex({spawn:start,processStart:()=> 'generated-start'},bin,launch.rawArgs,cwd,codexFiles(f.paths,taskId),{CODEX_HOME:f.root},'public',true,context,f.paths,{taskId,sessionId:executor})
    :runClaude({...setup.deps,findClaude:()=>bin,exec:async()=>{calls++;return 'public';}},launch.rawArgs,cwd,context,{taskId,sessionId:executor});
  if(drift==='none')await run;else await assert.rejects(run);assert.equal(calls,drift==='none'?1:0);assert.ok(fs.existsSync(path.join(f.paths.dir,'codex-native-pending',`${executor}.json`)));
});
