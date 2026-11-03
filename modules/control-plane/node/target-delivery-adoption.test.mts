import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { closedNode, deliver, PEER } from './closed-fixture.mts';
import { deliverToClosed } from './closed-delivery.mts';
import { getMessage } from './inbox.mts';
import { readTask, writeTask } from './task-records.mts';
import { watchTasks } from './task-watch.mts';
import { routeMembersCurrent } from './target-delivery-route.mts';
import { parseRouteReservation } from './target-delivery-operation.mts';
import { recordLockFile, setRecordLockWait, RECORD_LOCK_WAIT_MS } from './inbox-record-lock.mts';
import { targetId } from './target-delivery-fixture.mts';
import { T0, TASK } from './task-fixture.mts';
import {adoptRouteCopy,CopyAdoptionRefused} from './target-delivery-adoption.mts';
import {answerMcpInbox} from './mcp-local.mts';
import {claimRouteContext,beginRouteEffect} from './target-delivery-route.mts';
import {commandProducer} from './target-delivery-producer.mts';
import {finishRouteEffect,bindRouteExecutionSession} from './target-delivery-outcome.mts';

const S1=targetId(982),S2=targetId(983);
export async function copiedGroup(t:test.TestContext,count=2) {
  const n=closedNode(t);writeTask(n.paths,{taskId:TASK,name:'task-3f2a1b0c',shortId:'copy0001',runtime:'claude',sessionId:S1,local:'intercom',
    requestedBy:`${PEER.nodeId}/${PEER.session}`,cwd:n.workspace,permissionMode:'default',state:'running',
    startedAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()},T0);
  const ids=Array.from({length:count},()=>deliver(n));await deliverToClosed(n.deps());
  const handle=getMessage(n.paths.inbox,ids[0])!.targetAttempt!;
  const current=()=>parseRouteReservation(JSON.parse(fs.readFileSync(path.join(n.paths.dir,'codex-native-pending',`${handle.owner}.json`),'utf8')));
  n.rows.splice(0,n.rows.length,{id:'copy0001',sessionId:S2,state:'working',kind:'background'});
  return {...n,ids,handle,current};
}
test('actual task watch adopts strict rows through a nonconsuming copy history before publishing task mapping',async t=>{
  const n=await copiedGroup(t);await watchTasks(n.deps());
  assert.equal(readTask(n.paths,TASK)!.sessionId,S2);
  for(const id of n.ids){const row=getMessage(n.paths.inbox,id)!;assert.equal(row.toSession,S2);assert.equal(row.delivery!.sessionId,S2);}
  assert.equal(routeMembersCurrent(n.paths,n.current()),true);
  assert.equal(n.current().budget,null);assert.equal(n.current().consumer,null);
  const first=JSON.stringify(n.current());await watchTasks(n.deps());assert.equal(JSON.stringify(n.current()),first);
});
test('copy alias conflict and unrelated task leave owner, immutable group and rows untouched',async t=>{
  const n=await copiedGroup(t),before=JSON.stringify(n.current()),rows=n.ids.map(id=>getMessage(n.paths.inbox,id));
  const alias=path.join(n.paths.dir,'codex-native-pending',`${S2}.json`);fs.writeFileSync(alias,JSON.stringify({version:1,owner:S2,messageIds:[targetId(990)]}));
  assert.throws(()=>adoptRouteCopy(n.paths,n.handle,{taskId:TASK,runtime:'claude'},S2),CopyAdoptionRefused);
  assert.equal(JSON.stringify(n.current()),before);assert.deepEqual(n.ids.map(id=>getMessage(n.paths.inbox,id)),rows);
  fs.unlinkSync(alias);assert.throws(()=>adoptRouteCopy(n.paths,n.handle,{taskId:targetId(991),runtime:'claude'},S2),CopyAdoptionRefused);
  assert.equal(JSON.stringify(n.current()),before);
});
test('a crash after durable intent but before alias creation retries only that same copy',async t=>{
  const n=await copiedGroup(t),alias=path.join(n.paths.dir,'codex-native-pending',`${S2}.json`),open=fs.openSync;
  const mock=t.mock.method(fs,'openSync',(file:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{if(file===alias&&flags==='wx')throw Error('synthetic alias write interruption');return open(file,flags,mode);});
  assert.throws(()=>adoptRouteCopy(n.paths,n.handle,{taskId:TASK,runtime:'claude'},S2),/synthetic alias/);
  assert.equal(n.current().adoptions?.at(-1)?.phase,'intent');assert.equal(getMessage(n.paths.inbox,n.ids[0])!.toSession,S1);
  mock.mock.restore();adoptRouteCopy(n.paths,n.handle,{taskId:TASK,runtime:'claude'},S2);
  assert.equal(n.current().adoptions?.length,1);assert.equal(n.current().adoptions?.[0].phase,'converged');assert.equal(routeMembersCurrent(n.paths,n.current()),true);
});
test('a legitimate journal reply between address and identity phases stays terminal during adoption',async t=>{
  const n=await copiedGroup(t),ownerLock=recordLockFile(path.join(n.paths.dir,'codex-native-pending'),S1),remove=fs.rmSync;let replied=false;
  t.mock.method(fs,'rmSync',(file:fs.PathLike,opts?:fs.RmOptions)=>{remove(file,opts);if(file===ownerLock&&!replied&&n.current().adoptions?.at(-1)?.phase==='addressed'){replied=true;answerMcpInbox(n.paths,[n.ids[0]]);}});
  adoptRouteCopy(n.paths,n.handle,{taskId:TASK,runtime:'claude'},S2);
  assert.equal(replied,true);assert.equal(getMessage(n.paths.inbox,n.ids[0])!.state,'delivered');
  assert.equal(getMessage(n.paths.inbox,n.ids[0])!.delivery!.sessionId,S2);assert.equal(routeMembersCurrent(n.paths,n.current()),true);
});
test('sixteen append-only adoptions fill the bounded history; the seventeenth never evicts evidence',async t=>{
  const n=await copiedGroup(t,1);
  for(let i=0;i<16;i++){const to=targetId(1100+i);adoptRouteCopy(n.paths,n.handle,{taskId:TASK,runtime:'claude'},to);writeTask(n.paths,{...readTask(n.paths,TASK)!,sessionId:to},T0);}
  const before=JSON.stringify(n.current());assert.equal(n.current().adoptions?.length,16);
  assert.throws(()=>adoptRouteCopy(n.paths,n.handle,{taskId:TASK,runtime:'claude'},targetId(1200)),e=>e instanceof CopyAdoptionRefused&&e.code==='capacity');
  assert.equal(JSON.stringify(n.current()),before);assert.equal(routeMembersCurrent(n.paths,n.current()),true);
});
test('a measured later Claude copy preserves the known execution result, consumer and single debit',async t=>{
  const n=await copiedGroup(t),file=path.join(n.root,'public-command');fs.writeFileSync(file,'public');
  const producer=commandProducer({findClaude:()=>file},'claude-code',['--resume',S1],{cwd:n.workspace})!;
  const context=claimRouteContext(n.paths,n.ids.map(id=>getMessage(n.paths.inbox,id)!),{version:1,kind:'exec-resume',producer,budgetOwner:S1,
    execution:{runtime:'claude-code',sessionId:S1,taskId:TASK}},{policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},T0,{perHour:1,perDay:1,spacingMs:0})!;
  beginRouteEffect(n.paths,context,['exec-resume']);finishRouteEffect(n.paths,context,{kind:'exec',pid:53530,pidStart:'synthetic',threadId:S1});bindRouteExecutionSession(n.paths,context,S1);
  writeTask(n.paths,{...readTask(n.paths,TASK)!,targetAttempt:n.handle,pid:53530,pidStart:'synthetic'},T0);
  const before=n.current();await watchTasks(n.deps());const after=n.current();
  assert.equal(readTask(n.paths,TASK)!.sessionId,S2);assert.equal(readTask(n.paths,TASK)!.mappingConflict,undefined);
  assert.deepEqual(after.outcomes,before.outcomes);assert.deepEqual(after.outcome,before.outcome);assert.deepEqual(after.consumer,before.consumer);
  assert.equal(after.executionSessionId,S1);assert.equal(after.adoptions?.at(-1)?.toSession,S2);assert.equal(routeMembersCurrent(n.paths,after),true);
});
test('strict copy contention preserves old task mapping and replays exact partial group before convergence',async t=>{
  const n=await copiedGroup(t),file=recordLockFile(n.paths.inbox,n.ids[1]);
  setRecordLockWait(0);t.after(()=>{setRecordLockWait(RECORD_LOCK_WAIT_MS);fs.rmSync(file,{force:true});});
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  await watchTasks(n.deps());assert.equal(readTask(n.paths,TASK)!.sessionId,S1);
  assert.equal(getMessage(n.paths.inbox,n.ids[0])!.toSession,S2);
  assert.equal(getMessage(n.paths.inbox,n.ids[1])!.toSession,S1);
  fs.unlinkSync(file);await watchTasks(n.deps());
  assert.equal(readTask(n.paths,TASK)!.sessionId,S2);assert.equal(routeMembersCurrent(n.paths,n.current()),true);
  assert.equal(n.current().budget,null);
});
