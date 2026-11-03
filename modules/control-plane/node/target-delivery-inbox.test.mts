import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { closedNode, deliver, PEER } from './closed-fixture.mts';
import { deliverToClosed } from './closed-delivery.mts';
import { deliverForHook } from './deliver-hook.mts';
import { getMessage, markOffered } from './inbox.mts';
import { answerMcpInbox, offerMcpInbox } from './mcp-local.mts';
import { writeTask } from './task-records.mts';
import { handoverTaskMessages } from './task-handover.mts';
import { parseRouteReservation } from './target-delivery-operation.mts';
import { routeMembersCurrent } from './target-delivery-route.mts';
import { targetId } from './target-delivery-fixture.mts';
import { T0, TASK } from './task-fixture.mts';
import { prepareCodexOffers, acknowledgeCodexOffer } from './codex-inbox-ack.mts';
import { claimRouteContext, withRoute } from './target-delivery-route.mts';
import { transitionRouteMessages } from './target-delivery-outcome.mts';
import { targetFixture, TARGET_OWNER, TARGET_T, TARGET_LIMITS } from './target-delivery-fixture.mts';
import {drain,purgeInboxSteps} from './inbox-purge.mts';
import {setInboxDelivery} from './target-delivery-inbox.mts';

const EXECUTOR=targetId(982);
async function handed(t:test.TestContext) {
  const n=closedNode(t);
  writeTask(n.paths,{taskId:TASK,name:'task-3f2a1b0c',runtime:'claude',sessionId:EXECUTOR,local:'intercom',
    requestedBy:`${PEER.nodeId}/${PEER.session}`,cwd:n.workspace,permissionMode:'default',state:'running',
    startedAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()},T0);
  const id=deliver(n);await deliverToClosed(n.deps());
  const handle=getMessage(n.paths.inbox,id)!.targetAttempt!;
  const current=()=>parseRouteReservation(JSON.parse(fs.readFileSync(path.join(n.paths.dir,'codex-native-pending',`${handle.owner}.json`),'utf8')));
  return {...n,id,handle,current};
}
test('actual passive prompt journals a strict handover without a debit, and Stop can confirm it',async t=>{
  const n=await handed(t);
  const output=deliverForHook({hook_event_name:'UserPromptSubmit',session_id:EXECUTOR,permission_mode:'default'},
    {paths:n.paths,now:()=>T0});
  assert.ok(output);assert.equal(getMessage(n.paths.inbox,n.id)!.state,'offered');
  assert.equal(routeMembersCurrent(n.paths,n.current()),true);
  assert.equal(n.current().budget,null);
  deliverForHook({hook_event_name:'Stop',session_id:EXECUTOR,permission_mode:'default'},{paths:n.paths,now:()=>T0});
  assert.equal(getMessage(n.paths.inbox,n.id)!.state,'delivered');
  assert.equal(routeMembersCurrent(n.paths,n.current()),true);
});
test('actual MCP passive offer and reply keep the strict group coherent before task watch',async t=>{
  const n=await handed(t);offerMcpInbox(n.paths,[n.id],T0);
  assert.equal(routeMembersCurrent(n.paths,n.current()),true);
  answerMcpInbox(n.paths,[n.id]);
  assert.equal(getMessage(n.paths.inbox,n.id)!.state,'delivered');
  assert.equal(routeMembersCurrent(n.paths,n.current()),true);
  assert.equal(n.current().budget,null);
});
test('legacy raw offer and task-copy helper refuse strict rows instead of corrupting the group',async t=>{
  const n=await handed(t);
  assert.throws(()=>markOffered(n.paths.inbox,n.id,T0,'prompt'),/strict|journal/);
  assert.throws(()=>handoverTaskMessages(n.paths.inbox,EXECUTOR,targetId(983),{taskId:TASK,runtime:'claude'}),/strict|journal/);
  assert.equal(routeMembersCurrent(n.paths,n.current()),true);
});
test('verified Codex handover reader can passively offer and ACK without an autonomous consumer or debit',t=>{
  const f=targetFixture(t),taskId=targetId(910),owner=targetId(911),token=targetId(912);
  writeTask(f.paths,{taskId,name:'task-synthetic',runtime:'codex',local:'intercom',sessionId:owner,cwd:f.root,permissionMode:'default',state:'running',
    startedAt:new Date(TARGET_T).toISOString(),updatedAt:new Date(TARGET_T).toISOString(),deadline:new Date(TARGET_T+60000).toISOString()},TARGET_T);
  const ctx=claimRouteContext(f.paths,f.rows,{version:1,kind:'handover',producer:null,budgetOwner:owner,execution:{runtime:'codex',sessionId:owner,taskId}},
    {policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},TARGET_T,TARGET_LIMITS)!;
  const rows=transitionRouteMessages(f.paths,ctx,r=>({...r,toSession:owner,closedTo:TARGET_OWNER,delivery:{taskId,runtime:'codex',sessionId:owner}}));
  const offered=prepareCodexOffers(f.paths,rows,owner,token,TARGET_T,'codex-prompt');assert.equal(offered.length,2);
  assert.match(acknowledgeCodexOffer(f.paths,owner,token,[owner]),/ACK committed for 2/);
  withRoute(f.paths,ctx.kind==='message'?ctx.handle:assert.fail(),s=>{assert.equal(s.consumer,null);assert.equal(s.budget,null);assert.equal(routeMembersCurrent(f.paths,s),true);});
});
test('actual sliced maintenance refuses a strict waiting row through its journal and retains group evidence',async t=>{
  const n=await handed(t),later=T0+8*24*3600000;
  assert.equal(drain(purgeInboxSteps(n.paths.inbox,later,7*24*3600000,Infinity,n.paths)),0);
  assert.equal(getMessage(n.paths.inbox,n.id)!.state,'refused');assert.equal(routeMembersCurrent(n.paths,n.current()),true);
  assert.equal(drain(purgeInboxSteps(n.paths.inbox,later+8*24*3600000,7*24*3600000,Infinity,n.paths)),0);
  assert.ok(getMessage(n.paths.inbox,n.id));
});
test('the group-aware delivery adapter retains legacy identity validation before any write',t=>{
  const f=targetFixture(t),row=f.rows[0];
  assert.throws(()=>setInboxDelivery(f.paths,row.messageId,{taskId:'invalid',runtime:'codex'}),/invalid delivery/);
  assert.deepEqual(getMessage(f.paths.inbox,row.messageId),row);
});
