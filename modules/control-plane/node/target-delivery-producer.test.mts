import {syntheticLaunchFacts} from './target-delivery-test-support.mts';
import { buildMessageLaunch } from "./target-delivery-launch.mts";
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { targetFixture, TARGET_OWNER, TARGET_T, TARGET_LIMITS, targetId } from './target-delivery-fixture.mts';
import { claimRouteContext as claimRoute, beginRouteEffect } from './target-delivery-route.mts';
import { commandProducer } from './target-delivery-producer.mts';
import { parseRouteProducer } from './target-delivery-operation.mts';
import { windowControl } from './target-delivery-window.mts';
import { runWindowless } from './codex-windowless.mts';

const wrapper=new URL('./codex-windowless.mts',import.meta.url).pathname;
test('strict producer refuses bool, missing native consumer facts and extra fields',t=>{
  const f=targetFixture(t);assert.throws(()=>parseRouteProducer(true),/unknown/);
  assert.throws(()=>parseRouteProducer({...f.group.producer,kind:'hook'}),/unknown/);
});
test('actual Windows inner protocol rejects missing, partial, wrong-command and replayed message controls before inner spawn',async t=>{
  const f=targetFixture(t);const bin=path.join(f.root,'command.exe');fs.writeFileSync(bin,'public');const args=['exec'];
  const launch=buildMessageLaunch({codex:{findCodex:()=>bin,home:f.root,platform:'win32'}},{runtime:'codex',file:bin,args,cwd:process.cwd(),detached:true});
  const producer=launch.producer;
  const context=claimRoute(f.paths,f.rows,{version:1,kind:'exec-resume',producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},
    {policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},TARGET_T,TARGET_LIMITS)!;
  beginRouteEffect(f.paths,context,['exec-resume']);let spawns=0;
  const start=(()=>{spawns++;const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
    child.stdin.on('finish',()=>queueMicrotask(()=>child.emit('close',0)));return child;}) as never;
  const invoke=async(text:string,command=bin)=>{const input=new PassThrough();input.end(text);return runWindowless(command,args,input,new PassThrough(),new PassThrough(),start,wrapper,30000,{CODEX_HOME:f.root});};
  await assert.rejects(invoke(''),/incomplete/);await assert.rejects(invoke('{'),/incomplete/);
  const envelope=windowControl(context,f.paths,bin,args,wrapper);
  await assert.rejects(invoke(envelope,bin+'-other'),/binding/);assert.equal(spawns,0);
  await assert.rejects(invoke(envelope+'public synthetic prompt'),/authority unavailable/);assert.equal(spawns,0);
  await assert.rejects(invoke(envelope),/authority unavailable/);assert.equal(spawns,0);
});

import { prepareMessageLaunch,verifyPreparedLaunch } from './target-delivery-launch.mts';
import { spawnCodex,codexFiles } from './codex-process.mts';
test('final MCP overrides are captured with one explicit executable resolution and spawned unchanged',async t=>{
  const f=targetFixture(t),bin=path.join(f.root,'public-command');fs.writeFileSync(bin,'public');let finds=0,lists=0;
  const launch=await prepareMessageLaunch({codex:{home:f.root,findCodex:()=>{finds++;return bin;},mcpList:async args=>{lists++;return {code:0,stdout:JSON.stringify(args[0]==='mcp'?[{name:'synthetic',enabled:true}]:[]),stderr:''};}}},
    {runtime:'codex',args:['exec'],cwd:process.cwd(),intercom:true});
  assert.equal(finds,1);assert.equal(lists,2);assert.deepEqual(launch.rawArgs,['-c','mcp_servers.synthetic.enabled=false','exec']);
  const setup=syntheticLaunchFacts(f.paths,TARGET_OWNER,launch,{taskId:targetId(901),sessionId:null},()=>TARGET_T,{route:'closed-start',grant:'resumeClosed',taskId:targetId(901),permissionMode:'default'});
  const claimed=claimRoute(f.paths,f.rows,{version:1,kind:'task-start',producer:launch.producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex',sessionId:null,taskId:targetId(901)}},
    setup.facts,TARGET_T,TARGET_LIMITS)!;
  const ctx=setup.bind({...claimed,launch});let called=0;
  const spawn= ((_file:string,_args:string[],_opts:unknown)=>{called++;assert.equal(_file,launch.outer.file);assert.deepEqual(_args,launch.outer.args);const child=Object.assign(new EventEmitter(),{pid:4242,stdin:new PassThrough(),unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}) as never;
  await assert.rejects(spawnCodex({spawn},bin,launch.rawArgs,process.cwd(),codexFiles(f.paths,targetId(901)),{},'public',true,ctx,f.paths,{taskId:targetId(902),sessionId:null}),/differs/);assert.equal(called,0);
  await spawnCodex({spawn,processStart:()=> 'synthetic'},bin,launch.rawArgs,process.cwd(),codexFiles(f.paths,targetId(901)),{CODEX_HOME:f.root},'public',true,ctx,f.paths,{taskId:targetId(901),sessionId:null});assert.equal(called,1);
});
test('member change after process identity await denies prompt stdin and preserves measured outcome',async t=>{
  const f=targetFixture(t),bin=path.join(f.root,'public-command');fs.writeFileSync(bin,'public');
  const launch=buildMessageLaunch({codex:{home:f.root,findCodex:()=>bin}},{runtime:'codex',args:['exec'],cwd:process.cwd()});
  const setup=syntheticLaunchFacts(f.paths,TARGET_OWNER,launch,{taskId:null,sessionId:TARGET_OWNER},()=>TARGET_T,{route:'task-wake',grant:'listed',permissionMode:'default'});
  const ctx=setup.bind({...claimRoute(f.paths,f.rows,{version:1,kind:'exec-resume',producer:launch.producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},
    setup.facts,TARGET_T,TARGET_LIMITS)!,launch});
  const input=new PassThrough();let delivered='';input.on('data',x=>delivered+=x);
  const spawn=(()=>{const child=Object.assign(new EventEmitter(),{pid:4243,stdin:input,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}) as never;
  await assert.rejects(spawnCodex({spawn,processStart:async()=>{fs.writeFileSync(path.join(f.paths.inbox,`${f.rows[0].messageId}.json`),JSON.stringify({...f.rows[0],text:'changed'}));return 'synthetic';}},bin,launch.rawArgs,process.cwd(),codexFiles(f.paths,targetId(901)),{CODEX_HOME:f.root},'public',true,ctx,f.paths,{taskId:null,sessionId:TARGET_OWNER}),/before stdin/);
  assert.equal(delivered,'');const s=JSON.parse(fs.readFileSync(f.reservation,'utf8'));assert.equal(s.phase,'uncertain');assert.equal(s.outcome.pid,4243);assert.equal(s.budget!==null,true);
});
