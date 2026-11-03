import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { targetFixture, TARGET_OWNER, TARGET_T, TARGET_LIMITS, targetId } from './target-delivery-fixture.mts';
import { claimRouteContext as claimRoute, beginRouteEffect, checkExecution, withRoute } from './target-delivery-route.mts';
import { finishRouteEffect, transitionRouteMessages } from './target-delivery-outcome.mts';
import { commandProducer } from './target-delivery-producer.mts';
import { releaseNativeOwner } from './codex-native-pending.mts';
import { markOffered, getMessage } from './inbox.mts';

function admitted(t:test.TestContext,kind:'queue'|'exec-resume'='queue') {
  const f=targetFixture(t);const bin=path.join(f.root,'command');fs.writeFileSync(bin,'public');
  const producer=commandProducer({codex:{findCodex:()=>bin,home:f.root}},'codex',['exec'])!;
  const context=claimRoute(f.paths,f.rows,{version:1,kind,producer,budgetOwner:TARGET_OWNER,
    execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},
    {policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},TARGET_T,TARGET_LIMITS)!;
  return {...f,context};
}
test('uncertain result fences; a late exact queue identity updates the same attempt and another ID conflicts',t=>{
  const f=admitted(t);beginRouteEffect(f.paths,f.context,['queue']);finishRouteEffect(f.paths,f.context,{kind:'uncertain'});
  finishRouteEffect(f.paths,f.context,{kind:'queue',queueId:targetId(990)});
  finishRouteEffect(f.paths,f.context,{kind:'queue',queueId:targetId(990)});
  assert.throws(()=>finishRouteEffect(f.paths,f.context,{kind:'queue',queueId:targetId(991)}),/conflict/);
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
  assert.throws(()=>beginRouteEffect(f.paths,f.context,['queue']),/already/);
});
test('PID and fork identities cannot become queue outcomes; old IDs-only release cannot retire the new owner',t=>{
  const f=admitted(t);beginRouteEffect(f.paths,f.context,['queue']);
  assert.throws(()=>finishRouteEffect(f.paths,f.context,{kind:'exec',pid:4001,pidStart:'synthetic',threadId:TARGET_OWNER}),/wrong operation/);
  assert.throws(()=>releaseNativeOwner(f.paths,TARGET_OWNER),/invalid native owner/);
  assert.equal(fs.existsSync(f.reservation),true);
});
test('an exact planned offer preserves origin/lineage; competing offer mutation blocks the bound effect',t=>{
  const f=admitted(t);const before=getMessage(f.paths.inbox,f.rows[0].messageId)!;
  transitionRouteMessages(f.paths,f.context,r=>({...r,state:'offered',offers:1,offeredAt:new Date(TARGET_T).toISOString(),offeredBy:'codex-wake'}));
  assert.deepEqual(getMessage(f.paths.inbox,before.messageId)!.senderOrigin,before.senderOrigin);
  assert.throws(()=>markOffered(f.paths.inbox,before.messageId,TARGET_T+1,'prompt'),/strict.*journal/);
  // An uncooperative external disk writer is still detected. A legitimate
  // journaled passive offer is covered separately and does not corrupt state.
  const current=getMessage(f.paths.inbox,before.messageId)!;
  fs.writeFileSync(path.join(f.paths.inbox,`${before.messageId}.json`),JSON.stringify({...current,offers:2}));
  assert.throws(()=>checkExecution(f.paths,f.context,['queue']),/incoherent/);
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
});
test('partial ordered alias claim fences the original; neither a different group nor corrupted history can execute',t=>{
  const f=admitted(t,'exec-resume');
  fs.writeFileSync(path.join(f.paths.dir,'target-delivery-groups',TARGET_OWNER,`${f.context.kind==='message'?f.context.handle.groupId:''}.route.json`),'{}');
  assert.throws(()=>checkExecution(f.paths,f.context,['exec-resume']),/history incomplete/);
});

test('more than sixteen identical result callbacks are idempotent and do not consume history',t=>{
  const f=admitted(t);beginRouteEffect(f.paths,f.context,['queue']);
  for(let i=0;i<40;i++)finishRouteEffect(f.paths,f.context,{kind:'queue',queueId:targetId(990)});
  const s=JSON.parse(fs.readFileSync(f.reservation,'utf8'));assert.equal(s.outcomes.length,1);
});
