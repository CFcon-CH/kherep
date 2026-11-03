import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { targetFixture, TARGET_OWNER, TARGET_T, TARGET_LIMITS, targetId } from './target-delivery-fixture.mts';
import { buildMessageLaunch } from './target-delivery-launch.mts';
import { claimRouteContext } from './target-delivery-route.mts';
import { spawnCodex, codexFiles } from './codex-process.mts';
import { spawnRun } from './codex-runner.mts';

for(const home of ['missing','different'])test(`message task rejects ${home} actual CODEX_HOME before process effect`,async t=>{
  const f=targetFixture(t),bin=path.join(f.root,'public-command');fs.writeFileSync(bin,'public');
  const launch=buildMessageLaunch({codex:{home:f.root,findCodex:()=>bin}},{runtime:'codex',args:['exec'],cwd:process.cwd()});
  const context={...claimRouteContext(f.paths,f.rows,{version:1,kind:'task-start',producer:launch.producer,budgetOwner:TARGET_OWNER,
    execution:{runtime:'codex',sessionId:null,taskId:targetId(901)}},{policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},TARGET_T,TARGET_LIMITS)!,launch};
  let calls=0;
  const spawn=(()=>{calls++;const child=Object.assign(new EventEmitter(),{pid:4250,stdin:new PassThrough(),unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}) as never;
  await assert.rejects(spawnCodex({spawn,processStart:()=> 'synthetic'},bin,launch.rawArgs,process.cwd(),codexFiles(f.paths,targetId(901)),
    home==='missing'?{}:{CODEX_HOME:path.join(f.root,'other-home')},'public',true,context,f.paths,{taskId:targetId(901),sessionId:null}),/home/);
  assert.equal(calls,0);assert.equal(JSON.parse(fs.readFileSync(f.reservation,'utf8')).phase,'ready');
});
test('actual task runner passes the captured home to its injected process',async t=>{
  const f=targetFixture(t),bin=path.join(f.root,'public-command');fs.writeFileSync(bin,'public');
  const launch=buildMessageLaunch({codex:{home:f.root,findCodex:()=>bin}},{runtime:'codex',args:['exec'],cwd:process.cwd()});
  const taskId=targetId(902),context={...claimRouteContext(f.paths,f.rows,{version:1,kind:'task-start',producer:launch.producer,budgetOwner:TARGET_OWNER,
    execution:{runtime:'codex',sessionId:null,taskId}},{policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},TARGET_T,TARGET_LIMITS)!,launch};
  let actual:string|undefined;let child:EventEmitter;
  const spawn=((_file:string,_args:string[],opts:{env:NodeJS.ProcessEnv})=>{
    actual=opts.env.CODEX_HOME;child=Object.assign(new EventEmitter(),{pid:4251,stdin:new PassThrough(),unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;
  }) as never;
  await spawnRun({paths:f.paths,policy:{version:1,allowedCommands:[]},now:()=>TARGET_T,codex:{home:f.root,spawn,processStart:()=> 'synthetic'}},
    {taskId,name:'task-synthetic',cwd:process.cwd(),permissionMode:'default',state:'started',startedAt:new Date(TARGET_T).toISOString(),updatedAt:new Date(TARGET_T).toISOString(),deadline:new Date(TARGET_T+60000).toISOString()},
    ()=>launch.rawArgs,'public',undefined,context);
  child!.emit('exit',0,null);assert.equal(actual,f.root);
});
