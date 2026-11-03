import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {successorNode} from './target-resume-fixture.mts';
import {deliver,missListings,SESSION} from './closed-fixture.mts';
import {deliverToClosed} from './closed-delivery.mts';
import {advanceTargetResume} from './target-resume.mts';
import {deliverForHook} from './deliver-hook.mts';
import {getMessage} from './inbox.mts';
import {locateInboxRecord,encodeInboxRecord} from './inbox-storage.mts';
import {runMsg} from './msg-cli.mts';
import {recordCodexSession} from './codex-sessions.mts';
import {withRoute,routeSnapshot,routeHistory} from './target-delivery-route.mts';
import {budgetFile} from './budget-store.mts';
import {acknowledgeCodexOffer} from './codex-inbox-ack.mts';
import {resolveTargetAddress,assertTargetAddresses} from './target-resume-address.mts';
import {transitionRouteMessages} from './target-delivery-outcome.mts';
import {releaseNativeOwner} from './codex-native-pending.mts';

async function input(t:test.TestContext,runtime:'codex'|'claude-code',named=false,source:'known'|'task'='known'){
 const n=successorNode(t,runtime),name='unique-original-name';
 if(named&&source==='known'){const file=path.join(n.paths.dir,'known-sessions.json'),known=JSON.parse(fs.readFileSync(file,'utf8'));known.sessions.find((r:{sessionId:string})=>r.sessionId===SESSION).name=name;fs.writeFileSync(file,JSON.stringify(known));}
 if(named&&source==='task'){fs.mkdirSync(n.paths.tasks,{recursive:true});const taskId='aaaa0000-0000-4000-8000-000000000706';fs.writeFileSync(path.join(n.paths.tasks,taskId+'.json'),JSON.stringify({taskId,name,sessionId:SESSION,runtime:runtime==='codex'?'codex':'claude',cwd:path.join(n.workspace,'repo'),permissionMode:'auto',state:'done'}));}
 const id=deliver(n,{toSession:named?name:SESSION,text:'COMPLETE-EXPLICIT-ACK-MEMBER'});
 await deliverToClosed(n.deps());
 if(runtime==='codex'){n.tick(600000);missListings(n,3,n.deps().now!());await advanceTargetResume(n.deps(),SESSION);}
 assert.equal(n.control.effects,1);assert.equal(n.control.inputs.length,1);
 const command=n.control.inputs[0].match(/msg inbox --ack ([0-9a-f-]{36}) --from ([0-9a-f-]{36})/);assert.ok(command);
 assert.equal(command[2],SESSION);assert.ok(n.control.inputs[0].includes('COMPLETE-EXPLICIT-ACK-MEMBER'));
 const handle=getMessage(n.paths.inbox,id)!.targetAttempt!,budget=fs.readFileSync(budgetFile(n.paths,SESSION));
 const ack=async()=>{if(runtime==='codex')recordCodexSession(n.paths,SESSION,n.workspace,n.deps().now!(),'auto','SessionStart');return runMsg(['inbox','--ack',command[1],'--from',SESSION],{paths:n.paths,env:runtime==='codex'?{CODEX_THREAD_ID:SESSION}:{CLAUDE_CODE_SESSION_ID:SESSION},now:n.deps().now,out:()=>{},err:()=>{},processTable:()=>null});};
 return {...n,id,handle,budget,ack,address:named?name:SESSION,token:command[1]};
}
for(const runtime of ['codex','claude-code'] as const)for(const named of [false,true])test(`explicit original ACK preserves ${runtime} ${named?'name':'full-id'} address and exact membership`,async t=>{
 const n=await input(t,runtime,named),row=getMessage(n.paths.inbox,n.id)!;
 assert.equal(row.toSession,n.address);const processing=withRoute(n.paths,n.handle,s=>s.processing)!;assert.equal(processing.version,1);assert.equal(processing.mode,'explicit-ack');assert.equal(processing.placement?.phase,'committed');assert.deepEqual(processing.placement?.members.map(m=>m.messageId),[n.id]);
 const receipt=JSON.parse(fs.readFileSync(path.join(n.paths.inbox,'codex-offers',n.token+'.json'),'utf8'));assert.equal(receipt.version,2);assert.deepEqual(receipt.handle,n.handle);
 assert.equal(await n.ack(),0);assert.equal(await n.ack(),0);assert.equal(getMessage(n.paths.inbox,n.id)?.state,'delivered');
 assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');
 n.control.completed=true;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'completed-original');
 assert.equal(n.control.effects,1);assert.deepEqual(fs.readFileSync(budgetFile(n.paths,SESSION)),n.budget);
});
for(const runtime of ['codex','claude-code'] as const)test(`actual unique task name routes and ACKs ${runtime}`,async t=>{
 const n=await input(t,runtime,true,'task');assert.equal(await n.ack(),0);n.control.completed=true;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'completed-original');assert.equal(getMessage(n.paths.inbox,n.id)?.toSession,n.address);
});
for(const completion of [false,true])test(`real Claude Stop and StopFailure cannot settle explicit input; native=${completion}`,async t=>{
 const n=await input(t,'claude-code'),before=fs.readFileSync(locateInboxRecord(n.paths.inbox,n.id)!.file);
 for(const event of ['Stop','StopFailure','UserPromptSubmit','Stop'])deliverForHook({hook_event_name:event,session_id:SESSION,permission_mode:'auto'},{paths:n.paths,now:n.deps().now});
 assert.deepEqual(fs.readFileSync(locateInboxRecord(n.paths.inbox,n.id)!.file),before);
 n.control.completed=completion;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');
 assert.equal(getMessage(n.paths.inbox,n.id)?.state,'offered');assert.equal(n.control.effects,1);
 assert.equal(await n.ack(),0);n.control.completed=true;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'completed-original');
});
for(const fault of ['missing-runtime','wrong-runtime','wrong-cli-runtime'] as const)test(`v2 processing receipt rejects ${fault} without mutation`,async t=>{
 const n=await input(t,'claude-code'),file=locateInboxRecord(n.paths.inbox,n.id)!.file;
 const before=[fs.readFileSync(file),withRoute(n.paths,n.handle,s=>JSON.stringify(s))];
 if(fault==='wrong-cli-runtime'){
  recordCodexSession(n.paths,SESSION,n.workspace,n.deps().now!(),'auto','SessionStart');
  assert.equal(await runMsg(['inbox','--ack',n.token,'--from',SESSION],{paths:n.paths,env:{CODEX_THREAD_ID:SESSION},now:n.deps().now,out:()=>{},err:()=>{},processTable:()=>null}),1);
 }else assert.throws(()=>acknowledgeCodexOffer(n.paths,SESSION,n.token,[SESSION],fault==='wrong-runtime'?'codex':undefined));
 assert.deepEqual(fs.readFileSync(file),before[0]);assert.equal(withRoute(n.paths,n.handle,s=>JSON.stringify(s)),before[1]);
});
for(const fault of ['owner','handle','generation','fingerprint','address','subset','version-one','stale-token'] as const)test(`exact v2 actual CLI refuses ${fault} without ACK journal mutation`,async t=>{
 const n=await input(t,'claude-code'),file=path.join(n.paths.inbox,'codex-offers',n.token+'.json'),r=JSON.parse(fs.readFileSync(file,'utf8'));
 const other='aaaa0000-0000-4000-8000-000000000999';
 if(fault==='owner')r.owner=other;if(fault==='handle')r.handle.attemptToken=other;
 if(fault==='generation')r.entries[0].generation=other;if(fault==='fingerprint')r.entries[0].fingerprint='f'.repeat(64);
 if(fault==='address')r.entries[0].address='other-name';if(fault==='subset')r.entries=[];
 if(fault==='version-one'){r.version=1;delete r.handle;for(const e of r.entries)delete e.address;}
 fs.writeFileSync(file,JSON.stringify(r));const before=withRoute(n.paths,n.handle,s=>JSON.stringify(s)),body=fs.readFileSync(locateInboxRecord(n.paths.inbox,n.id)!.file);
 const result=fault==='stale-token'?await runMsg(['inbox','--ack',other,'--from',SESSION],{paths:n.paths,env:{CLAUDE_CODE_SESSION_ID:SESSION},now:n.deps().now,out:()=>{},err:()=>{},processTable:()=>null}):await n.ack();
 assert.equal(result,1);assert.equal(withRoute(n.paths,n.handle,s=>JSON.stringify(s)),before);assert.deepEqual(fs.readFileSync(locateInboxRecord(n.paths.inbox,n.id)!.file),body);
});
test('marked generic delivered retry and reoffer writers cannot settle or change an offer',async t=>{
 const n=await input(t,'claude-code'),before=withRoute(n.paths,n.handle,s=>JSON.stringify(s));
 for(const change of [(r:import('./inbox.mts').InboxRecord)=>({...r,state:'delivered' as const}),(r:import('./inbox.mts').InboxRecord)=>({...r,retry:true}),(r:import('./inbox.mts').InboxRecord)=>({...r,offers:10}),(r:import('./inbox.mts').InboxRecord)=>({...r,toSession:'new-owner'})])assert.throws(()=>transitionRouteMessages(n.paths,{kind:'message',handle:n.handle},change));
 assert.throws(()=>withRoute(n.paths,n.handle,(s,save)=>{const {processing:_mode,...without}=s;save(without);}));
 assert.throws(()=>releaseNativeOwner(n.paths,SESSION,[n.id]));assert.equal(withRoute(n.paths,n.handle,s=>JSON.stringify(s)),before);
});
test('an ordinary route save cannot manufacture ACK evidence',async t=>{
 const n=await input(t,'claude-code'),row=getMessage(n.paths.inbox,n.id)!,before=withRoute(n.paths,n.handle,s=>JSON.stringify(s));
 const ack={version:1 as const,token:n.token,owner:SESSION,generation:row.codexOffer!.generation,fingerprint:row.codexOffer!.fingerprint};
 assert.throws(()=>withRoute(n.paths,n.handle,(s,save)=>save({...s,transitions:[...s.transitions,{messageId:n.id,before:routeSnapshot(row),after:routeSnapshot({...row,state:'delivered'}),patch:{set:{state:'delivered'},unset:[]},applied:false,ack}]})));
 assert.equal(withRoute(n.paths,n.handle,s=>JSON.stringify(s)),before);
});
test('delivered state with an untagged journal never becomes an ACK or retirement proof',async t=>{
 const n=await input(t,'claude-code'),row=getMessage(n.paths.inbox,n.id)!,after={...row,state:'delivered' as const};
 const s=withRoute(n.paths,n.handle,s=>s),changed={...s,transitions:[...s.transitions,{messageId:n.id,before:routeSnapshot(row),after:routeSnapshot(after),patch:{set:{state:'delivered'},unset:[]},applied:true}]};
 fs.writeFileSync(locateInboxRecord(n.paths.inbox,n.id)!.file,JSON.stringify(encodeInboxRecord(locateInboxRecord(n.paths.inbox,n.id)!.file,after)));
 for(const file of new Set([path.join(n.paths.dir,'codex-native-pending',SESSION+'.json'),routeHistory(n.paths,n.handle)]))fs.writeFileSync(file,JSON.stringify(changed));
 assert.equal(await n.ack(),1);n.control.completed=true;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');
 assert.ok(withRoute(n.paths,n.handle,s=>s));assert.equal(n.control.effects,1);
});
test('ACK and completion use admitted membership after a mutable name changes owner',async t=>{
 const n=await input(t,'claude-code',true),file=path.join(n.paths.dir,'known-sessions.json'),known=JSON.parse(fs.readFileSync(file,'utf8'));
 known.sessions[0].sessionId=OTHER;fs.writeFileSync(file,JSON.stringify(known));assert.equal(await n.ack(),0);
 n.control.completed=true;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'completed-original');assert.equal(getMessage(n.paths.inbox,n.id)?.toSession,n.address);
});
for(const stage of ['intent','row-written','history-conflict'] as const)test(`actual ACK journal crash ${stage} replays or stays fenced without another effect`,async t=>{
 const n=await input(t,'claude-code'),rename=fs.renameSync;let failed=false;
 const owner=path.join(n.paths.dir,'codex-native-pending',SESSION+'.json'),body=locateInboxRecord(n.paths.inbox,n.id)!.file;
 t.mock.method(fs,'renameSync',((a:fs.PathLike,b:fs.PathLike)=>{
  if(!failed){const destination=String(b);let crash=stage==='intent'&&destination===body;
   if(stage!=='intent'&&destination.endsWith('.json')&&(destination===owner||destination.endsWith('.route.json'))){const value=JSON.parse(fs.readFileSync(a,'utf8'));crash=!!value.transitions?.some((x:{ack?:unknown;applied?:boolean})=>x.ack&&x.applied===true)&&(stage==='row-written'?destination===owner:destination.endsWith('.route.json'));}
   if(crash){failed=true;throw Error('synthetic ACK persistence crash');}}
  return rename(a,b);
 }) as typeof fs.renameSync);
 assert.equal(await n.ack(),1);t.mock.restoreAll();assert.equal(failed,true);
 if(stage==='history-conflict'){assert.equal(await n.ack(),1);n.control.completed=true;assert.notEqual((await advanceTargetResume(n.deps(),SESSION)).status,'completed-original');}
 else {assert.equal(await n.ack(),0);assert.equal(await n.ack(),0);assert.equal(withRoute(n.paths,n.handle,s=>s.transitions.filter(t=>t.ack).length),1);}
 assert.equal(n.control.effects,1);assert.deepEqual(fs.readFileSync(budgetFile(n.paths,SESSION)),n.budget);
});

