// Generated stores and same-process Authority only. No native/vendor calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as admission from './message-admission.mts';
import {setup,SELF,T0,arrive,id} from './wake-fixture.mts';
import {syntheticHookFacts} from './target-delivery-test-support.mts';
import {readPolicy} from './policy.mts';
import {captureListedGrant} from './message-grant.mts';
import {getMessage} from './inbox.mts';
import {decideMessageRoute} from './target-delivery-producer.mts';
import {beginRouteEffect,withRoute,routeHistory} from './target-delivery-route.mts';
import {finishRouteEffect} from './target-delivery-outcome.mts';
import {budgetFile} from './budget-store.mts';
import {revokeAuthority,faultAuthority,stopAuthority} from './session-authority.mts';
import {DISPLAY_TTL_MS} from './session-liveness.mts';
import {livenessFile} from './session-lifecycle.mts';
import type {ExecutionContext,RouteReservation} from './target-delivery-operation.mts';

function fixture(t:test.TestContext,nearDeadline=false) {
  const {paths}=setup(t,{wake:{enabled:true,sessions:[SELF]}});let clock=T0;
  const facts=syntheticHookFacts(paths,SELF,'claude-code',clock);
  arrive(paths,1,nearDeadline?T0-86400000+1000:T0,SELF);
  const row=getMessage(paths.inbox,id(1))!,policy=readPolicy(paths.policy,true)!;
  const grant=captureListedGrant(policy,{runtime:'claude-code',sessionId:SELF})!;assert.ok(grant);
  const result=decideMessageRoute({paths,...facts,policy,now:()=>clock,
    messageRoute:{route:'claude-wake',grant:'members',memberGrants:[{...grant,messageId:row.messageId}],permissionMode:'default'}},
    [row],SELF,'hook-continue',{runtime:'claude-code',sessionId:SELF,taskId:null},facts.messageProducer);
  assert.equal(result.status,'granted');
  if(result.status!=='granted'||result.context.kind!=='message')throw Error('positive context unavailable');
  const context=result.context;beginRouteEffect(paths,context,['hook-continue']);finishRouteEffect(paths,context,{kind:'hook',emitted:true});
  const owner=path.join(paths.dir,'codex-native-pending',SELF+'.json'),budget=budgetFile(paths,SELF),history=routeHistory(paths,context.handle);
  const current=():RouteReservation=>JSON.parse(fs.readFileSync(owner,'utf8'));
  const protectedBytes=()=>[owner,budget,history].map(f=>fs.existsSync(f)?fs.readFileSync(f).toString('hex'):null);
  const effect=(body:(s:RouteReservation)=>undefined,ctx:ExecutionContext|undefined=context,deps={paths})=>{
    assert.equal(typeof admission.withAdmittedHookEffect,'function','new atomic hook admission API');
    return admission.withAdmittedHookEffect(deps,ctx,body);
  };
  return {paths,facts,context,owner,budget,history,current,protectedBytes,effect,setClock:(v:number)=>{clock=v;}};
}

test('original admission runs once under one existing non-reentrant owner lock',t=>{
  const f=fixture(t),before=f.protectedBytes();let calls=0;
  assert.deepEqual(admission.checkMessageEffect(f,f.context,'continuation-output'),{ok:true});
  assert.deepEqual(f.effect(s=>{calls++;assert.deepEqual(s,f.current());
    assert.throws(()=>withRoute(f.paths,f.context.handle,()=>{}),/native owner mutation held/);
    return undefined;}),{ok:true});
  assert.equal(calls,1);assert.deepEqual(f.protectedBytes(),before);
  assert.deepEqual(admission.checkMessageEffect(f,f.context,'continuation-output'),{ok:true});
});

for(const kind of ['undefined','operator','read-only','json','foreign-handle','foreign-paths'] as const)
test(`hook admission rejects ${kind} without an operator or serialized bypass`,t=>{
  const f=fixture(t),before=f.protectedBytes();let calls=0;
  const context=kind==='undefined'?undefined:kind==='operator'?{kind:'operator'} as const:kind==='read-only'?{kind:'read-only'} as const
    :kind==='json'?JSON.parse(JSON.stringify(f.context)):kind==='foreign-handle'?{...f.context,handle:{...f.context.handle,attemptToken:id(999)}}:f.context;
  const deps=kind==='foreign-paths'?{paths:{...f.paths,dir:f.paths.dir+'-foreign'}}:f;
  assert.deepEqual(admission.withAdmittedHookEffect(deps,context,()=>{calls++;return undefined;}),{ok:false,code:'context-unavailable'});
  assert.equal(calls,0);assert.deepEqual(f.protectedBytes(),before);
});

