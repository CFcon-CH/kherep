import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { targetFixture, TARGET_OWNER, TARGET_T, TARGET_LIMITS } from './target-delivery-fixture.mts';
import { takeTurn } from './autonomy.mts';
import { claimRoute } from './target-delivery-route.mts';
import { commandProducer } from './target-delivery-producer.mts';

test('definite spacing refusal cancels only its uncharged owner and permits the later first group',t=>{
  const f=targetFixture(t);const bin=path.join(f.root,'synthetic');fs.writeFileSync(bin,'public');
  const p=commandProducer({codex:{findCodex:()=>bin,home:f.root}},'codex',['exec'])!;
  const op={version:1 as const,kind:'queue' as const,producer:p,budgetOwner:TARGET_OWNER,execution:{runtime:'codex' as const,sessionId:TARGET_OWNER,taskId:null}};
  const facts={policyFingerprint:'a'.repeat(64),lifecycleGeneration:7};
  const limits={perHour:20,perDay:100,spacingMs:30000};
  assert.equal(takeTurn(f.paths,TARGET_OWNER,TARGET_T,limits),'ok');
  const denied=claimRoute(f.paths,f.rows,op,facts,TARGET_T+1,limits) as any;
  assert.equal(denied.status,'denied-no-debit');assert.equal(fs.existsSync(f.reservation),false);
  const granted=claimRoute(f.paths,f.rows,op,facts,TARGET_T+30001,limits) as any;
  assert.equal(granted.status,'granted');
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,2);
});

import { cancelUnchargedRoute, recoverUnchargedCancellation, type CancelStep } from './target-delivery-cancel.mts';
import { targetId } from './target-delivery-fixture.mts';
import { getMessage } from './inbox.mts';
function heldUncharged(t:test.TestContext,alias=false) {
  const f=targetFixture(t);const bin=path.join(f.root,'synthetic');fs.writeFileSync(bin,'public');
  const producer=commandProducer({codex:{findCodex:()=>bin,home:f.root}},'codex',['exec'])!;
  const limits={perHour:20,perDay:100,spacingMs:30000};assert.equal(takeTurn(f.paths,TARGET_OWNER,TARGET_T,limits),'ok');
  fs.writeFileSync(f.budget+'.lock',String(process.pid));
  const result=claimRoute(f.paths,f.rows,{version:1,kind:'exec-resume',producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex',sessionId:alias?targetId(999):TARGET_OWNER,taskId:null}},
    {policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},TARGET_T+1,limits);
  assert.equal(result.status,'unknown-fenced');fs.unlinkSync(f.budget+'.lock');
  const handle=JSON.parse(fs.readFileSync(f.reservation,'utf8')).handle;
  return {...f,handle};
}
for(const point of ['receipt','terminal','alias-removed','original-removed'] as CancelStep[])test(`exact cancellation recovery after ${point} never refunds or removes a replacement`,t=>{
  const f=heldUncharged(t,true);assert.throws(()=>cancelUnchargedRoute(f.paths,f.handle,'spacing',{step:at=>{if(at===point)throw Error('synthetic write interruption');}}));
  assert.equal(recoverUnchargedCancellation(f.paths,f.handle),true);assert.equal(fs.existsSync(f.reservation),false);
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
  const replacement={version:1,owner:TARGET_OWNER,messageIds:[targetId(222)]};fs.writeFileSync(f.reservation,JSON.stringify(replacement));
  assert.equal(recoverUnchargedCancellation(f.paths,f.handle),false);assert.deepEqual(JSON.parse(fs.readFileSync(f.reservation,'utf8')),replacement);
});
test('malformed or tombed budget and a stored debit cannot be claimed as no-debit evidence',t=>{
  const f=heldUncharged(t);const original=fs.readFileSync(f.budget);
  fs.writeFileSync(f.budget,'{');assert.throws(()=>cancelUnchargedRoute(f.paths,f.handle,'spacing'));assert.equal(fs.existsSync(f.reservation),true);
  fs.writeFileSync(f.budget,original);const b=JSON.parse(original.toString());b.groupDebits.push({groupId:f.handle.groupId,groupFingerprint:f.handle.groupFingerprint,reservationId:f.handle.reservationId,chargedAt:TARGET_T});
  fs.writeFileSync(f.budget,JSON.stringify(b));assert.throws(()=>cancelUnchargedRoute(f.paths,f.handle,'spacing'),/conflicts/);assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
});

test('exhausted no-debit refusal leaves messages untouched and can make a later first attempt',t=>{
  const f=targetFixture(t),file=path.join(f.root,'public');fs.writeFileSync(file,'public');
  const producer=commandProducer({codex:{findCodex:()=>file,home:f.root}},'codex',['exec'])!;
  const op={version:1 as const,kind:'queue' as const,producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex' as const,sessionId:TARGET_OWNER,taskId:null}};
  const limits={perHour:1,perDay:100,spacingMs:0},facts={policyFingerprint:'a'.repeat(64),lifecycleGeneration:7};
  assert.equal(takeTurn(f.paths,TARGET_OWNER,TARGET_T,limits),'ok');
  const refusal=claimRoute(f.paths,f.rows,op,facts,TARGET_T+1,limits);assert.equal(refusal.status,'denied-no-debit');
  assert.equal(fs.existsSync(f.reservation),false);assert.deepEqual(f.rows.map(r=>getMessage(f.paths.inbox,r.messageId)),f.rows);
  assert.equal(claimRoute(f.paths,f.rows,op,facts,TARGET_T+3600001,limits).status,'granted');
});
test('missing marker and unresolved tomb deny positive cancellation; an existing debit remains intact',t=>{
  const f=heldUncharged(t);const marker=f.budget.replace('.turns.json','.budget-state.json'),bytes=fs.readFileSync(marker);
  fs.unlinkSync(marker);assert.throws(()=>cancelUnchargedRoute(f.paths,f.handle,'spacing'));fs.writeFileSync(marker,bytes);
  const tomb=path.join(path.dirname(f.budget),`.${path.basename(f.budget)}.synthetic.tomb`);fs.writeFileSync(tomb,'{}');
  assert.throws(()=>cancelUnchargedRoute(f.paths,f.handle,'spacing'));assert.equal(fs.existsSync(f.reservation),true);
});
for(const point of ['receipt','terminal','alias-removed'] as CancelStep[])test(`production claim recovers only an exact uncharged cancellation after ${point}`,t=>{
  const f=heldUncharged(t,true);
  assert.throws(()=>cancelUnchargedRoute(f.paths,f.handle,'spacing',{step:at=>{if(at===point)throw Error('synthetic cancellation interruption');}}));
  const file=path.join(f.root,'next-public-command');fs.writeFileSync(file,'public');
  const producer=commandProducer({codex:{findCodex:()=>file,home:f.root}},'codex',['exec'])!;
  const next=claimRoute(f.paths,f.rows,{version:1,kind:'exec-resume',producer,budgetOwner:TARGET_OWNER,
    execution:{runtime:'codex',sessionId:TARGET_OWNER,taskId:null}},
    {policyFingerprint:'a'.repeat(64),lifecycleGeneration:7},TARGET_T+30001,{perHour:20,perDay:100,spacingMs:30000});
  assert.equal(next.status,'granted');
  assert.notEqual(JSON.parse(fs.readFileSync(f.reservation,'utf8')).handle.groupId,f.handle.groupId);
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,2);
});
