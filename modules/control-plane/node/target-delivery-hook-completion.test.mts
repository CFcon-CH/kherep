// Generated cooperative stores and synchronous fake completion fences; no vendor/native probes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {setup,SELF,T0,arrive,id} from './wake-fixture.mts';
import * as support from './target-delivery-test-support.mts';
import {captureListedGrant} from './message-grant.mts';
import {readPolicy} from './policy.mts';
import {getMessage,writeJsonAtomic} from './inbox.mts';
import {decideMessageRoute} from './target-delivery-producer.mts';
import {beginRouteEffect,routeHistory,withRoute} from './target-delivery-route.mts';
import {transitionRouteMessages,finishRouteEffect} from './target-delivery-outcome.mts';
import {withAdmittedHookEffect} from './message-admission.mts';
import {runHook} from './deliver-hook.mts';
import {publishSynthetic,fixtureEvidence} from './session-authority-fixture.mts';
import {withNativeOwnerRecords} from './codex-native-pending.mts';
import {revokeAuthority} from './session-authority.mts';
import {budgetFile} from './budget-store.mts';
const api=await import('./target-delivery-hook-completion.mts').catch(()=>({} as any));
function fixture(t:test.TestContext,processed=true,alias=false) {
 assert.equal(typeof api.retireCompletedHookRoute,'function');
 const consumer=alias?id(999):SELF;
 const {paths}=setup(t,{wake:{enabled:true,sessions:[SELF,consumer]}}),facts=support.syntheticHookFacts(paths,SELF,'claude-code',T0);
 if(alias)facts.livenessAuthority=publishSynthetic(paths,[SELF,consumer].map(sessionId=>({...fixtureEvidence({runtime:'claude-code',sessionId},sessionId===SELF?'running':'idle-loaded',T0),
  lifecycle:{status:'value',value:{state:'restored',generation:7},source:'native-lifecycle',observedAt:T0,complete:true,reasonCode:'observed'}})),T0,
  [SELF,consumer].map(sessionId=>({runtime:'claude-code',sessionId,state:sessionId===SELF?'running':'idle-loaded'})));
 arrive(paths,1,T0,consumer);arrive(paths,2,T0,consumer);
 const rows=[getMessage(paths.inbox,id(1))!,getMessage(paths.inbox,id(2))!],policy=readPolicy(paths.policy,true)!;
 const grant=captureListedGrant(policy,{runtime:'claude-code',sessionId:SELF})!;
 const deps={paths,...facts,policy,now:()=>T0+1000};
 const decision=decideMessageRoute({...deps,messageRoute:{route:'claude-wake',grant:'members' as const,
  memberGrants:rows.map(r=>({...grant,messageId:r.messageId})),permissionMode:'default'}},rows,SELF,'hook-continue',
  {runtime:'claude-code',sessionId:consumer,taskId:null},facts.messageProducer,consumer);
 assert.equal(decision.status,'granted');if(decision.status!=='granted'||decision.context.kind!=='message')throw Error('fixture admission');
 const context=decision.context;beginRouteEffect(paths,context,['hook-continue']);transitionRouteMessages(paths,context,row=>row);finishRouteEffect(paths,context,{kind:'hook',emitted:true});
 const completion=support.syntheticHookCompletion(paths);
 assert.deepEqual(withAdmittedHookEffect(deps,context,s=>{completion.register(s);}),{ok:true});
 const hook=(event:string)=>{const output:string[]=[];runHook(JSON.stringify({session_id:consumer,hook_event_name:event,permission_mode:'default'}),
  {paths,now:deps.now,replyCommand:'synthetic'},text=>output.push(text),()=>{throw Error('synthetic hook warning');});return output;};
 if(processed){assert.equal(hook('UserPromptSubmit').length,1);hook('Stop');assert.equal(completion.complete(),true);}
 const owner=path.join(paths.dir,'codex-native-pending',SELF+'.json'),receipt=path.join(paths.dir,'target-delivery-hook-completions',SELF,context.handle.groupId+'.json');
 const budget=fs.readFileSync(budgetFile(paths,consumer)),current=()=>JSON.parse(fs.readFileSync(owner,'utf8'));
 const retire=(provider=completion.provider,ctx:any=context)=>api.retireCompletedHookRoute(deps,ctx,provider);
 const recover=(provider=completion.restartQualified())=>api.recoverCommittedHookRetirement(paths,context.handle,provider);
 return {paths,facts,deps,context,completion,owner,receipt,budget,current,hook,retire,recover,budgetOwner:consumer,alias:alias?path.join(paths.dir,'codex-native-pending',consumer+'.json'):null};
}
test('fresh exact admitted completion retires once; recovery repeats debit-neutrally with new qualified fence',t=>{
 const f=fixture(t);assert.equal(f.retire().status,'retired');assert.equal(fs.existsSync(f.owner),false);
 assert.equal(f.recover().status,'already-retired');assert.deepEqual(fs.readFileSync(budgetFile(f.paths,SELF)),f.budget);
 assert.equal(f.recover(undefined as any).status,'already-retired');
});
for(const fault of ['missing-admission','copied-admission','revoked','producer','partial-processing','wrong-provider'] as const)
test(`fresh retirement refuses ${fault} without commit or owner unlink`,t=>{
 const f=fixture(t,fault!=='partial-processing');let ctx:any=f.context,provider:any=f.completion.provider;
 if(fault==='missing-admission')ctx={kind:'message',handle:f.context.handle};
 if(fault==='copied-admission')ctx=JSON.parse(JSON.stringify(f.context));
 if(fault==='revoked')revokeAuthority(f.facts.livenessAuthority);
 if(fault==='producer')fs.appendFileSync(f.facts.messageProducer.files[0].path,'// changed\n');
 if(fault==='wrong-provider')provider={withCompletedTurnFence:()=>({status:'retired'})};
 assert.notEqual(f.retire(provider,ctx).status,'retired');assert.equal(fs.existsSync(f.owner),true);assert.equal(fs.existsSync(f.receipt),false);
 assert.deepEqual(fs.readFileSync(budgetFile(f.paths,SELF)),f.budget);
});
for(const stage of ['before-prepared','partial-prepared','prepared-readback','after-prepared','before-commit-rename','after-commit-rename','commit-readback','before-unlink','after-alias-unlink','after-owner-unlink'] as const)
test(`crash ${stage}: only exact committed recovery may finish, never refund or repeat output`,t=>{
 const f=fixture(t,true,true),open=fs.openSync,write=fs.writeFileSync,rename=fs.renameSync,read=fs.readFileSync,unlink=fs.unlinkSync;
 let fired=false;const fail=()=>{fired=true;throw Error('synthetic crash');};let preparedFd:number|undefined;
 fs.openSync=((file:any,...args:any[])=>{
  const text=String(file);if(!fired&&stage==='before-prepared'&&text===f.receipt)return fail();
  if(!fired&&stage==='after-prepared'&&text.startsWith(path.dirname(f.receipt)+'/.'))return fail();
  const fd=(open as any)(file,...args);if(text===f.receipt)preparedFd=fd;return fd;
 }) as typeof open;
 fs.writeFileSync=((file:any,...args:any[])=>{if(!fired&&stage==='partial-prepared'&&file===preparedFd){(write as any)(file,'{');return fail();}return (write as any)(file,...args);}) as typeof write;
 fs.renameSync=((from:any,to:any)=>{
  if(String(to)===f.receipt&&!fired&&stage==='before-commit-rename')return fail();
  const result=rename(from,to);if(String(to)===f.receipt&&!fired&&stage==='after-commit-rename')return fail();return result;
 }) as typeof rename;
 fs.readFileSync=((file:any,...args:any[])=>{
  const result=(read as any)(file,...args);
  if(!fired&&stage==='prepared-readback'&&String(file)===f.receipt&&String(result).includes('"phase":"prepared"'))return fail();
  if(!fired&&stage==='commit-readback'&&String(file)===f.receipt&&String(result).includes('"phase":"committed"'))return fail();return result;
 }) as typeof read;
 fs.unlinkSync=((file:any)=>{if((String(file)===f.alias||String(file)===f.owner)&&!fired&&stage==='before-unlink')return fail();const result=unlink(file);if(String(file)===f.alias&&!fired&&stage==='after-alias-unlink')return fail();if(String(file)===f.owner&&!fired&&stage==='after-owner-unlink')return fail();return result;}) as typeof unlink;
 let result:any;try{result=f.retire();}finally{fs.openSync=open;fs.writeFileSync=write;fs.renameSync=rename;fs.readFileSync=read;fs.unlinkSync=unlink;}
 assert.equal(fired,true);assert.notEqual(result.status,'retired');
 const committed=['after-commit-rename','commit-readback','before-unlink','after-alias-unlink','after-owner-unlink'].includes(stage);
 const recovery=f.recover();assert.equal(['retired','already-retired'].includes(recovery.status),committed);
 assert.equal(fs.existsSync(f.owner),!committed);assert.equal(fs.existsSync(f.alias!),!committed);assert.deepEqual(fs.readFileSync(budgetFile(f.paths,f.budgetOwner)),f.budget);
});
for(const drift of ['expired-provider','missing-provider','wrong-turn','history','member','debit','owner','alias','receipt-extra','receipt-producer','receipt-lifecycle','receipt-members','receipt-transitions','receipt-debit','receipt-aliases','receipt-prepared','receipt-partial','receipt-oversize','receipt-link'] as const)
test(`committed recovery refuses ${drift} before any cleanup`,t=>{
 const f=fixture(t,true,drift==='alias'),unlink=fs.unlinkSync;fs.unlinkSync=((file:any)=>{if(String(file)===f.owner)throw Error('leave committed cleanup pending');return unlink(file);}) as typeof unlink;
 try{assert.notEqual(f.retire().status,'retired');}finally{fs.unlinkSync=unlink;}
 let provider:any=f.completion.restartQualified();
 if(drift==='expired-provider'){f.completion.expire();provider=f.completion.provider;}
 if(drift==='missing-provider')provider=undefined;
 if(drift==='wrong-turn'){const other=support.syntheticHookCompletion(f.paths);other.register(f.current());assert.equal(other.complete(),true);provider=other.provider;}
 if(drift==='alias')writeJsonAtomic(f.alias!,{version:4,owner:id(999),handle:{...f.context.handle,attemptToken:crypto.randomUUID()}});
 if(drift==='history'){const file=routeHistory(f.paths,f.context.handle),s=JSON.parse(fs.readFileSync(file,'utf8'));s.innerStarted=!s.innerStarted;writeJsonAtomic(file,s);}
 if(drift==='member'){const row=getMessage(f.paths.inbox,id(1))!;writeJsonAtomic(path.join(f.paths.inbox,row.messageId+'.json'),{...row,text:'changed'});}
 if(drift==='debit')writeJsonAtomic(budgetFile(f.paths,SELF),{});
 if(drift==='owner'){const s=f.current();s.handle.attemptToken=crypto.randomUUID();writeJsonAtomic(f.owner,s);}
 if(drift.startsWith('receipt-')){
  const saved=JSON.parse(fs.readFileSync(f.receipt,'utf8'));
  if(drift==='receipt-extra')writeJsonAtomic(f.receipt,{...saved,extra:true});
  if(drift==='receipt-producer'){saved.completion.operation.producer.argsFingerprint='f'.repeat(64);writeJsonAtomic(f.receipt,saved);}
  if(drift==='receipt-lifecycle')writeJsonAtomic(f.receipt,{...saved,completion:{...saved.completion,lifecycleGeneration:saved.completion.lifecycleGeneration+1}});
  if(drift==='receipt-members')writeJsonAtomic(f.receipt,{...saved,membersFingerprint:'f'.repeat(64)});
  if(drift==='receipt-transitions')writeJsonAtomic(f.receipt,{...saved,transitionsFingerprint:'f'.repeat(64)});
  if(drift==='receipt-debit')writeJsonAtomic(f.receipt,{...saved,debit:{...saved.debit,budgetId:crypto.randomUUID()}});
  if(drift==='receipt-aliases')writeJsonAtomic(f.receipt,{...saved,aliases:[...saved.aliases,id(998)].sort()});
  if(drift==='receipt-prepared')writeJsonAtomic(f.receipt,{...saved,phase:'prepared'});
  if(drift==='receipt-partial')fs.writeFileSync(f.receipt,'{');
  if(drift==='receipt-oversize')fs.writeFileSync(f.receipt,' '.repeat(128*1024+1));
  if(drift==='receipt-link'){fs.unlinkSync(f.receipt);fs.symlinkSync(f.owner,f.receipt);}
 }
 const owner=fs.readFileSync(f.owner);const result=api.recoverCommittedHookRetirement(f.paths,f.context.handle,provider);
 assert.equal(['retired','already-retired'].includes(result.status),false);assert.deepEqual(fs.readFileSync(f.owner),owner);
});
test('revocation after committed output does not invent new output/admission or block exact structural recovery',t=>{
 const f=fixture(t),unlink=fs.unlinkSync;fs.unlinkSync=((file:any)=>{if(String(file)===f.owner)throw Error('pause');return unlink(file);}) as typeof unlink;
 try{f.retire();}finally{fs.unlinkSync=unlink;}revokeAuthority(f.facts.livenessAuthority);
 assert.equal(f.recover().status,'retired');assert.deepEqual(fs.readFileSync(budgetFile(f.paths,SELF)),f.budget);
});