const OTHER='aaaa0000-0000-4000-8000-000000000999';
function namedNode(t:test.TestContext,runtime:'codex'|'claude-code'='claude-code'){
 const n=successorNode(t,runtime),file=path.join(n.paths.dir,'known-sessions.json'),known=JSON.parse(fs.readFileSync(file,'utf8'));
 known.sessions[0].name='current-name';fs.writeFileSync(file,JSON.stringify(known));
 return {...n,knownFile:file,reassign(){known.sessions[0].sessionId=OTHER;fs.writeFileSync(file,JSON.stringify(known));}};
}
for(const fault of ['known-conflict','task-conflict','listing-conflict','malformed-task','task-symlink','known-container','listing-container','partial','generation','stale','capped'] as const)test(`strict current name population refuses ${fault} before claim`,async t=>{
 const n=namedNode(t),listing=JSON.parse(fs.readFileSync(n.paths.sessions,'utf8')),known=JSON.parse(fs.readFileSync(n.knownFile,'utf8'));
 if(fault==='known-conflict')known.sessions.push({...known.sessions[0],sessionId:OTHER});
 if(fault==='listing-conflict')listing.sessions.push({runtime:'claude-code',sessionId:OTHER,name:'current-name'});
 if(fault.startsWith('task-')||fault==='malformed-task'){fs.mkdirSync(n.paths.tasks,{recursive:true});const f=path.join(n.paths.tasks,OTHER+'.json');if(fault==='task-symlink')fs.symlinkSync(n.knownFile,f);else fs.writeFileSync(f,fault==='malformed-task'?'{':JSON.stringify({taskId:OTHER,name:'current-name',runtime:'claude',sessionId:OTHER}));}
 if(fault==='known-container')known.sessions=null;if(fault==='listing-container')listing.sessions=null;
 if(fault==='partial')listing.unseen=['claude-code'];if(fault==='generation')listing.generation++;if(fault==='stale')listing.updatedAt=new Date(n.deps().now!()-180001).toISOString();
 if(fault==='capped')known.sessions=Array.from({length:512},()=>known.sessions[0]);
 fs.writeFileSync(n.knownFile,JSON.stringify(known));fs.writeFileSync(n.paths.sessions,JSON.stringify(listing));
 assert.throws(()=>resolveTargetAddress(n.paths,'current-name',n.deps().now!()));deliver(n,{toSession:'current-name'});await deliverToClosed(n.deps());
 assert.equal(n.control.effects,0);assert.equal(n.queues.length,0);assert.equal(fs.existsSync(budgetFile(n.paths,SESSION)),false);
});
test('duplicate same-owner name evidence is usable and full IDs do not depend on a listing',t=>{
 const n=namedNode(t),known=JSON.parse(fs.readFileSync(n.knownFile,'utf8'));known.sessions.push({...known.sessions[0]});fs.writeFileSync(n.knownFile,JSON.stringify(known));
 assert.deepEqual(resolveTargetAddress(n.paths,'current-name',n.deps().now!()),{sessionId:SESSION,runtime:'claude-code'});
 fs.unlinkSync(n.knownFile);fs.unlinkSync(n.paths.sessions);assert.doesNotThrow(()=>assertTargetAddresses(n.paths,[{toSession:SESSION}],{sessionId:SESSION,runtime:'claude-code'},n.deps().now!()));
});
for(const runtime of ['codex','claude-code'] as const)test(`name reassigned during ${runtime} preparation refuses without claim or native effect`,async t=>{
 const n=namedNode(t,runtime),prepare=n.deps().targetResumePort.prepare.bind(n.deps().targetResumePort);
 const deps={...n.deps(),targetResumePort:{async prepare(target:Parameters<typeof prepare>[0]){const result=await prepare(target);n.reassign();return result;}}};
 deliver(n,{toSession:'current-name'});await deliverToClosed(deps);assert.equal(n.control.effects,0);assert.equal(n.queues.length,0);assert.equal(fs.existsSync(budgetFile(n.paths,SESSION)),false);
});
for(const boundary of ['queue-spawn','outer-spawn','prompt-release'] as const)test(`current name reassignment at ${boundary} prevents the subsequent effect and retry`,async t=>{
 const runtime=boundary==='queue-spawn'?'codex':'claude-code',n=namedNode(t,runtime),prepare=n.deps().targetResumePort.prepare.bind(n.deps().targetResumePort);
 const port={async prepare(target:Parameters<typeof prepare>[0]){const p=await prepare(target);if(p.status!=='prepared')return p;return {...p,async queue(...args:Parameters<typeof p.queue>){n.reassign();return p.queue(...args);},async resume(context:import('./target-resume-port.mts').OriginalMessageContext,text:string,guards:import('./target-resume-port.mts').OriginalResumeGuards){if(boundary==='outer-spawn')n.reassign();else n.control.beforeInput=async()=>n.reassign();return p.resume!(context,text,guards);}};}};
 deliver(n,{toSession:'current-name'});const deps={...n.deps(),targetResumePort:port};await deliverToClosed(deps);
 assert.equal(n.queues.length,0);assert.equal(n.control.inputs.length,0);assert.equal(n.control.effects,boundary==='prompt-release'?1:0);
 await advanceTargetResume(deps,SESSION);assert.equal(n.control.inputs.length,0);assert.equal(n.control.effects,boundary==='prompt-release'?1:0);
});
for(const boundary of ['beforeInnerSpawn','beforeInnerInput'] as const)test(`Windows-shaped ${boundary} rechecks the current name before release`,async t=>{
 const n=successorNode(t,'claude-code','win32'),file=path.join(n.paths.dir,'known-sessions.json'),known=JSON.parse(fs.readFileSync(file,'utf8'));
 known.sessions[0].name='current-name';fs.writeFileSync(file,JSON.stringify(known));
 const prepare=n.deps().targetResumePort.prepare.bind(n.deps().targetResumePort);
 const port={async prepare(target:Parameters<typeof prepare>[0]){const p=await prepare(target);if(p.status!=='prepared')return p;return {...p,async resume(context:import('./target-resume-port.mts').OriginalMessageContext,text:string,guards:import('./target-resume-port.mts').OriginalResumeGuards){const guard=guards[boundary];return p.resume!(context,text,{...guards,[boundary]:()=>{known.sessions[0].sessionId=OTHER;fs.writeFileSync(file,JSON.stringify(known));guard();}});}};}};
 deliver(n,{toSession:'current-name'});const deps={...n.deps(),targetResumePort:port};await deliverToClosed(deps);assert.equal(n.control.inputs.length,0);assert.equal(n.control.effects,1);
 await advanceTargetResume(deps,SESSION);assert.equal(n.control.effects,1);assert.equal(n.control.inputs.length,0);
});
