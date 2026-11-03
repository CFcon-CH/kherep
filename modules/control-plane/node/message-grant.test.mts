// Public generated stores and explicit current-run Authority only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {captureListedGrant,captureOwnerGrant,currentTargetRefs,checkMemberGrantsCurrent,grantTimesValid,type MemberGrant} from './message-grant.mts';
import {targetFixture,TARGET_OWNER,TARGET_T,TARGET_LIMITS,targetId} from './target-delivery-fixture.mts';
import {syntheticLaunchFacts} from './target-delivery-test-support.mts';
import {buildMessageLaunch} from './target-delivery-launch.mts';
import {bindMessageAdmission,checkMessageEffect} from './message-admission.mts';
import {claimRouteContext,beginRouteEffect} from './target-delivery-route.mts';
import {readTask,writeTask,writeRequest} from './task-records.mts';
import {readLivenessSnapshot} from './session-lifecycle.mts';
import {publishSynthetic,fixtureEvidence} from './session-authority-fixture.mts';
import {setup,SELF,PEER,T0,id,sentOriginal,dispatchedRequest,ORIGINAL,REQUESTED_TASK} from './wake-fixture.mts';
import {captureUnlistedGrant,REPLY_GRANT_MAX_AGE_MS as AGE} from './wake-reply.mts';
import {getSent} from './exchange.mts';
import {storeMessage,writeJsonAtomic} from './inbox.mts';

