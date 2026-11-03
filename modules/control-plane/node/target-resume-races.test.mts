import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {successorNode} from './target-resume-fixture.mts';
import {deliver,missListings,SESSION} from './closed-fixture.mts';
import {deliverToClosed} from './closed-delivery.mts';
import {advanceTargetResume} from './target-resume.mts';
import {getMessage} from './inbox.mts';
import {withRoute} from './target-delivery-route.mts';
import {killSwitch} from './wake-hook.mts';
test('coalesced due rounds hold one successor and preserve oldest complete group',async t=>{
 const n=successorNode(t),a=deliver(n),b=deliver(n);await deliverToClosed(n.deps());const h=getMessage(n.paths.inbox,a)!.targetAttempt!,budget=withRoute(n.paths,h,s=>s.budget);
 n.tick(599999);assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'queued-awaiting-original');assert.equal(n.control.effects,0);
 n.tick(1);missListings(n,3,n.deps().now!());const results=await Promise.all(Array.from({length:8},()=>advanceTargetResume(n.deps(),SESSION)));
 assert.ok(results.every(r=>r.status==='resumed-original-awaiting-completion'));assert.equal(n.control.effects,1);assert.equal(n.queues.length,1);assert.deepEqual(withRoute(n.paths,h,s=>s.budget),budget);assert.deepEqual(getMessage(n.paths.inbox,b)!.targetAttempt,h);
});
for(const fault of ['lease','deadline','kill'] as const)test('actual input guard fences '+fault+' after await without retry',async t=>{
 const n=successorNode(t),id=deliver(n);await deliverToClosed(n.deps());const h=getMessage(n.paths.inbox,id)!.targetAttempt!,budget=withRoute(n.paths,h,s=>s.budget);
 n.tick(600000);missListings(n,3,n.deps().now!());n.control.beforeInput=async()=>{await Promise.resolve();if(fault==='lease')n.control.active=false;if(fault==='deadline'){n.tick(86400000);missListings(n,3,n.deps().now!());}if(fault==='kill')fs.writeFileSync(killSwitch(n.paths),'');};
 assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'unknown-fenced');assert.equal(n.control.effects,1);assert.equal(n.control.inputs.length,0);await advanceTargetResume(n.deps(),SESSION);assert.equal(n.control.effects,1);assert.deepEqual(withRoute(n.paths,h,s=>s.budget),budget);
});

for(const runtime of ['codex','claude-code'] as const)for(const platform of ['darwin','win32'] as const)test('source-shaped '+runtime+' '+platform+' keeps full original background identity and local input',async t=>{
 const n=successorNode(t,runtime,platform),id=deliver(n,{text:'LOCAL-BODY-SENTINEL'});await deliverToClosed(n.deps());if(runtime==='codex'){n.tick(600000);missListings(n,3,n.deps().now!());assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');}
 assert.equal(n.control.effects,1);assert.equal(n.control.result?.runtime,runtime);assert.equal(n.control.result?.sessionId,SESSION);assert.equal(n.control.result?.background,true);assert.equal(n.control.result?.originalChat,true);assert.ok(n.control.inputs[0].includes('LOCAL-BODY-SENTINEL'));assert.equal(JSON.stringify(n.control.context?.launch).includes('LOCAL-BODY-SENTINEL'),false);assert.equal(n.queues.length,runtime==='codex'?1:0);assert.equal(n.calls.length,0);assert.ok(withRoute(n.paths,getMessage(n.paths.inbox,id)!.targetAttempt!,s=>s.budget));
});

test('revoking resumeTarget cannot substitute resumeClosed or a listed grant at successor admission',async t=>{
 const n=successorNode(t),id=deliver(n);await deliverToClosed(n.deps());const h=getMessage(n.paths.inbox,id)!.targetAttempt!,budget=withRoute(n.paths,h,s=>s.budget);n.tick(600000);missListings(n,3,n.deps().now!());
 const policy=JSON.parse(fs.readFileSync(n.paths.policy,'utf8'));policy.messaging.resumeTarget=false;fs.writeFileSync(n.paths.policy,JSON.stringify(policy));assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'unknown-fenced');assert.equal(n.control.effects,0);assert.equal(n.queues.length,1);assert.deepEqual(withRoute(n.paths,h,s=>s.budget),budget);
});

test('unknown native exclusion remains fenced across rounds without any retry effect',async t=>{
 const n=successorNode(t),prepare=n.deps().targetResumePort.prepare.bind(n.deps().targetResumePort);let inspections=0;const port:import('./target-resume-port.mts').TargetResumePort={async prepare(target){const p=await prepare(target);if(p.status!=='prepared')return p;return {...p,async withRetiredPointerFence(){inspections++;return {status:'unknown'};}};}};
 deliver(n);await deliverToClosed({...n.deps(),targetResumePort:port});n.tick(600000);missListings(n,3,n.deps().now!());assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'unknown-fenced');assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'unknown-fenced');assert.equal(inspections,1);assert.equal(n.control.effects,0);assert.equal(n.queues.length,1);
});
