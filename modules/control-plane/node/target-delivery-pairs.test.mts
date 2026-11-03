import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { forkNode,FORK_OWNER } from './codex-fork-fixture.mts';
import { scheduleForkReply,forkReplyIdle } from './codex-fork-reply.mts';
import { scheduleNativeQueue,nativeQueueIdle } from './codex-queue-producer.mts';
import { deliverForCodex } from './deliver-codex.mts';
import { deliverForHook } from './deliver-hook.mts';
import { pollCodexInbound } from './codex-wake.mts';
import { runWake } from './wake-hook.mts';
import { publishSynthetic,fixtureEvidence } from './session-authority-fixture.mts';
import { syntheticHookProducer } from './target-delivery-test-support.mts';
import { getMessage,storeMessage } from './inbox.mts';
import { writeTask } from './task-records.mts';
import { T0,TASK } from './task-fixture.mts';
import { targetId } from './target-delivery-fixture.mts';
import {targetFixture,TARGET_OWNER,TARGET_T,TARGET_LIMITS} from './target-delivery-fixture.mts';
import {claimRoute,routeMembersCurrent,withRoute} from './target-delivery-route.mts';
import {commandProducer} from './target-delivery-producer.mts';
import {recordLockFile} from './inbox-record-lock.mts';

const alternatives=['fork','task-wake','codex-stop','claude-stop/shared-owner','async-message-wake'] as const;
for(const alternative of alternatives)for(const queueFirst of [true,false])test(`actual competitor queue/${alternative}, ${queueFirst?'queue':'other'} first, different messages`,async t=>{
  const n=forkNode(t);const policy=JSON.parse(fs.readFileSync(n.paths.policy,'utf8'));
  policy.wake.nativeQueue=true;fs.writeFileSync(n.paths.policy,JSON.stringify(policy));
  let effects=0,clock=T0;
  const live=(state:'running'|'idle-loaded')=>publishSynthetic(n.paths,['codex','claude-code'].map(runtime=>({
    ...fixtureEvidence({runtime,sessionId:FORK_OWNER},state,clock),lifecycle:{status:'value' as const,value:{state:'restored' as const,generation:7},source:'native-lifecycle' as const,observedAt:clock,complete:true,reasonCode:'observed' as const}})),clock,
    [{runtime:'codex',sessionId:FORK_OWNER,state}],n.livenessAuthority);
  const spawn=(()=>{
    effects++;
    const child=Object.assign(new EventEmitter(),{pid:45000+effects,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),unref(){},exitCode:null,signalCode:null});
    queueMicrotask(()=>{child.emit('spawn');child.stdout.write(`Queued message ${targetId(990)} for thread ${FORK_OWNER}.\n`);child.emit('exit',0,null);child.emit('close',0,null);});return child;
  }) as never;
  const deps=()=>({...n.deps({spawn,processStart:()=> 'synthetic-start',processRelations:()=>[],reconcileQueue:async()=>{}}),now:()=>clock});
  const queue=async()=>{live('running');const id=n.add();scheduleNativeQueue(deps(),FORK_OWNER,[id],undefined,()=>{});await nativeQueueIdle();};
  const other=async()=>{
    live(alternative==='fork'||alternative==='task-wake'?'idle-loaded':'running');
    if(alternative==='fork'){
      const id=n.add();scheduleForkReply(n.deps(),FORK_OWNER,[id],()=>{});await forkReplyIdle();effects+=n.app.runs.length;return;
    }
    if(alternative==='task-wake'){
      writeTask(n.paths,{taskId:TASK,name:'task-3f2a1b0c',runtime:'codex',sessionId:FORK_OWNER,permissionMode:'default',state:'done',cwd:n.workspace,
        startedAt:new Date(clock-10000).toISOString(),updatedAt:new Date(clock).toISOString(),deadline:new Date(clock+60000).toISOString()},clock);
      n.add();await pollCodexInbound(deps());return;
    }
    const producer=syntheticHookProducer(n.paths,FORK_OWNER,alternative==='codex-stop'?'codex':'claude-code',clock);
    if(alternative==='async-message-wake'){
      let arrived=false;
      const result=await runWake({session_id:FORK_OWNER,hook_event_name:'Stop',permission_mode:'default',cwd:n.workspace},
        {paths:n.paths,pid:4242,now:()=>clock,parentAlive:()=>true,maxWaitMs:10000,runMode:async()=> 'interactive',launchMode:async()=> 'ok',messageProducer:producer,
          sleep:async ms=>{clock+=ms;if(!arrived&&clock>=T0+4000){arrived=true;const id=n.add();const row=getMessage(n.paths.inbox,id)!;
            // Arrival is after arming, with authenticated SEND at this fake clock.
            fs.writeFileSync(path.join(n.paths.inbox,`${id}.json`),JSON.stringify({...row,receivedAt:new Date(clock).toISOString(),senderOrigin:{...row.senderOrigin,sentAt:new Date(clock).toISOString()}}));}}});
      if(result.code===2)effects++;return;
    }
    n.add();const output=(alternative==='codex-stop'?deliverForCodex:deliverForHook)({session_id:FORK_OWNER,hook_event_name:'Stop',permission_mode:'default'},
      {paths:n.paths,now:()=>clock,messageProducer:producer});if(output)effects++;
  };
  if(queueFirst){await queue();await other();}else{await other();await queue();}
  assert.equal(effects,1);
  const budget=JSON.parse(fs.readFileSync(path.join(n.paths.dir,'listeners',`${FORK_OWNER}.turns.json`),'utf8'));
  assert.equal(budget.turns.length,1);assert.equal(budget.groupDebits.length,1);
});

