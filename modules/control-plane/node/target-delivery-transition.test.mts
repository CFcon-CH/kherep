import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { targetFixture,TARGET_OWNER,TARGET_T,TARGET_LIMITS } from './target-delivery-fixture.mts';
import { claimRouteContext, checkExecution } from './target-delivery-route.mts';
import { commandProducer } from './target-delivery-producer.mts';
import { transitionRouteMessages,replayRouteTransition } from './target-delivery-outcome.mts';
import { recordLockFile,setRecordLockWait,RECORD_LOCK_WAIT_MS } from './inbox-record-lock.mts';
import { getMessage,markOffered } from './inbox.mts';
function fixture(t:test.TestContext){
  const f=targetFixture(t);const bin=path.join(f.root,'command');fs.writeFileSync(bin,'public');
  const producer=commandProducer({codex:{findCodex:()=>bin,home:f.root}},'codex',['exec'])!;
  const context=claimRouteContext(f.paths,f.rows,{version:1,kind:'queue',producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},{policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},TARGET_T,TARGET_LIMITS)!;
  setRecordLockWait(0);t.after(()=>setRecordLockWait(RECORD_LOCK_WAIT_MS));
  const lock=recordLockFile(f.paths.inbox,f.rows[1].messageId);fs.writeFileSync(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  assert.throws(()=>transitionRouteMessages(f.paths,context,r=>({...r,state:'offered',offers:1,offeredAt:new Date(TARGET_T).toISOString(),offeredBy:'intercom'})),/lock/i);
  assert.equal(getMessage(f.paths.inbox,f.rows[0].messageId)?.state,'offered');assert.equal(getMessage(f.paths.inbox,f.rows[1].messageId)?.state,'accepted');
  fs.unlinkSync(lock);return {...f,context};
}
test('partial multi-member CAS replays exact pending patches with no new debit or launch',t=>{
  const f=fixture(t);replayRouteTransition(f.paths,f.context);replayRouteTransition(f.paths,f.context);
  assert.equal(getMessage(f.paths.inbox,f.rows[1].messageId)?.state,'offered');assert.ok(checkExecution(f.paths,f.context,['queue']));
  const s=JSON.parse(fs.readFileSync(f.reservation,'utf8'));assert.equal(s.transitions.length,2);assert.ok(s.transitions.every((x:{applied:boolean})=>x.applied));assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
  assert.ok(!JSON.stringify(s.transitions).includes('synthetic private body'));
});
test('a third member state conflicts and never rebinds the saved transition',t=>{
  const f=fixture(t);markOffered(f.paths.inbox,f.rows[1].messageId,TARGET_T+1,'prompt');
  assert.throws(()=>replayRouteTransition(f.paths,f.context),/conflicts/);assert.throws(()=>checkExecution(f.paths,f.context,['queue']),/incoherent/);
});
