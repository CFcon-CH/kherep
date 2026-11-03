import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {successorNode} from './target-resume-fixture.mts';
import {deliver,missListings,SESSION} from './closed-fixture.mts';
import {deliverToClosed} from './closed-delivery.mts';
import {advanceTargetResume} from './target-resume.mts';
import {getMessage} from './inbox.mts';
import {acknowledgeCodexOffer} from './codex-inbox-ack.mts';
import {retireCompletedOriginalResult,recoverCommittedOriginalRetirement} from './target-resume-completion.mts';
import {withRoute} from './target-delivery-route.mts';
import {budgetFile} from './budget-store.mts';
async function ready(t:test.TestContext){const n=successorNode(t),ids=[deliver(n),deliver(n)];await deliverToClosed(n.deps());n.tick(600000);missListings(n,3,n.deps().now!());assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');const h=getMessage(n.paths.inbox,ids[0])!.targetAttempt!;return {...n,ids,h};}
function ack(n:Awaited<ReturnType<typeof ready>>){const command=n.control.inputs[0].match(/msg inbox --ack ([0-9a-f-]{36}) --from ([0-9a-f-]{36})/);assert.ok(command);assert.equal(command[2],SESSION);acknowledgeCodexOffer(n.paths,command[2],command[1],[SESSION],"codex");}
test('exact original result native completion and real complete ACK retire debit neutrally',async t=>{
 const n=await ready(t),budget=fs.readFileSync(budgetFile(n.paths,SESSION));n.control.completed=true;
 assert.notEqual(retireCompletedOriginalResult(n.deps(),n.control.result!).status,'retired');
 assert.equal(retireCompletedOriginalResult(n.deps(),{...n.control.result}).status,'refused');
 ack(n);assert.ok(n.ids.every(id=>getMessage(n.paths.inbox,id)?.state==='delivered'));
 assert.equal(retireCompletedOriginalResult(n.deps(),n.control.result!).status,'retired');assert.equal(fs.existsSync(path.join(n.paths.dir,'codex-native-pending',SESSION+'.json')),false);assert.deepEqual(fs.readFileSync(budgetFile(n.paths,SESSION)),budget);assert.equal(n.control.effects,1);
});
for(const stage of ['prepared','committed'] as const)test('original completion crash '+stage+' permits committed structural recovery only',async t=>{
 const n=await ready(t);ack(n);n.control.completed=true;const receipt=path.join(n.paths.dir,'target-delivery-original-completions',SESSION,n.h.groupId+'.json'),owner=path.join(n.paths.dir,'codex-native-pending',SESSION+'.json');
 const rename=fs.renameSync,unlink=fs.unlinkSync;if(stage==='prepared')fs.renameSync=((a:any,b:any)=>{if(String(b)===receipt)throw Error('synthetic crash');return rename(a,b);}) as typeof rename;else fs.unlinkSync=((f:any)=>{if(String(f)===owner)throw Error('synthetic crash');return unlink(f);}) as typeof unlink;
 try{assert.notEqual(retireCompletedOriginalResult(n.deps(),n.control.result!).status,'retired');}finally{fs.renameSync=rename;fs.unlinkSync=unlink;}
 const saved=JSON.parse(fs.readFileSync(receipt,'utf8')),provider={withCompletedTurnFence(want:any,consume:any){return consume(structuredClone(saved.completion));}};
 const result=recoverCommittedOriginalRetirement(n.paths,n.h,provider);assert.equal(['retired','already-retired'].includes(result.status),stage==='committed');assert.equal(n.control.effects,1);
});

import {publishSynthetic,fixtureEvidence} from './session-authority-fixture.mts';
test('timely original input permits late scheduling and running completion after SEND deadline',async t=>{
 const n=successorNode(t),ids=[deliver(n),deliver(n)];await deliverToClosed(n.deps());n.tick(600000);missListings(n,3,n.deps().now!());
 n.control.beforeInput=async()=>{await Promise.resolve();};assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');
 const h=getMessage(n.paths.inbox,ids[0])!.targetAttempt!,f={...n,ids,h};ack(f);n.tick(86400000);const now=n.deps().now!();publishSynthetic(n.paths,[{...fixtureEvidence({runtime:'codex',sessionId:SESSION},'running',now),lifecycle:{status:'value',value:{state:'restored',generation:7},source:'native-lifecycle',observedAt:now,complete:true,reasonCode:'observed'}}],now,[{runtime:'codex',sessionId:SESSION,state:'running'}],n.livenessAuthority);
 n.control.completed=true;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'completed-original');assert.equal(n.control.effects,1);assert.equal(n.queues.length,1);
});
test('exact native result survives one observation persistence failure without a replacement launch',async t=>{
 const n=successorNode(t),id=deliver(n);await deliverToClosed(n.deps());n.tick(600000);missListings(n,3,n.deps().now!());const h=getMessage(n.paths.inbox,id)!.targetAttempt!,rename=fs.renameSync;let failed=false;
 fs.renameSync=((a:any,b:any)=>{if(!failed&&String(b).endsWith(SESSION+'.json')){const saved=JSON.parse(fs.readFileSync(a,'utf8'));if(saved.originalResume?.phase==='observed'){failed=true;throw Error('synthetic persistence failure');}}return rename(a,b);}) as typeof rename;
 try{assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'unknown-fenced');}finally{fs.renameSync=rename;}
 assert.equal(failed,true);const original=n.control.result;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');assert.equal(n.control.result,original);assert.equal(n.control.effects,1);assert.equal(withRoute(n.paths,h,s=>s.originalResume?.phase),'observed');
});