for(const drift of ['revoked','faulted','stopped','policy','producer','member','transition','debit','lifecycle','operation'] as const)
test(`locked admission preserves the original ${drift} refusal`,t=>{
  const f=fixture(t);
  if(drift==='revoked')revokeAuthority(f.facts.livenessAuthority);
  if(drift==='faulted')faultAuthority(f.facts.livenessAuthority);
  if(drift==='stopped')stopAuthority(f.facts.livenessAuthority);
  if(drift==='policy'){const p=readPolicy(f.paths.policy,true)!;fs.writeFileSync(f.paths.policy,JSON.stringify({...p,wake:{...p.wake,sessions:[]}}));}
  if(drift==='producer')fs.appendFileSync(f.facts.messageProducer.files[0].path,'changed');
  if(drift==='member'){const file=path.join(f.paths.inbox,id(1)+'.json');const row=getMessage(f.paths.inbox,id(1))!;fs.writeFileSync(file,JSON.stringify({...row,text:'changed'}));}
  if(drift==='transition'){const s=f.current();s.transitions.push({messageId:id(1),before:'a'.repeat(64),after:'b'.repeat(64),patch:{set:{},unset:[]},applied:false});fs.writeFileSync(f.owner,JSON.stringify(s));fs.writeFileSync(f.history,JSON.stringify(s));}
  if(drift==='debit')fs.writeFileSync(f.budget,'{}');
  if(drift==='lifecycle'){const target=livenessFile(f.paths),s=JSON.parse(fs.readFileSync(target,'utf8'));
    for(const row of s.sessions??[])row.lifecycleGeneration=99;fs.writeFileSync(target,JSON.stringify(s));}
  if(drift==='operation'){const s=f.current();s.group.operation.kind='queue';fs.writeFileSync(f.owner,JSON.stringify(s));}
  const expected=admission.checkMessageEffect(f,f.context,'continuation-output');assert.equal(expected.ok,false);
  const before=f.protectedBytes();let calls=0;
  assert.deepEqual(f.effect(()=>{calls++;return undefined;}),expected);
  assert.equal(calls,0);assert.deepEqual(f.protectedBytes(),before);
});

for(const timing of ['deadline-1','deadline','authority-expired','read-revokes','read-expires-origin'] as const)
test(`atomic hook admission samples ${timing}`,t=>{
  const f=fixture(t,timing!=='authority-expired'&&timing!=='read-revokes');let calls=0;
  if(timing==='deadline-1')f.setClock(T0+999);
  if(timing==='deadline')f.setClock(T0+1000);
  if(timing==='authority-expired')f.setClock(T0+DISPLAY_TTL_MS+1);
  if(timing.startsWith('read-')){
    const read=fs.readFileSync;let hit=false;
    t.mock.method(fs,'readFileSync',((...args:Parameters<typeof read>)=>{
      const value=Reflect.apply(read,fs,args);
      if(!hit&&args[0]===f.paths.policy){hit=true;if(timing==='read-revokes')revokeAuthority(f.facts.livenessAuthority);else f.setClock(T0+1000);}
      return value;
    }) as typeof read);
  }
  const result=f.effect(()=>{calls++;return undefined;});
  assert.equal(result.ok,timing==='deadline-1');assert.equal(calls,timing==='deadline-1'?1:0);
});

test('body errors and invalid return contracts escape distinctly and release the lock',t=>{
  const f=fixture(t),error=Error('receipt write failed');let calls=0;const before=f.protectedBytes();
  assert.throws(()=>f.effect(()=>{calls++;throw error;}),e=>e===error);assert.equal(calls,1);
  assert.deepEqual(admission.checkMessageEffect(f,f.context,'continuation-output'),{ok:true});
  assert.throws(()=>f.effect((()=>Promise.resolve()) as unknown as (s:RouteReservation)=>undefined),/synchronous|undefined/);
  assert.deepEqual(f.protectedBytes(),before);
});
