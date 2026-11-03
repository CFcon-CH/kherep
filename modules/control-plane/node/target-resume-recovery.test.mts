import assert from 'node:assert/strict';
import test from 'node:test';
import { strictCodexNode } from './target-resume-fixture.mts';
import { deliver, SESSION } from './closed-fixture.mts';
import { deliverToClosed } from './closed-delivery.mts';
import { getMessage } from './inbox.mts';
import { checkMessageEffect } from './message-admission.mts';
import { withRoute } from './target-delivery-route.mts';
import { selectTargetResume } from './target-resume.mts';

// Negative safety only. Restart continuation availability remains OPEN.
test('serialized queued context cannot reconstruct current-process admission', async t => {
  const node = strictCodexNode(t), id = deliver(node);
  await deliverToClosed(node.deps());
  const context = node.queues[0].context;
  assert.deepEqual(checkMessageEffect(node.deps(), JSON.parse(JSON.stringify(context)), 'queue-spawn'), { ok: false, code: 'context-unavailable' });
  assert.ok(withRoute(node.paths, getMessage(node.paths.inbox, id)!.targetAttempt!, s => s.budget));
});

test('lost Queue response retains the one reservation and debit and never resubmits', async t => {
  const node = strictCodexNode(t), id = deliver(node), prepare = node.port.prepare.bind(node.port);
  const port = { async prepare() {
    const p = await prepare();
    return { ...p, async queue(...args: Parameters<typeof p.queue>) {
      await p.queue(...args); return { status: 'unknown' as const };
    } };
  } };
  await deliverToClosed({ ...node.deps(), targetResumePort: port });
  const row = getMessage(node.paths.inbox, id)!, handle = row.targetAttempt!;
  const initial = withRoute(node.paths, handle, s => s);
  assert.equal(initial.phase, 'uncertain');
  const result = await selectTargetResume(node.deps(), { sessionId: SESSION, runtime: 'codex', permissionMode: 'auto', cwd: node.workspace + '/repo' }, [row]);
  assert.equal(result.status, 'unknown-fenced');
  assert.equal(node.queues.length, 1);
  assert.deepEqual(withRoute(node.paths, handle, s => s.budget), initial.budget);
  assert.equal(withRoute(node.paths, handle, s => s.targetResume), undefined);
});