import { closedNode,deliver,SESSION,PEER } from './closed-fixture.mts';
import { deliverToClosed } from './closed-delivery.mts';
import { recordCodexSession } from './codex-sessions.mts';
import { rememberMode } from './autonomy.mts';
const EXECUTOR=targetId(121);
for(const mode of ['closed-resume','reused-executor'] as const)for(const first of ['closed','competitor'] as const)test(`actual ${mode} competitor in ${first} order`,async t=>{
  const n=closedNode(t,{runtimes:['claude','codex']});const bin=path.join(n.root,'public-codex');fs.writeFileSync(bin,Buffer.from([0x7f,69,76,70,2,1,1,0]));
  const policy=JSON.parse(fs.readFileSync(n.paths.policy,'utf8'));policy.wake={enabled:true,sessions:[SESSION,EXECUTOR],nativeQueue:true};fs.writeFileSync(n.paths.policy,JSON.stringify(policy));
  rememberMode(n.paths,SESSION,'auto');recordCodexSession(n.paths,SESSION,n.workspace,T0,'default');
  const base=n.deps();let effects=0;
  const deps={...base,codex:{...base.codex,home:n.root,findCodex:()=>bin,processStart:()=> 'synthetic-start',processRelations:()=>[],reconcileQueue:async()=>{},spawn:(()=>{
    effects++;const child=Object.assign(new EventEmitter(),{pid:4242,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),unref(){},exitCode:null,signalCode:null});
    queueMicrotask(()=>{child.emit('spawn');child.stdout.write(`Queued message ${targetId(990)} for thread ${SESSION}.\n`);child.emit('exit',0,null);child.emit('close',0,null);});return child;
  }) as never},exec:async(...args:Parameters<NonNullable<typeof base.exec>>)=>{if(args[1][0]==='--resume')effects++;return base.exec!(...args);}};
  const evidence=(runtime:string,sessionId:string,state:'running'|'closed')=>({
    ...fixtureEvidence({runtime,sessionId},state,T0),lifecycle:{status:'value' as const,value:{state:'restored' as const,generation:7},source:'native-lifecycle' as const,observedAt:T0,complete:true,reasonCode:'observed' as const}});
  const publish=(route:'closed'|'queue'|'hook')=>publishSynthetic(n.paths,[
    evidence('claude-code',SESSION,'closed'),evidence('codex',SESSION,route==='queue'?'running':'closed'),
    evidence('claude-code',EXECUTOR,route==='closed'&&mode==='closed-resume'?'closed':'running')],T0,
    route==='queue'?[{runtime:'codex',sessionId:SESSION,state:'running'}]:route==='hook'?[{runtime:'claude-code',sessionId:EXECUTOR,state:'running'}]:[],n.livenessAuthority);
  writeTask(n.paths,{taskId:TASK,name:'task-3f2a1b0c',runtime:'claude',sessionId:EXECUTOR,permissionMode:'auto',state:mode==='closed-resume'?'done':'running',local:'intercom',requestedBy:`${PEER.nodeId}/${PEER.session}`,cwd:n.workspace,
    startedAt:new Date(T0-10000).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()},T0);
  n.rows.push({id:'abcdef01',sessionId:EXECUTOR,state:'working',kind:'background'});
  const owner=(sessionId:string)=>JSON.parse(fs.readFileSync(path.join(n.paths.dir,'codex-native-pending',`${sessionId}.json`),'utf8'));
  const debitCount=()=>[SESSION,EXECUTOR].flatMap(sessionId=>{const file=path.join(n.paths.dir,'listeners',`${sessionId}.turns.json`);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).groupDebits:[];}).length;
  const hook=()=>{
    const producer=syntheticHookProducer(n.paths,EXECUTOR,'claude-code',T0);publish('hook');
    const output=deliverForHook({session_id:EXECUTOR,hook_event_name:'Stop',permission_mode:'auto'},
      {paths:n.paths,now:()=>T0,messageProducer:producer,livenessAuthority:n.livenessAuthority});
    if(output)effects++;return output;
  };
  let closedId='',competitorId='';
  const closed=async()=>{
    publish('closed');closedId=deliver(n);const before=effects;await deliverToClosed(deps);
    const row=getMessage(n.paths.inbox,closedId)!;
    if(first==='competitor'){assert.equal(effects,before);assert.equal(row.targetAttempt,undefined);assert.equal(row.toSession,SESSION);return;}
    assert.equal(row.targetAttempt?.owner,SESSION);
    if(mode==='reused-executor'){
      assert.equal(row.toSession,EXECUTOR);assert.equal(row.closedTo,SESSION);assert.equal(effects,0);assert.equal(debitCount(),0);
      const reservation=owner(SESSION);assert.deepEqual(reservation.group.binding.members.map((m:{messageId:string})=>m.messageId),[closedId]);
      assert.deepEqual(owner(EXECUTOR).handle,row.targetAttempt);
      assert.ok(hook());assert.equal(getMessage(n.paths.inbox,closedId)?.state,'offered');assert.equal(owner(SESSION).consumer?.kind,'hook-continue');
      assert.equal(owner(SESSION).handle.groupId,row.targetAttempt?.groupId);
    }else assert.equal(effects,before+1);
  };
  const competitor=async()=>{
    const before=effects;
    if(mode==='closed-resume'){publish('queue');competitorId=deliver(n);scheduleNativeQueue(deps,SESSION,[competitorId],undefined,()=>{});await nativeQueueIdle();}
    else{
      competitorId=targetId(819);storeMessage(n.paths.inbox,{messageId:competitorId,from:PEER,toSession:EXECUTOR,text:'different direct message',createdAt:new Date(T0).toISOString(),senderOrigin:{nodeId:PEER.nodeId,sentAt:new Date(T0).toISOString()}},T0);
      const output=hook();assert.equal(!!output,first==='competitor');
    }
    assert.equal(effects,before+(first==='competitor'?1:0));
    if(first==='closed'){assert.equal(getMessage(n.paths.inbox,competitorId)?.targetAttempt,undefined);assert.notEqual(getMessage(n.paths.inbox,competitorId)?.state,'delivered');}
  };
  if(first==='closed'){await closed();await competitor();}else{await competitor();await closed();}
  assert.equal(effects,1);assert.equal(debitCount(),1);
  const winner=getMessage(n.paths.inbox,first==='closed'?closedId:competitorId)!;
  const retained=owner(first==='closed'?SESSION:mode==='closed-resume'?SESSION:EXECUTOR);
  assert.deepEqual(retained.group.binding.members.map((m:{messageId:string})=>m.messageId),[winner.messageId]);
  if(mode==='closed-resume'&&first==='competitor'){assert.equal(retained.outcome?.kind,'queue');assert.equal(retained.outcome?.queueId,targetId(990));}
  else{assert.ok(winner.targetAttempt);assert.equal(retained.handle.groupId,winner.targetAttempt.groupId);}
  assert.ok(fs.existsSync(path.join(n.paths.dir,'codex-native-pending',`${mode==='closed-resume'&&first==='competitor'?SESSION:EXECUTOR}.json`)));
});

