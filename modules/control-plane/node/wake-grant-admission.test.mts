// Generated stores, synthetic Authority/clock, and injected writer only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {setup,SELF,PEER,T0,id,sentOriginal,dispatchedRequest,ORIGINAL,REQUESTED_TASK} from './wake-fixture.mts';
import {runWake,emitWakeResult,WAKE_SETTLE_MS} from './wake-hook.mts';
import {syntheticHookFacts} from './target-delivery-test-support.mts';
import {publishSynthetic,fixtureEvidence} from './session-authority-fixture.mts';
import {readPolicy} from './policy.mts';
import {storeMessage,writeJsonAtomic} from './inbox.mts';
import {getSent} from './exchange.mts';
import {readRequest,writeRequest,writeTask} from './task-records.mts';
import {REPLY_GRANT_MAX_AGE_MS as AGE} from './wake-reply.mts';

const OWNER=id(0x777),REQUEST=id(0x601);
function fixture(t:test.TestContext,options:{sessions?:string[];owner?:boolean;legacy?:boolean;originOffsets?:Partial<Record<'owner'|'reply'|'request'|'both'|'plain',number>>}={}) {
  const f=setup(t,{wake:{enabled:true,sessions:options.sessions??[],replies:true}});
  let clock=T0,expireAfterProducer=false,producerRead=false;
  const facts=syntheticHookFacts(f.paths,SELF,'claude-code',clock);
  const policy=JSON.parse(fs.readFileSync(f.paths.policy,'utf8'));
  policy.sessions={enabled:true,runtimes:['claude'],workspaceRoots:[fs.realpathSync.native(f.paths.dir)],delegate:{accept:true}};
  fs.writeFileSync(f.paths.policy,JSON.stringify(policy));assert.ok(readPolicy(f.paths.policy,true)?.wake);
  if(options.owner)writeTask(f.paths,{taskId:OWNER,name:'review',runtime:'claude',sessionId:SELF,cwd:fs.realpathSync.native(f.paths.dir),permissionMode:'default',state:'done',startedAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()});
  sentOriginal(f.paths,options.legacy?{fromSessionId:undefined}:{});
  dispatchedRequest(f.paths,options.legacy?{requestedBySessionId:undefined}:{});
  const publish=(name='review',extra=false)=>publishSynthetic(f.paths,[{...fixtureEvidence({runtime:'claude-code',sessionId:SELF},'running',clock),lifecycle:{status:'value',value:{state:'restored',generation:7},source:'native-lifecycle',observedAt:clock,complete:true,reasonCode:'observed'}}],clock,
    [{runtime:'claude-code',sessionId:SELF,state:'running',name},...(extra?[{runtime:'claude-code',sessionId:id(0x888),state:'unknown',name}]:[])],facts.livenessAuthority);
  publish();
  const add=(kind:'owner'|'reply'|'request'|'both'|'plain',n:number)=>storeMessage(f.paths.inbox,{messageId:id(n),from:{nodeId:PEER,session:'build'},toSession:SELF,text:'public fixture',createdAt:new Date(clock).toISOString(),senderOrigin:{nodeId:PEER,sentAt:new Date(clock+(options.originOffsets?.[kind]??0)).toISOString()},...(kind==='owner'?{taskId:OWNER}:kind==='request'?{taskId:REQUESTED_TASK}:kind==='reply'?{inReplyTo:ORIGINAL}:kind==='both'?{inReplyTo:ORIGINAL,taskId:REQUESTED_TASK}:{})},clock);
  const run=async(kinds:Parameters<typeof add>[0][],settle?:()=>void)=>runWake({session_id:SELF,hook_event_name:'Stop',permission_mode:'default',cwd:f.paths.dir},{paths:f.paths,...facts,now:()=>clock+(expireAfterProducer&&producerRead?1:0),pid:4242,parentAlive:()=>true,runMode:async()=> 'interactive',maxWaitMs:10000,
    sleep:async ms=>{clock+=ms;if(clock===T0+4000)kinds.forEach((k,n)=>add(k,n+1));if(ms===WAKE_SETTLE_MS)settle?.();}});
  const emit=(result:Awaited<ReturnType<typeof runWake>>)=>{let calls=0;const emitted=emitWakeResult(result,{paths:f.paths},()=>{calls++;});return {emitted,calls};};
  const sent=(patch:object)=>writeJsonAtomic(path.join(f.paths.sent,`${ORIGINAL}.json`),{...getSent(f.paths,ORIGINAL),...patch});
  const request=(patch:object)=>writeRequest(f.paths,{...readRequest(f.paths,REQUEST)!,...patch});
  const reservation=()=>JSON.parse(fs.readFileSync(path.join(f.paths.dir,'codex-native-pending',`${SELF}.json`),'utf8'));
  const complete=(n:number,minimum=T0+4000+86400000)=>{const r=reservation();assert.equal(r.group.binding.members.length,n);assert.deepEqual(new Set(r.group.binding.members.map((m:{messageId:string})=>m.messageId)),new Set(Array.from({length:n},(_,i)=>id(i+1))));assert.equal(r.group.binding.deadlineMs,minimum);assert.equal(JSON.parse(fs.readFileSync(path.join(f.paths.dir,'listeners',`${SELF}.turns.json`),'utf8')).turns.length,1);};
  return {...f,run,emit,publish,sent,request,complete,reservation,advance:(n:number)=>{clock+=n;},ageStep:()=>{
    expireAfterProducer=true;producerRead=false;
    const open=fs.openSync,read=fs.readSync,descriptors=new Set<number>();
    t.mock.method(fs,'openSync',((file:fs.PathLike,...args:unknown[])=>{const fd=Reflect.apply(open,fs,[file,...args]);if(String(file)===facts.messageProducer.files[0].path)descriptors.add(fd);return fd;}) as typeof fs.openSync);
    t.mock.method(fs,'readSync',((fd:number,...args:unknown[])=>{const result=Reflect.apply(read,fs,[fd,...args]);if(descriptors.has(fd))producerRead=true;return result;}) as typeof fs.readSync);
  },setAges:()=>{const createdAt=new Date(T0+4250-AGE).toISOString();sent({createdAt});request({createdAt});}};
}
test('positive same-name coherent publication reaches reservation and actual writer',async t=>{const f=fixture(t,{sessions:['review']});const r=await f.run(['plain'],()=>f.publish());assert.equal(r.code,2);f.complete(1);assert.deepEqual(f.emit(r),{emitted:true,calls:1});});
test('positive owner task alone reaches reservation and actual writer',async t=>{const f=fixture(t,{owner:true});const r=await f.run(['owner']);assert.equal(r.code,2);f.complete(1);assert.equal(f.emit(r).calls,1);});
for(const [name,sessions] of [['unlisted',['review']],['also-listed',['review','renamed']]] as const)test(`selected name cannot survive ${name} rename during settle`,async t=>{const f=fixture(t,{sessions:[...sessions]});const r=await f.run(['plain'],()=>f.publish('renamed'));assert.equal(f.emit(r).calls,0);assert.equal(r.code,0);});
test('full-ID and wildcard selection survive coherent rename',async t=>{for(const sessions of [[SELF],['*']]){const f=fixture(t,{sessions});const r=await f.run(['plain'],()=>f.publish('renamed'));assert.equal(r.code,2);assert.equal(f.emit(r).calls,1);}});
for(const kinds of [['owner','reply'],['owner','request'],['owner','reply','request']] as const)test(`complete mixed ${kinds.join('+')} group uses one debit`,async t=>{const f=fixture(t,{owner:true});const r=await f.run([...kinds]);assert.equal(r.code,2);f.complete(kinds.length);assert.equal(f.emit(r).calls,1);});
test('selected reply never switches to available task-message after revocation',async t=>{const f=fixture(t);const r=await f.run(['both']);assert.equal(r.code,2);f.sent({state:'refused'});assert.equal(f.emit(r).calls,0);f.complete(1);});
test('selected task-message never switches to newly available reply',async t=>{const f=fixture(t);f.sent({state:'refused'});const r=await f.run(['both']);assert.equal(r.code,2);f.request({state:'refused'});f.sent({state:'accepted'});assert.equal(f.emit(r).calls,0);});
test('replacement request with same task ID cannot replace selected identity',async t=>{const f=fixture(t);const r=await f.run(['request']);assert.equal(r.code,2);f.request({taskId:undefined});dispatchedRequest(f.paths,{requestId:id(0x999)});assert.equal(f.emit(r).calls,0);});
test('original accepted-to-delivered sent progress remains valid',async t=>{const f=fixture(t);const r=await f.run(['reply']);assert.equal(r.code,2);f.sent({state:'delivered'});assert.equal(f.emit(r).calls,1);});
for(const kind of ['reply','request'] as const)test(`${kind} age equality passes and final sample age+1 refuses actual writer`,async t=>{const f=fixture(t);f.setAges();const r=await f.run([kind]);assert.equal(r.code,2);assert.equal(f.emit(r).calls,1);f.ageStep();assert.equal(f.emit(r).calls,0);});
for(const kind of ['reply','request'] as const)test(`legacy ${kind} basis refuses renamed and ambiguous target`,async t=>{for(const ambiguous of [false,true]){const f=fixture(t,{legacy:true});const r=await f.run([kind]);assert.equal(r.code,2);f.publish(ambiguous?'review':'renamed',ambiguous);assert.equal(f.emit(r).calls,0);}});
test('UUID sent and request bases survive unrelated name change',async t=>{const f=fixture(t);const r=await f.run(['reply','request']);assert.equal(r.code,2);f.publish('renamed');assert.equal(f.emit(r).calls,1);});
test('mixed complete group retains every member at common SEND equality',async t=>{const f=fixture(t,{owner:true});const r=await f.run(['owner','reply','request']);assert.equal(r.code,2);f.complete(3);f.advance(86400000-250);assert.equal(f.emit(r).calls,0);assert.equal(f.reservation().group.binding.members.length,3);});

