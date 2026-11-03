import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { closedNode, deliver, SESSION, PEER } from './closed-fixture.mts';
import { deliverToClosed } from './closed-delivery.mts';
import { deliverForHook } from './deliver-hook.mts';
import { writeTask } from './task-records.mts';
import { getMessage, writeJsonAtomic } from './inbox.mts';
import { livenessFile } from './session-lifecycle.mts';
import { T0, TASK } from './task-fixture.mts';
import { targetId } from './target-delivery-fixture.mts';
import { claimRouteContext as claimRoute } from './target-delivery-route.mts';
import { parseRouteReservation } from './target-delivery-operation.mts';

const EXECUTOR=targetId(982);
function intercom(n:ReturnType<typeof closedNode>) {
  return writeTask(n.paths,{taskId:TASK,name:'task-3f2a1b0c',runtime:'claude',sessionId:EXECUTOR,local:'intercom',requestedBy:`${PEER.nodeId}/${PEER.session}`,
    cwd:n.workspace,permissionMode:'default',state:'running',startedAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()},T0);
}
test('actual closed running handover claims both UUIDs, charges nothing, then actual Claude Stop consumes that reference once',async t=>{
  const n=closedNode(t);intercom(n);const id=deliver(n);
  await deliverToClosed(n.deps());
  const row=getMessage(n.paths.inbox,id)!;assert.equal(row.toSession,EXECUTOR);assert.equal(row.closedTo,SESSION);assert.equal(row.targetAttempt?.owner,SESSION);
  assert.equal(claimRoute(n.paths,[{...row,messageId:targetId(983),targetAttempt:undefined}],{version:1,kind:'handover',producer:null,budgetOwner:EXECUTOR,execution:{runtime:'claude-code',sessionId:EXECUTOR,taskId:null}},
    {policyFingerprint:'a'.repeat(64),lifecycleGeneration:7,originalId:EXECUTOR},T0,{perHour:1,perDay:1,spacingMs:0}),null,'direct executor consumer loses to the same alias owner');
  const budget=path.join(n.paths.dir,'listeners',`${EXECUTOR}.turns.json`);assert.equal(fs.existsSync(budget),false);
  writeJsonAtomic(livenessFile(n.paths),{version:1,generation:92,sessions:[{runtime:'claude-code',sessionId:EXECUTOR,state:'running',observedAt:T0,reasonCode:'observed',lifecycleGeneration:7}],tombstones:[]});
  const producer={version:1 as const,kind:'hook' as const,runtime:'claude-code' as const,launchFile:'/synthetic/hook',launchPrefix:[],files:[{path:'/synthetic/hook',realpath:'/synthetic/hook',sha256:'a'.repeat(64)}],home:null,route:'local' as const,argsFingerprint:'b'.repeat(64),consumer:{source:'native-hook' as const,identity:'c'.repeat(64),epoch:targetId(991)}};
  const output=deliverForHook({hook_event_name:'Stop',session_id:EXECUTOR,permission_mode:'default'},{paths:n.paths,now:()=>T0,messageProducer:producer});
  assert.ok(output);assert.equal(JSON.parse(fs.readFileSync(budget,'utf8')).turns.length,1);
  const saved=parseRouteReservation(JSON.parse(fs.readFileSync(path.join(n.paths.dir,'codex-native-pending',`${SESSION}.json`),'utf8')));
  assert.equal(saved.handle.groupId,row.targetAttempt!.groupId);assert.equal(saved.consumer?.kind,'hook-continue');
  assert.equal(deliverForHook({hook_event_name:'Stop',session_id:EXECUTOR,permission_mode:'default'},{paths:n.paths,now:()=>T0,messageProducer:producer}),'');
});
test('actual closed selection loses to a common owner before address, delivery or closedAttempt mutation',async t=>{
  const n=closedNode(t);intercom(n);const id=deliver(n);const row=getMessage(n.paths.inbox,id)!;
  assert.ok(claimRoute(n.paths,[row],{version:1,kind:'handover',producer:null,budgetOwner:SESSION,execution:{runtime:'claude-code',sessionId:SESSION,taskId:null}},
    {policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},T0,{perHour:1,perDay:1,spacingMs:0}));
  await deliverToClosed(n.deps());const after=getMessage(n.paths.inbox,id)!;
  assert.equal(after.toSession,SESSION);assert.equal(after.delivery,undefined);assert.equal(after.closedAttempt,undefined);
});