test('future Queue acknowledgement time is not a wait deadline or replacement permission', async t => {
  const node = strictCodexNode(t), id = deliver(node), prepare = node.port.prepare.bind(node.port);
  const port = { async prepare() {
    const p = await prepare();
    return { ...p, async queue(...args: Parameters<typeof p.queue>) {
      const result = await p.queue(...args); return { ...result, submittedAt: result.submittedAt + 1 };
    } };
  } };
  await deliverToClosed({ ...node.deps(), targetResumePort: port });
  const state = withRoute(node.paths, getMessage(node.paths.inbox, id)!.targetAttempt!, s => s);
  assert.equal(state.phase, 'uncertain');
  assert.equal(state.targetResume, undefined);
  assert.equal(node.queues.length, 1);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {successorNode} from './target-resume-fixture.mts';
import {missListings} from './closed-fixture.mts';
import {advanceTargetResume} from './target-resume.mts';
import {budgetFile} from './budget-store.mts';
for(const shape of ['before-originalResume','before-targetResume'] as const)test('traced predecessor '+shape+' claim reconcile ACK and release retain successor owner',async t=>{
 const n=successorNode(t),id=deliver(n);await deliverToClosed(n.deps());n.tick(600000);missListings(n,3,n.deps().now!());assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');
 const h=getMessage(n.paths.inbox,id)!.targetAttempt!,owner=path.join(n.paths.dir,'codex-native-pending',SESSION+'.json'),before=fs.readFileSync(owner),budget=fs.readFileSync(budgetFile(n.paths,SESSION));
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'706-predecessor-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));const source=path.resolve(import.meta.dirname,'..');
 const copied=new Set<string>();function copy(relative:string){if(copied.has(relative))return;copied.add(relative);const text=fs.readFileSync(path.join(source,relative),'utf8'),target=path.join(temp,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);for(const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g))copy(path.normalize(path.join(path.dirname(relative),m[1])));}
 for(const entry of ['target-delivery-route','codex-inbox-ack','codex-native-reconcile','codex-native-pending'])copy('node/'+entry+'.mts');
 const operation=path.join(temp,'node','target-delivery-operation.mts');let parser=fs.readFileSync(operation,'utf8').replace(",...(Object.hasOwn(x,'originalResume')?['originalResume']:[])",'');if(shape==='before-targetResume')parser=parser.replace(",...(Object.hasOwn(x,'targetResume')?['targetResume']:[])",'');fs.writeFileSync(operation,parser);
 const load=(name:string)=>import(pathToFileURL(path.join(temp,'node',name+'.mts')).href);
 const route=await load('target-delivery-route'),ack=await load('codex-inbox-ack'),reconcile=await load('codex-native-reconcile'),legacy=await load('codex-native-pending');let nativeEffects=0;
 const current=withRoute(n.paths,h,s=>s),rows=[getMessage(n.paths.inbox,id)!];
 assert.equal(route.claimRoute(n.paths,rows,current.group.operation,{originalId:SESSION,policyFingerprint:current.group.binding.policyFingerprint,lifecycleGeneration:7},n.deps().now!(),{perHour:100,perDay:100,spacingMs:0}).status,'unknown-fenced');
 await assert.rejects(reconcile.reconcileNativeQueues(n.paths,SESSION,{open:async()=>{nativeEffects++;throw Error('unexpected native effect');}}));
 assert.throws(()=>ack.prepareCodexOffers(n.paths,rows,SESSION,'aaaa0000-0000-4000-8000-000000000099',n.deps().now!(),'prompt'));
 assert.throws(()=>legacy.releaseNativeOwner(n.paths,SESSION));assert.equal(legacy.reserveNativeOwner(n.paths,SESSION,[id]),false);assert.equal(nativeEffects,0);assert.equal(n.control.effects,1);assert.deepEqual(fs.readFileSync(owner),before);assert.deepEqual(fs.readFileSync(budgetFile(n.paths,SESSION)),budget);
});

import {prepareCodexOffers,acknowledgeCodexOffer} from './codex-inbox-ack.mts';
import {nativeQueueGroups,retireNativeQueue} from './codex-native-attempts.mts';
import {releaseReconciledRouteQueue} from './target-delivery-queue.mts';
test('positive natural Queue reconciliation retires exact cache and next original group can queue',async t=>{
 const n=strictCodexNode(t),id=deliver(n);await deliverToClosed(n.deps());const h=getMessage(n.paths.inbox,id)!.targetAttempt!,token='aaaa0000-0000-4000-8000-000000000088';
 prepareCodexOffers(n.paths,[getMessage(n.paths.inbox,id)!],SESSION,token,n.deps().now!(),'prompt');acknowledgeCodexOffer(n.paths,SESSION,token,[SESSION],"codex");const group=nativeQueueGroups(n.paths,SESSION)[0];assert.ok(group);retireNativeQueue(n.paths,group);assert.equal(releaseReconciledRouteQueue(n.paths,SESSION),true);
 assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'retired-original-queue');n.tick(600000);missListings(n,3,n.deps().now!());const later=deliver(n);await deliverToClosed(n.deps());assert.equal(n.queues.length,2);assert.notEqual(getMessage(n.paths.inbox,later)!.targetAttempt!.groupId,h.groupId);
});
test('missing owner alone never retires cached authority or permits a later Queue',async t=>{
 const n=strictCodexNode(t),id=deliver(n);await deliverToClosed(n.deps());const h=getMessage(n.paths.inbox,id)!.targetAttempt!;fs.unlinkSync(path.join(n.paths.dir,'codex-native-pending',SESSION+'.json'));
 assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'unknown-fenced');deliver(n);await deliverToClosed(n.deps());assert.equal(n.queues.length,1);assert.ok(h);
});

import {bindMessageAdmission} from './message-admission.mts';
test('generic fresh binding cannot recreate original Queue authority from saved context after submission',async t=>{
 const n=strictCodexNode(t);deliver(n);await deliverToClosed(n.deps());assert.throws(()=>bindMessageAdmission(n.deps(),JSON.parse(JSON.stringify(n.queues[0].context)),{route:'target-queue',grant:'resumeTarget',permissionMode:'auto'}));assert.equal(n.queues.length,1);
});
