import {syntheticHookFacts} from './target-delivery-test-support.mts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { targetFixture, TARGET_OWNER, TARGET_T } from './target-delivery-fixture.mts';
import { runQueue, queueArgs } from './codex-queue-run.mts';
import { deliverForCodex } from './deliver-codex.mts';
import { testServiceOwner } from './task-fixture.mts';

test('actual queue runner refuses missing message context before its process effect', async t => {
  const f = targetFixture(t); const bin = path.join(f.root,'public-bin'); fs.writeFileSync(bin,'synthetic'); let spawns = 0;
  const deps = { paths:f.paths, policy:{version:1 as const,allowedCommands:[]}, serviceOwner:testServiceOwner, codex:{home:f.root,findCodex:()=>bin,spawn:(()=>{
    spawns++; const child=Object.assign(new EventEmitter(),{pid:4242,stdout:new PassThrough(),stderr:new PassThrough()});
    queueMicrotask(()=>{child.emit('exit',0,null);child.emit('close',0,null);});return child;
  }) as never}};
  await assert.rejects(runQueue(deps, queueArgs(TARGET_OWNER,1)), /context/);
  assert.equal(spawns,0);
});

test('actual Codex Stop cannot authorize an unknown producer with a boolean callback', t => {
  const f=targetFixture(t);
  const output=deliverForCodex({hook_event_name:'Stop',session_id:TARGET_OWNER,permission_mode:'default'},
    {paths:f.paths,now:()=>TARGET_T,mayContinue:()=>true});
  assert.equal(output,'');
  assert.equal(fs.existsSync(f.budget),false);
});

import { taskNode, T0, TASK } from './task-fixture.mts';
import { targetId } from './target-delivery-fixture.mts';
import { pollCodexInbound } from './codex-wake.mts';
import { markDelivered, storeMessage } from './inbox.mts';
import { writeTask } from './task-records.mts';
import { publishSynthetic, fixtureEvidence } from './session-authority-fixture.mts';
import { claimRouteContext as claimRoute } from './target-delivery-route.mts';
import { commandProducer } from './target-delivery-producer.mts';
import { runWake } from './wake-hook.mts';
import { livenessFile } from './session-lifecycle.mts';
import { writeJsonAtomic } from './inbox.mts';
import { scheduleForkReply, forkReplyIdle } from './codex-fork-reply.mts';
import { forkNode, FORK_OWNER } from './codex-fork-fixture.mts';
import { nativeQueueNode } from './codex-queue-producer-fixture.mts';
import { scheduleNativeQueue, nativeQueueIdle } from './codex-queue-producer.mts';

function childForTask(onSpawn:()=>void) {
  const child=Object.assign(new EventEmitter(),{pid:4242,stdin:new PassThrough(),unref(){}});
  queueMicrotask(()=>{onSpawn();child.emit('spawn');});return child;
}
test('actual task wake spawns only after the common debit; an owner competitor prevents a second wake',async t=>{
  const n=taskNode(t,{runtimes:['codex']},{wake:{enabled:true,sessions:[TARGET_OWNER]}});
  const bin=path.join(n.root,'public-command');fs.writeFileSync(bin,'public');let spawns=0;
  const original={taskId:TASK,name:'task-3f2a1b0c',runtime:'codex' as const,sessionId:TARGET_OWNER,permissionMode:'default' as const,state:'done' as const,
    cwd:n.workspace,startedAt:new Date(T0-10000).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()};
  writeTask(n.paths,original,T0);
  storeMessage(n.paths.inbox,{messageId:targetId(701),from:{nodeId:targetId(777),session:'peer'},toSession:TARGET_OWNER,text:'public',createdAt:new Date(T0).toISOString(),senderOrigin:{nodeId:targetId(777),sentAt:new Date(T0).toISOString()}},T0);
  publishSynthetic(n.paths,[{...fixtureEvidence({runtime:'codex',sessionId:TARGET_OWNER},'idle-loaded',T0),lifecycle:{status:'value',value:{state:'restored',generation:7},source:'native-lifecycle',observedAt:T0,complete:true,reasonCode:'observed'}}],T0,[{runtime:'codex',sessionId:TARGET_OWNER,state:'idle-loaded'}],n.livenessAuthority);
  const deps={...n.deps(),codex:{findCodex:()=>bin,home:n.root,processStart:()=> 'synthetic-start',spawn:(()=>{
    spawns++;const s=JSON.parse(fs.readFileSync(path.join(n.paths.dir,'codex-native-pending',`${TARGET_OWNER}.json`),'utf8'));
    assert.equal(s.phase,'executing');assert.ok(s.budget);return childForTask(()=>{});
  }) as never}};
  await pollCodexInbound(deps);assert.equal(spawns,1);
  writeTask(n.paths,original,T0);
  storeMessage(n.paths.inbox,{messageId:targetId(702),from:{nodeId:targetId(777),session:'peer'},toSession:TARGET_OWNER,text:'different',createdAt:new Date(T0).toISOString(),senderOrigin:{nodeId:targetId(777),sentAt:new Date(T0).toISOString()}},T0);
  await pollCodexInbound(deps);assert.equal(spawns,1);
});
test('actual async message wake is grouped while listener-only rearm keeps its separate legacy budget',async t=>{
  for(const withMessage of [true,false])await t.test(String(withMessage),async sub=>{
    const f=targetFixture(sub,1);markDelivered(f.paths.inbox,f.rows[0].messageId);let clock=TARGET_T;fs.writeFileSync(f.paths.policy,JSON.stringify({version:1,allowedCommands:[],wake:{enabled:true,sessions:[TARGET_OWNER]}}));
    writeJsonAtomic(livenessFile(f.paths),{version:1,generation:91,sessions:[{runtime:'claude-code',sessionId:TARGET_OWNER,state:'running',observedAt:clock,reasonCode:'observed',lifecycleGeneration:7}],tombstones:[]});
    let arrived=false;
    const result=await runWake({session_id:TARGET_OWNER,hook_event_name:'Stop',permission_mode:'default',cwd:f.root},
      {paths:f.paths,pid:4242,now:()=>clock,parentAlive:()=>true,maxWaitMs:10000,runMode:async()=> 'interactive',launchMode:async()=> 'ok',
      ...syntheticHookFacts(f.paths,TARGET_OWNER,'claude-code',clock),
      sleep:async ms=>{clock+=ms;if(withMessage&&!arrived&&clock>=TARGET_T+4000){arrived=true;storeMessage(f.paths.inbox,{messageId:targetId(701),from:{nodeId:targetId(777),session:'peer'},toSession:TARGET_OWNER,text:'public',createdAt:new Date(clock).toISOString(),senderOrigin:{nodeId:targetId(777),sentAt:new Date(clock).toISOString()}},clock);}}});
    assert.equal(result.code,2);assert.equal(fs.existsSync(f.reservation),withMessage);
    assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
  });
});
test('actual fork scheduler carries one common attempt through helper and RPCs',async t=>{
  const n=forkNode(t);const id=n.add();scheduleForkReply(n.deps(),FORK_OWNER,[id],()=>{});await forkReplyIdle();
  assert.equal(n.app.runs.length,1);assert.ok(n.app.runs[0].requests.some(r=>r.method==='thread/fork'));
  const s=JSON.parse(fs.readFileSync(path.join(n.paths.dir,'codex-native-pending',`${FORK_OWNER}.json`),'utf8'));
  assert.equal(s.outcome.kind,'fork');assert.ok(s.outcome.forkId);assert.ok(s.outcome.turnId);assert.equal(s.budget!==null,true);
});

