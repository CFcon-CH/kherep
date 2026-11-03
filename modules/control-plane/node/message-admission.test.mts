import {captureListedGrant} from './message-grant.mts';
// Synthetic state and process-local Authority only; no native calls or profiles.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {targetFixture,TARGET_OWNER,TARGET_T,TARGET_LIMITS} from './target-delivery-fixture.mts';
import {syntheticLaunchFacts} from './target-delivery-test-support.mts';
import {buildMessageLaunch} from './target-delivery-launch.mts';
import {claimRouteContext,beginRouteEffect,checkExecution} from './target-delivery-route.mts';
import {finishRouteEffect,transitionRouteMessages} from './target-delivery-outcome.mts';
import {checkMessageEffect,bindMessageAdmission} from './message-admission.mts';
import {faultAuthority,revokeAuthority,stopAuthority} from './session-authority.mts';
import {publishSynthetic,fixtureEvidence} from './session-authority-fixture.mts';
import {writeJsonAtomic} from './inbox.mts';

export function admissionFixture(t:test.TestContext,count=2) {
  const f=targetFixture(t,count),bin=path.join(f.root,'generated-command');fs.writeFileSync(bin,'public fixture');
  let clock=TARGET_T;
  const launch=buildMessageLaunch({codex:{home:f.root,findCodex:()=>bin}},{runtime:'codex',args:['exec'],cwd:fs.realpathSync.native(f.root)});
  const rows=f.rows.map((r,i)=>({...r,senderOrigin:{...r.senderOrigin!,sentAt:new Date(TARGET_T-86400000+1000+i*100).toISOString()}}));
  for(const row of rows)writeJsonAtomic(path.join(f.paths.inbox,`${row.messageId}.json`),row);
  const setup=syntheticLaunchFacts(f.paths,TARGET_OWNER,launch,{taskId:null,sessionId:TARGET_OWNER},()=>clock,{route:'task-wake',grant:'listed',permissionMode:'default'});
  const raw=claimRouteContext(f.paths,rows,{version:1,kind:'exec-resume',producer:launch.producer,budgetOwner:TARGET_OWNER,
    execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},setup.facts,clock,TARGET_LIMITS)!;
  const context=setup.bind({...raw,launch});
  const publish=(generation=7)=>publishSynthetic(f.paths,[{...fixtureEvidence({runtime:'codex',sessionId:TARGET_OWNER},'idle-loaded',clock),
    lifecycle:{status:'value',value:{state:'restored',generation},source:'native-lifecycle',observedAt:clock,complete:true,reasonCode:'observed'}}],clock,
    [{runtime:'codex',sessionId:TARGET_OWNER,state:'idle-loaded'}],setup.deps.livenessAuthority);
  return {...f,rows,bin,launch,setup,context,publish,now:()=>clock,setClock:(v:number)=>{clock=v;},begin:()=>beginRouteEffect(f.paths,context,['exec-resume'])};
}
test('final clock uses every member and the frozen minimum; deadline-1 passes and equality refuses',t=>{
  const f=admissionFixture(t);f.begin();f.setClock(TARGET_T+999);assert.deepEqual(checkMessageEffect(f.setup.deps,f.context,'outer-spawn'),{ok:true});
  f.setClock(TARGET_T+1000);assert.deepEqual(checkMessageEffect(f.setup.deps,f.context,'outer-spawn'),{ok:false,code:'deadline'});
  assert.equal(checkExecution(f.paths,f.context,['exec-resume'])!.group.binding.members.length,2);
});
for(const [name,action] of Object.entries({revoked:revokeAuthority,faulted:faultAuthority,stopped:stopAuthority}))test(`current ${name} Authority refuses without releasing owner or debit`,t=>{
  const f=admissionFixture(t);f.begin();action(f.setup.deps.livenessAuthority);assert.equal(checkMessageEffect(f.setup.deps,f.context,'outer-spawn').ok,false);
  assert.ok(fs.existsSync(f.reservation));assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
});
test('same lifecycle fresh publication is accepted; changed lifecycle refuses',t=>{
  const f=admissionFixture(t);f.begin();f.publish();assert.deepEqual(checkMessageEffect(f.setup.deps,f.context,'outer-spawn'),{ok:true});
  f.publish(8);assert.deepEqual(checkMessageEffect(f.setup.deps,f.context,'outer-spawn'),{ok:false,code:'lifecycle-changed'});
});
for(const mutation of ['policy','unreadable','killswitch','producer','origin','member','offer'] as const)test(`final current ${mutation} drift refuses`,t=>{
  const f=admissionFixture(t);f.begin();
  if(mutation==='policy'){const policy=JSON.parse(fs.readFileSync(f.paths.policy,'utf8'));policy.wake.sessions=[];fs.writeFileSync(f.paths.policy,JSON.stringify(policy));}
  if(mutation==='unreadable')fs.writeFileSync(f.paths.policy,'{');
  if(mutation==='killswitch')fs.writeFileSync(path.join(f.paths.dir,'wake.disabled'),'');
  if(mutation==='producer')fs.appendFileSync(f.bin,' drift');
  if(['origin','member','offer'].includes(mutation)){const row={...f.rows[0],...(mutation==='origin'?{senderOrigin:undefined}:mutation==='member'?{text:'drift'}:{offers:42})};writeJsonAtomic(path.join(f.paths.inbox,`${row.messageId}.json`),row);}
  assert.equal(checkMessageEffect(f.setup.deps,f.context,'outer-spawn').ok,false);
});
test('exact journaled offer is accepted; late outcome and ACK-like settlement require no new Authority',t=>{
  const f=admissionFixture(t);
  transitionRouteMessages(f.paths,f.context,r=>({...r,state:'offered',offers:1,offeredAt:new Date(TARGET_T).toISOString(),offeredBy:'intercom'}));
  f.begin();assert.deepEqual(checkMessageEffect(f.setup.deps,f.context,'outer-spawn'),{ok:true});
  f.setClock(TARGET_T+1001);stopAuthority(f.setup.deps.livenessAuthority);
  finishRouteEffect(f.paths,f.context,{kind:'exec',pid:42001,pidStart:'generated',threadId:TARGET_OWNER});
  transitionRouteMessages(f.paths,f.context,r=>({...r,state:'delivered'}));
  assert.equal(checkExecution(f.paths,f.context,['exec-resume'])!.phase,'settled');
  assert.equal(checkMessageEffect(f.setup.deps,f.context,'outer-spawn').ok,false);
});
test('serialized context and disk publication supply no current-run Authority; operator/read-only classifications stay explicit',t=>{
  const f=admissionFixture(t);f.begin();
  assert.deepEqual(checkMessageEffect(f.setup.deps,JSON.parse(JSON.stringify(f.context)),'outer-spawn'),{ok:false,code:'context-unavailable'});
  const rebound=bindMessageAdmission({...f.setup.deps,livenessAuthority:undefined},f.context,{route:'task-wake',grant:'members',memberGrants:f.rows.map(r=>({...captureListedGrant(f.setup.deps.policy,{runtime:'codex',sessionId:TARGET_OWNER})!,messageId:r.messageId}))});
  assert.equal(checkMessageEffect(f.setup.deps,rebound,'outer-spawn').ok,false);
  assert.deepEqual(checkMessageEffect(f.setup.deps,{kind:'operator'},'outer-spawn'),{ok:true});
  assert.deepEqual(checkMessageEffect(f.setup.deps,{kind:'read-only'},'outer-spawn'),{ok:true});
});
