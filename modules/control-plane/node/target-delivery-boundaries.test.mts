import {syntheticLaunchFacts} from './target-delivery-test-support.mts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {runFork,RECORD,PRODUCER} from './codex-fork-run-fixture.mts';
import {targetFixture,TARGET_OWNER,TARGET_T,TARGET_LIMITS,targetId} from './target-delivery-fixture.mts';
import {claimRouteContext,beginRouteEffect} from './target-delivery-route.mts';
import {buildMessageLaunch} from './target-delivery-launch.mts';
import {admitWindowControl,windowControl} from './target-delivery-window.mts';
import {runWindowless} from './codex-windowless.mts';

test('actual direct fork refuses missing context, wrong/missing member, wrong producer and replay before a second helper',async t=>{
  await assert.rejects(runFork(t,{}, {context:undefined}),/context missing/);
  await assert.rejects(runFork(t,{}, {record:{...RECORD,messageId:targetId(999)}}),/member\/producer differs/);
  await assert.rejects(runFork(t,{}, {record:{...RECORD,text:'different synthetic member'}}),/member\/producer differs/);
  await assert.rejects(runFork(t,{}, {producer:PRODUCER}),/member\/producer differs/);
  const first=await runFork(t);assert.equal(first.outcome.state,'completed');
  await assert.rejects(first.replay(),/phase differs|context incoherent/);assert.equal(first.app.runs.length,1);
});
function windows(t:test.TestContext) {
  const f=targetFixture(t),bin=path.join(f.root,'public-command.exe');fs.writeFileSync(bin,'public');
  const wrapper=new URL('./codex-windowless.mts',import.meta.url).pathname,args=['exec'];
  const launch=buildMessageLaunch({codex:{home:f.root,findCodex:()=>bin,platform:'win32'}},{runtime:'codex',file:bin,args,cwd:process.cwd(),detached:true});
  const setup=syntheticLaunchFacts(f.paths,TARGET_OWNER,launch,{taskId:null,sessionId:TARGET_OWNER},()=>TARGET_T,{route:'task-wake',grant:'listed',permissionMode:'default'});
  const context=setup.bind({...claimRouteContext(f.paths,f.rows,{version:1,kind:'exec-resume',producer:launch.producer,budgetOwner:TARGET_OWNER,
    execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},setup.facts,TARGET_T,TARGET_LIMITS)!,launch});
  beginRouteEffect(f.paths,context,['exec-resume']);return {...f,bin,wrapper,args,context};
}
test('self-consistent alternate Windows Node or wrapper cannot replace the prepared producer',t=>{
  const f=windows(t),other=path.join(f.root,'other-public-wrapper.mts');fs.writeFileSync(other,'public');
  const env={CODEX_HOME:f.root};
  assert.throws(()=>admitWindowControl(windowControl(f.context,f.paths,f.bin,f.args,f.wrapper,other),f.bin,f.args,f.wrapper,other,env),/producer or home differs/);
  assert.throws(()=>admitWindowControl(windowControl(f.context,f.paths,f.bin,f.args,other),f.bin,f.args,other,process.execPath,env),/producer or home differs/);
  assert.equal(JSON.parse(fs.readFileSync(f.reservation,'utf8')).innerStarted,false);
});
test('Windows inner home refusal precedes an effect and delayed input context loss kills only the injected child',async t=>{
  const f=windows(t),envelope=windowControl(f.context,f.paths,f.bin,f.args,f.wrapper);
  assert.throws(()=>admitWindowControl(envelope,f.bin,f.args,f.wrapper,process.execPath,{CODEX_HOME:path.join(f.root,'other-home')}),/home differs/);
  let killed=0,written='';const input=new PassThrough(),childInput=new PassThrough();childInput.on('data',value=>written+=value);
  const start=(()=>{
    const child=Object.assign(new EventEmitter(),{stdin:childInput,stdout:new PassThrough(),stderr:new PassThrough(),kill(){killed++;child.emit('close',1);}});
    queueMicrotask(()=>{fs.writeFileSync(path.join(f.paths.inbox,`${f.rows[0].messageId}.json`),JSON.stringify({...f.rows[0],text:'changed synthetic member'}));input.end('unreleased synthetic prompt');});
    return child;
  }) as never;
  input.write(envelope);
  await assert.rejects(runWindowless(f.bin,f.args,input,new PassThrough(),new PassThrough(),start,f.wrapper,1000,{CODEX_HOME:f.root},{contextFor:()=>f.context}),/input context refused/);
  assert.equal(written,'');assert.equal(killed,1);
});
