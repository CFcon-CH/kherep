import assert from 'node:assert/strict';
import test from 'node:test';
import {strictCodexNode} from './target-resume-fixture.mts';
import {deliver,missListings,SESSION} from './closed-fixture.mts';
import {deliverToClosed} from './closed-delivery.mts';
import {getMessage} from './inbox.mts';
import {withRoute} from './target-delivery-route.mts';
import {advanceTargetResume} from './target-resume.mts';
test('original caller reaches one live excluded successor with one retained debit',async t=>{
 const node=strictCodexNode(t),a=deliver(node),b=deliver(node);let effects=0;const prepare=node.port.prepare.bind(node.port);
 const port:import('./target-resume-port.mts').TargetResumePort={async prepare(){const p=await prepare();return {...p,
 async withRetiredPointerFence(expected,consume){return await consume({epoch:'aaaa0000-0000-4000-8000-000000000002',assertActive(){}});},
 async resume(context,input,guards){guards.beforeOuterSpawn();effects++;guards.beforePromptRelease();return {status:'observed',runtime:'codex',sessionId:SESSION,cwd:context.launch!.binding.cwd,permissionMode:'auto',turnId:'original-turn',providerEpoch:'aaaa0000-0000-4000-8000-000000000002',background:true,originalChat:true,pid:123,pidStart:null};}
 };}};
 const deps={...node.deps(),targetResumePort:port};await deliverToClosed(deps);
 const h=getMessage(node.paths.inbox,a)!.targetAttempt!,initial=withRoute(node.paths,h,s=>s);
 node.tick(600000);missListings(node,3,node.deps().now!());
 const result=await advanceTargetResume(deps,SESSION);
 assert.equal(result.status,'resumed-original-awaiting-completion');assert.equal(effects,1);assert.equal(node.queues.length,1);
 const final=withRoute(node.paths,h,s=>s);assert.deepEqual(final.budget,initial.budget);assert.deepEqual(final.group,initial.group);
 assert.equal(final.consumer?.execution.sessionId,SESSION);assert.equal(final.group.binding.members.length,2);
 assert.deepEqual(getMessage(node.paths.inbox,b)!.targetAttempt,h);assert.equal(final.outcomes.length,2);
 await advanceTargetResume(deps,SESSION);assert.equal(effects,1);
});

import {successorNode} from './target-resume-fixture.mts';
import {bindMessageAdmission,checkMessageEffect} from './message-admission.mts';
test('generic save and generic admission cannot mint a successor or rebuild its private provenance',async t=>{
 const n=successorNode(t),id=deliver(n);await deliverToClosed(n.deps());const h=getMessage(n.paths.inbox,id)!.targetAttempt!,initial=withRoute(n.paths,h,s=>s);
 const op={...initial.group.operation,kind:'exec-resume' as const};assert.throws(()=>withRoute(n.paths,h,(s,save)=>save({...s,consumer:op})));assert.equal(n.control.effects,0);
 n.tick(600000);missListings(n,3,n.deps().now!());assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');
 assert.throws(()=>bindMessageAdmission(n.deps(),n.control.context!,{route:'target-resume',grant:'resumeTarget',permissionMode:'auto'}));assert.equal(checkMessageEffect(n.deps(),JSON.parse(JSON.stringify(n.control.context)),'outer-spawn').ok,false);assert.equal(n.control.effects,1);assert.deepEqual(withRoute(n.paths,h,s=>s.budget),initial.budget);
});