import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { CLAUDE_CLIENT_GRAPH } from './claude-mcp-client.mts';
test('actual temporary staged client artifacts import their complete runtime graph for both runtimes',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'706-staged-closure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sourceRoot=path.resolve(import.meta.dirname,'..');
  const codex=fs.readFileSync(path.resolve(sourceRoot,'../../codex/install.mts'),'utf8');
  assert.match(codex,/import \{ MESSAGING_CLIENT_GRAPH \} from "\.\.\/modules\/control-plane\/node\/messaging-client-graph\.mts"/);
  assert.ok(codex.includes('for (const relative of MESSAGING_CLIENT_GRAPH) transaction.copyFile(path.join(sources.controlPlane, relative), path.join(targets.messagingClient, relative))'));
  for(const runtime of ['claude','codex']) {
    const dest=path.join(root,runtime);
    for(const f of CLAUDE_CLIENT_GRAPH) {
      const out=path.join(dest,f);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(path.join(sourceRoot,f),out);
    }
    for(const entry of ['mcp-local.mts','mcp-intent-hook.mts','mcp-stdio-bridge.mts'])await import(pathToFileURL(path.join(dest,'node',entry)).href);
  }
});

import { spawnRun } from './codex-runner.mts';
import { runClaude } from './session-runner.mts';
import { parseRouteProducer } from './target-delivery-operation.mts';
test('actual shared runners reject missing contexts while trusted read-only listing remains explicit',async t=>{
  const n=taskNode(t);
  await assert.rejects(runClaude(n.deps(),['agents','--json','--all']),/context missing/);
  assert.equal(await runClaude(n.deps(),['agents','--json','--all'],undefined,{kind:'read-only'}),'[]');
  await assert.rejects(runClaude(n.deps(),['--bg','public'],undefined,{kind:'read-only'}),/cannot launch/);
  const record={taskId:TASK,name:'task-3f2a1b0c',runtime:'codex' as const,permissionMode:'default' as const,state:'done' as const,
    cwd:n.workspace,startedAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()};
  await assert.rejects(spawnRun(n.deps(),record,()=>['exec'],'public'),/context missing/);
});
test('actual queue and fork schedulers compete on different messages and share exactly one debit',async t=>{
  const n=forkNode(t);const p=JSON.parse(fs.readFileSync(n.paths.policy,'utf8'));p.wake.nativeQueue=true;fs.writeFileSync(n.paths.policy,JSON.stringify(p));
  const first=n.add();const second=n.add();const deps=n.deps();let queueSpawns=0;
  const queueDeps={...deps,codex:{...deps.codex,spawn:(()=>{queueSpawns++;const child=Object.assign(new EventEmitter(),{pid:4242,stdout:new PassThrough(),stderr:new PassThrough()});
    queueMicrotask(()=>{child.stdout.write(`Queued message ${targetId(990)} for thread ${FORK_OWNER}.\n`);child.emit('exit',0,null);child.emit('close',0,null);});return child;}) as never}};
  scheduleNativeQueue(queueDeps,FORK_OWNER,[first],undefined,()=>{});await nativeQueueIdle();
  scheduleForkReply(deps,FORK_OWNER,[second],()=>{});await forkReplyIdle();
  assert.equal(queueSpawns,1);assert.equal(n.app.runs.length,0);
  const budget=JSON.parse(fs.readFileSync(path.join(n.paths.dir,'listeners',`${FORK_OWNER}.turns.json`),'utf8'));assert.equal(budget.turns.length,1);assert.equal(budget.groupDebits.length,1);
});