test('commit and every unlink stay inside original owner locks, aliases disappear before original',t=>{
 const f=fixture(t,true,true),unlink=fs.unlinkSync,removed:string[]=[];
 fs.unlinkSync=((file:any)=>{
  if(String(file)===f.alias||String(file)===f.owner){
   assert.throws(()=>withNativeOwnerRecords(f.paths,[SELF],()=>{throw Error('unexpected competing acquisition');}),/held|busy|locked/);
   if(String(file)===f.owner)assert.equal(fs.existsSync(f.alias!),false);
   removed.push(String(file));
  }return unlink(file);
 }) as typeof unlink;
 try{assert.equal(f.retire().status,'retired');}finally{fs.unlinkSync=unlink;}
 assert.deepEqual(removed,[f.alias,f.owner]);assert.equal(f.recover().status,'already-retired');
});

for(const phase of ['prepared','committed'] as const)
test(`actual fresh Node process ${phase}: no original Admission; only exact decided cleanup under independently captured provider facts`,t=>{
 const f=fixture(t),s=f.current();let nativeFacts:any;
 f.completion.provider.withCompletedTurnFence({handle:s.handle,operation:s.consumer??s.group.operation,lifecycleGeneration:s.group.binding.lifecycleGeneration},turn=>{
  nativeFacts=structuredClone(turn);return {status:'refused'};
 });
 assert.ok(nativeFacts); // Captured from modeled native timeline BEFORE any retirement receipt exists.
 const rename=fs.renameSync,unlink=fs.unlinkSync;
 if(phase==='prepared')fs.renameSync=((from:any,to:any)=>{if(String(to)===f.receipt)throw Error('before commit');return rename(from,to);}) as typeof rename;
 else fs.unlinkSync=((file:any)=>{if(String(file)===f.owner)throw Error('after commit');return unlink(file);}) as typeof unlink;
 try{assert.notEqual(f.retire().status,'retired');}finally{fs.renameSync=rename;fs.unlinkSync=unlink;}
 const script=`
  import {canonical} from ${JSON.stringify(new URL('./target-delivery-state.mts',import.meta.url).href)};
  import {recoverCommittedHookRetirement,retireCompletedHookRoute} from ${JSON.stringify(new URL('./target-delivery-hook-completion.mts',import.meta.url).href)};
  const knownNativeFacts=${JSON.stringify(nativeFacts)},paths=${JSON.stringify(f.paths)},handle=${JSON.stringify(f.context.handle)};
  // New trusted synthetic composition from independently captured native facts, NOT the receipt.
  let held=false;
  const provider={withCompletedTurnFence(expected,consume){
   const basis=x=>({handle:x.handle,operation:x.operation,lifecycleGeneration:x.lifecycleGeneration});
   if(held||canonical(basis(expected))!==canonical(basis(knownNativeFacts))||('turnId' in expected&&canonical(expected)!==canonical(knownNativeFacts)))return {status:'refused'};
   held=true;try{return consume(structuredClone(knownNativeFacts));}finally{held=false;}
  }};
  const fresh=(${JSON.stringify(phase)}==='prepared')?retireCompletedHookRoute({paths},{kind:'message',handle,admission:{}},provider):null;
  const recovery=recoverCommittedHookRetirement(paths,handle,provider);
  console.log(JSON.stringify({fresh,recovery}));
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:f.paths.dir}});
 assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
 assert.equal(result.recovery.status,phase==='committed'?'retired':'refused');
 if(phase==='prepared')assert.equal(result.fresh.status,'refused');
 assert.equal(fs.existsSync(f.owner),phase==='prepared');assert.deepEqual(fs.readFileSync(budgetFile(f.paths,SELF)),f.budget);
});

test('production unavailable without a qualified provider; async and fabricated success are not capabilities',t=>{
 const f=fixture(t),before=fs.readFileSync(f.owner);let calls=0;
 assert.equal(api.retireCompletedHookRoute(f.deps,f.context,undefined).status,'unavailable');
 assert.equal(api.retireCompletedHookRoute(f.deps,f.context,{async withCompletedTurnFence(){calls++;return {status:'retired'};}}).status,'unavailable');
 assert.equal(calls,0);assert.deepEqual(fs.readFileSync(f.owner),before);assert.equal(fs.existsSync(f.receipt),false);
});
for(const corruption of ['namespace-link','namespace-capacity'] as const)
test(`bounded internal receipt namespace refuses ${corruption} without owner removal`,t=>{
 const f=fixture(t),namespace=path.join(f.paths.dir,'target-delivery-hook-completions'),dir=path.dirname(f.receipt);
 if(corruption==='namespace-link'){const other=path.join(f.paths.dir,'generated-other');fs.mkdirSync(other);fs.symlinkSync(other,namespace,'dir');}
 else {fs.mkdirSync(dir,{recursive:true});for(let n=0;n<1024;n++)fs.writeFileSync(path.join(dir,crypto.randomUUID()+'.json'),'{}');}
 const before=fs.readFileSync(f.owner);assert.notEqual(f.retire().status,'retired');assert.deepEqual(fs.readFileSync(f.owner),before);
});