test('mixed group with one uniquely earliest SEND deadline writes at D-1 and refuses whole group at D with unchanged fences',async t=>{
  const D=T0+4350,f=fixture(t,{owner:true,originOffsets:{owner:350-86400000}});
  const result=await f.run(['owner','reply','request']);
  assert.equal(result.code,2,'mixed positive control reaches a complete reserved group');
  f.complete(3,D);
  const binding=f.reservation().group.binding;
  assert.equal(binding.members.filter((m:{deadlineMs:number})=>m.deadlineMs===D).length,1);
  assert.equal(binding.members.find((m:{messageId:string})=>m.messageId===id(1)).deadlineMs,D);
  assert.ok(binding.members.filter((m:{messageId:string})=>m.messageId!==id(1)).every((m:{deadlineMs:number})=>m.deadlineMs===T0+4000+86400000));
  const snapshot=()=>({owner:fs.readFileSync(path.join(f.paths.dir,'codex-native-pending',`${SELF}.json`)),
    budget:fs.readFileSync(path.join(f.paths.dir,'listeners',`${SELF}.turns.json`)),
    groups:fs.readdirSync(path.join(f.paths.dir,'target-delivery-groups',SELF)).sort().map(name=>[name,fs.readFileSync(path.join(f.paths.dir,'target-delivery-groups',SELF,name))]),
    members:[1,2,3].map(n=>fs.readFileSync(path.join(f.paths.inbox,`${id(n)}.json`)))});
  const frozen=snapshot();assert.equal(frozen.groups.length,1);
  f.advance(99);assert.deepEqual(f.emit(result),{emitted:true,calls:1},'D-1 actual writer positive control');
  assert.deepEqual(snapshot(),frozen,'positive writer also preserves owner, group, members and debit');
  f.advance(1);assert.deepEqual(f.emit(result),{emitted:false,calls:0},'D adds zero output and admits no subset');
  f.complete(3,D);assert.deepEqual(f.reservation().handle,JSON.parse(frozen.owner.toString()).handle);
  assert.deepEqual(snapshot(),frozen,'refusal preserves all owner/reservation/history/member/budget bytes');
});