function launchFixture(t:test.TestContext) {
  const f=targetFixture(t),bin=path.join(f.root,'generated-command');fs.writeFileSync(bin,'public fixture');
  const launch=buildMessageLaunch({codex:{home:f.root,findCodex:()=>bin}},{runtime:'codex',args:['exec'],cwd:fs.realpathSync.native(f.root)});
  const setup=syntheticLaunchFacts(f.paths,TARGET_OWNER,launch,{taskId:null,sessionId:TARGET_OWNER},()=>TARGET_T,{route:'task-wake',grant:'listed',permissionMode:'default'});
  const context={...claimRouteContext(f.paths,f.rows,{version:1,kind:'exec-resume',producer:launch.producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},setup.facts,TARGET_T,TARGET_LIMITS)!,launch};
  const target={runtime:'codex',sessionId:TARGET_OWNER},basis=captureListedGrant(setup.deps.policy,target)!;
  const witnesses=f.rows.map(r=>({...basis,messageId:r.messageId}));
  return {...f,setup,target,context,witnesses};
}
test('binding deep-copies and freezes caller-owned witness arrays and nested projections',t=>{
  const f=launchFixture(t);const context=bindMessageAdmission(f.setup.deps,f.context,{route:'task-wake',grant:'members',permissionMode:'default',memberGrants:f.witnesses});
  f.witnesses[0].entry='changed';f.witnesses[0].target.sessionId='changed';f.witnesses.pop();
  beginRouteEffect(f.paths,context,['exec-resume']);assert.deepEqual(checkMessageEffect(f.setup.deps,context,'outer-spawn'),{ok:true});
});
test('binding rejects duplicate omitted extra and unknown-kind witness sets',t=>{
  const f=launchFixture(t);
  for(const memberGrants of [[f.witnesses[0],f.witnesses[0]],[f.witnesses[0]],[...f.witnesses,{...f.witnesses[0],messageId:targetId(999)}],[{...f.witnesses[0],kind:'authorized'},f.witnesses[1]]])
    assert.throws(()=>bindMessageAdmission(f.setup.deps,f.context,{route:'task-wake',grant:'members',memberGrants:memberGrants as MemberGrant[]}),/grant membership/);
});
test('alias reads explicitly refuse missing malformed incoherent ambiguous and partial publications; ID and wildcard stay independent',t=>{
  const f=launchFixture(t),generation=readLivenessSnapshot(f.paths)!.generation,original=JSON.parse(fs.readFileSync(f.paths.sessions,'utf8'));
  const mutations:[string,unknown][]=[['missing',null],['malformed','{'],['malformed',{...original,sessions:[null]}],['incoherent',{...original,generation:generation+1}],['ambiguous',{...original,sessions:[...original.sessions,...original.sessions]}],['incoherent',{...original,unseen:['codex']}]];
  for(const [reason,value] of mutations){if(value===null)fs.rmSync(f.paths.sessions);else fs.writeFileSync(f.paths.sessions,typeof value==='string'?value:JSON.stringify(value));
    assert.deepEqual(currentTargetRefs(f.paths,f.target,generation,TARGET_T),{status:'refused',reason});
    assert.deepEqual(checkMemberGrantsCurrent(f.paths,f.setup.deps.policy,f.target,f.rows,f.witnesses,TARGET_T),[]);
    const wildcard=f.rows.map(r=>({...captureListedGrant({...f.setup.deps.policy,wake:{enabled:true,sessions:['*']}},f.target)!,messageId:r.messageId}));
    assert.deepEqual(checkMemberGrantsCurrent(f.paths,{...f.setup.deps.policy,wake:{enabled:true,sessions:['*']}},f.target,f.rows,wildcard,TARGET_T),[]);
  }
  fs.writeFileSync(f.paths.sessions,JSON.stringify(original));
  assert.deepEqual(currentTargetRefs(f.paths,f.target,generation,TARGET_T),{status:'available',refs:[TARGET_OWNER]});
  const read=fs.readFileSync;
  const mock=t.mock.method(fs,'readFileSync',((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
    if(file===f.paths.sessions)throw Object.assign(new Error('generated I/O failure'),{code:'EIO'});
    return Reflect.apply(read,fs,[file,...args]);
  }) as typeof fs.readFileSync);
  try {assert.deepEqual(currentTargetRefs(f.paths,f.target,generation,TARGET_T),{status:'refused',reason:'unreadable'});}
  finally {mock.mock.restore();}
  assert.deepEqual(currentTargetRefs(f.paths,f.target,generation,TARGET_T),{status:'available',refs:[TARGET_OWNER]});
});
test('task-name listing retains task source and identity instead of directory-name substitution',t=>{
  const f=launchFixture(t);const task=writeTask(f.paths,{taskId:targetId(901),runtime:'codex',sessionId:TARGET_OWNER,name:'task-name',cwd:fs.realpathSync.native(f.root),permissionMode:'default',state:'done',startedAt:new Date(TARGET_T).toISOString(),updatedAt:new Date(TARGET_T).toISOString(),deadline:new Date(TARGET_T+1000).toISOString()});
  const policy={...f.setup.deps.policy,wake:{enabled:true as const,sessions:['task-name',TARGET_OWNER,'*']}};
  assert.equal(captureListedGrant(policy,f.target,{kind:'task',task})?.via,'full-id');
  policy.wake.sessions=['task-name','*'];const basis=captureListedGrant(policy,f.target,{kind:'task',task})!;assert.equal(basis.via,'task-name');
  const witnesses=f.rows.map(r=>({...basis,messageId:r.messageId}));assert.deepEqual(checkMemberGrantsCurrent(f.paths,policy,f.target,f.rows,witnesses,TARGET_T),[]);
  writeTask(f.paths,{...task,name:'changed'});assert.equal(checkMemberGrantsCurrent(f.paths,policy,f.target,f.rows,witnesses,TARGET_T),null);
});
test('owner-task retains exact task-id branch even when intercom-sender could replace it',t=>{
  const f=launchFixture(t);const task=writeTask(f.paths,{taskId:targetId(902),runtime:'codex',sessionId:TARGET_OWNER,name:'owner',cwd:fs.realpathSync.native(f.root),permissionMode:'default',state:'done',startedAt:new Date(TARGET_T).toISOString(),updatedAt:new Date(TARGET_T).toISOString(),deadline:new Date(TARGET_T+1000).toISOString(),local:'intercom',requestedBy:`${f.rows[0].from.nodeId}/${f.rows[0].from.session}`});
  const row={...f.rows[0],taskId:task.taskId};const witness=captureOwnerGrant(task,row)!;assert.deepEqual(checkMemberGrantsCurrent(f.paths,f.setup.deps.policy,f.target,[row],[witness],TARGET_T),[]);
  assert.equal(checkMemberGrantsCurrent(f.paths,f.setup.deps.policy,f.target,[{...row,taskId:undefined}],[witness],TARGET_T),null);
});
test('original sent timestamps and complete request identity stay immutable; pure bounds preserve equality and reject future/invalid times',t=>{
  const {paths}=setup(t),policy={version:1 as const,allowedCommands:[],wake:{enabled:true as const,sessions:[],replies:true}};sentOriginal(paths);dispatchedRequest(paths);
  const row=storeMessage(paths.inbox,{messageId:id(1),from:{nodeId:PEER,session:'build'},toSession:SELF,text:'public',inReplyTo:ORIGINAL,taskId:REQUESTED_TASK,createdAt:new Date(T0).toISOString()},T0);
  const reply=captureUnlistedGrant(paths,policy,[SELF],undefined,row,T0)!;assert.equal(reply.kind,'reply');
  writeJsonAtomic(path.join(paths.sent,`${ORIGINAL}.json`),{...getSent(paths,ORIGINAL),createdAt:new Date(T0-1000).toISOString()});assert.equal(checkMemberGrantsCurrent(paths,policy,{runtime:'claude-code',sessionId:SELF},[row],[reply],T0),null);
  const request=captureUnlistedGrant(paths,policy,[SELF],undefined,{...row,inReplyTo:undefined},T0)!;
  dispatchedRequest(paths,{requestId:id(0x999)});assert.equal(checkMemberGrantsCurrent(paths,policy,{runtime:'claude-code',sessionId:SELF},[{...row,inReplyTo:undefined}],[request],T0),null);
  assert.equal(grantTimesValid([T0-AGE],T0),true);assert.equal(grantTimesValid([T0-AGE],T0+1),false);assert.equal(grantTimesValid([T0+1],T0),false);assert.equal(grantTimesValid([NaN],T0),false);
});