test('two lower-boundary contenders both reach the common owner mutex, independently of the queue task veto',t=>{
  const f=targetFixture(t),bin=path.join(f.root,'public-command');fs.writeFileSync(bin,'public');
  const producer=commandProducer({codex:{findCodex:()=>bin,home:f.root}},'codex',['exec'])!;
  const file=recordLockFile(path.join(f.paths.dir,'codex-native-pending'),TARGET_OWNER),open=fs.openSync;let acquisitions=0;
  t.mock.method(fs,'openSync',(name:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{if(name===file&&flags==='wx')acquisitions++;return open(name,flags,mode);});
  const op=(kind:'queue'|'exec-resume')=>({version:1 as const,kind,producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex' as const,sessionId:TARGET_OWNER,taskId:null}});
  const facts={policyFingerprint:'a'.repeat(64),lifecycleGeneration:7};
  const first=claimRoute(f.paths,[f.rows[0]],op('queue'),facts,TARGET_T,TARGET_LIMITS);assert.equal(first.status,'granted');
  const before=acquisitions;assert.ok(before>0);
  const second=claimRoute(f.paths,[f.rows[1]],op('exec-resume'),facts,TARGET_T,TARGET_LIMITS);assert.equal(second.status,'owned');
  assert.ok(acquisitions>before,'second contender reached the actual same lock');
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).groupDebits.length,1);
});

test('task-owned execution alias stays ineligible for ordinary Queue before claim',async t=>{
  const n=forkNode(t),policy=JSON.parse(fs.readFileSync(n.paths.policy,'utf8'));policy.wake.nativeQueue=true;
  fs.writeFileSync(n.paths.policy,JSON.stringify(policy));
  const id=n.add();writeTask(n.paths,{taskId:TASK,name:'task-3f2a1b0c',runtime:'codex',local:'intercom',sessionId:FORK_OWNER,cwd:n.workspace,
    permissionMode:'default',state:'running',startedAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()},T0);
  scheduleNativeQueue(n.deps(),FORK_OWNER,[id],undefined,()=>{});await nativeQueueIdle();
  assert.equal(n.app.runs.length,0);
  assert.equal(fs.existsSync(path.join(n.paths.dir,'codex-native-pending',`${FORK_OWNER}.json`)),false);
  assert.equal(getMessage(n.paths.inbox,id)?.targetAttempt,undefined);
});
