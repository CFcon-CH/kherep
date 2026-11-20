import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HANDLERS, permissionsFor } from './operations.mts';
import { mergeHandler } from './merge.mts';
import { branchDeleteHandler } from './branch-delete.mts';
import { ReceiptStore } from './receipt.mts';
import { run as claude } from './github-claude.mts';
import { stubWindowsAcl } from './flow.fixture.mts';
import { BRANCH, HEAD, REF, repository, setup } from './branch-delete.fixture.mts';
stubWindowsAcl();
test('branch.delete requests exactly contents:write and declares twelve requests; no other handler raises the cap',()=>{
  assert.deepEqual(permissionsFor('branch.delete',false),{contents:'write'});
  assert.deepEqual(Object.entries(HANDLERS).filter(([,h])=>h.requests!==undefined).map(([o,h])=>[o,h.requests]),[['branch.delete',12]]);
});
for (const runtime of ['claude','codex'] as const) test(`${runtime} branch.delete deletes the ref once, verifies and never replays`,async t=>{
  const s=setup(t,runtime), operationId=randomUUID();
  const result=await s.remove(operationId);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.operation,'branch.delete');assert.equal(result.status,'verified');
  assert.equal(result.result,'deleted');assert.equal(result.branch,BRANCH);assert.equal(result.sha,HEAD);assert.equal(result.prNumber,80);
  assert.equal(result.attribution,'authenticated-installation');assert.equal(result.reason,undefined);
  assert.deepEqual(s.deletes().map(c=>c.url),[REF]);assert.equal(s.api.calls.length,12);
  assert.deepEqual(s.api.calls.filter(c=>c.url.endsWith('/access_tokens')).map(c=>c.body.permissions),[{contents:'write'}]);
  assert.deepEqual(s.api.mutations().map(c=>c.method),['DELETE']);
  const replay=await s.remove(operationId);assert.equal(replay.ok,true);assert.equal(replay.result,'deleted');
  const verified=await s.verify(operationId);assert.equal(verified.ok,true,JSON.stringify(verified));assert.equal(verified.result,'deleted');
  assert.equal(s.deletes().length,1);
});
test('preflight reads the head list, base list, rules, pull ref and branch in that order; the receipt is known on disk before the DELETE',async t=>{
  const s=setup(t);let atDelete:unknown;
  const fetch:typeof globalThis.fetch=async(url,init)=>{
    if (init?.method==='DELETE') atDelete=JSON.parse(fs.readFileSync(path.join(s.root,'receipts',s.receipts()[0]),'utf8')).status;
    return s.api.fetch(url,init);
  };
  const result=await claude(JSON.stringify({operationId:randomUUID(),repository,operation:'branch.delete',branch:BRANCH,sha:HEAD,prNumber:80}),{root:s.root,fetch});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(atDelete,'known');
  const after=s.api.calls.slice(5).map(c=>`${c.method} ${c.url}${c.query}`);
  assert.deepEqual(after,[
    `GET /repos/${repository}/pulls?state=all&head=example:${BRANCH}&per_page=30`,
    `GET /repos/${repository}/pulls?state=open&base=${BRANCH}&per_page=1`,
    `GET /repos/${repository}/rules/branches/${BRANCH}`,
    `GET /repos/${repository}/git/ref/pull/80/head`,
    `GET /repos/${repository}/branches/${BRANCH}`,
    `DELETE ${REF}`,
    `GET /repos/${repository}/git/ref/heads/${BRANCH}`,
  ]);
});
test('an already absent branch verifies as absent without a DELETE',async t=>{
  const s=setup(t), operationId=randomUUID();s.heads.delete(BRANCH);
  const result=await s.remove(operationId);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result,'absent');assert.equal(s.deletes().length,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.root,'receipts',s.receipts()[0]),'utf8')).status,'verified');
  assert.equal((await s.verify(operationId)).result,'absent');
});
test('an absent branch with a wrong prNumber or sha is still refused, not absent',async t=>{
  for (const [extra,reason] of [[{prNumber:81},'pull-not-found'],[{sha:'d'.repeat(40)},'pull-head-mismatch']] as const) {
    const s=setup(t);s.heads.delete(BRANCH);
    const result=await s.remove(randomUUID(),extra);
    assert.equal(result.error,'target-refused',JSON.stringify(extra));assert.equal(result.reason,reason);assert.equal(result.result,undefined);
    assert.equal(s.deletes().length,0);assert.deepEqual(s.receipts(),[]);
  }
});
for (const status of [409,422]) test(`a DELETE refused with ${status} is outcome-unknown without result; verify and a retry report verification-failed`,async t=>{
  const s=setup(t), operationId=randomUUID();s.api.control.deleteAnswer=status;
  const failed=await s.remove(operationId);
  assert.equal(failed.error,'outcome-unknown');assert.equal(failed.branch,BRANCH);assert.equal('result' in failed,false);assert.equal('reason' in failed,false);
  for (const again of [await s.verify(operationId),await s.remove(operationId)]) { assert.equal(again.error,'verification-failed');assert.equal('result' in again,false); }
  assert.equal(s.deletes().length,1);assert.equal(s.api.control.deleted.size,0);
});
test('a lost DELETE answer is outcome-unknown without result; verify and a retry settle it as absent without a second DELETE',async t=>{
  const s=setup(t), operationId=randomUUID();s.api.control.deleteAnswer='lost';
  const lost=await s.remove(operationId);assert.equal(lost.error,'outcome-unknown');assert.equal(lost.prNumber,80);assert.equal('result' in lost,false);
  const verified=await s.verify(operationId);assert.equal(verified.ok,true,JSON.stringify(verified));assert.equal('result' in verified,false);
  const retry=await s.remove(operationId);assert.equal(retry.ok,true);assert.equal(retry.result,'absent');
  assert.equal(s.deletes().length,1);
});
test('a DELETE answered without effect fails readback',async t=>{
  const s=setup(t);s.api.control.deleteAnswer='noop';
  const result=await s.remove();assert.equal(result.error,'verification-failed');assert.equal('result' in result,false);assert.equal(s.deletes().length,1);
});
test('the same operationId with another sha conflicts without a provider write',async t=>{
  const s=setup(t), operationId=randomUUID();
  assert.equal((await s.remove(operationId)).ok,true);
  assert.equal((await s.remove(operationId,{sha:'d'.repeat(40)})).error,'operation-conflict');assert.equal(s.deletes().length,1);
});
test('an unlisted branch.delete or a version 1 policy refuses before any network call',async t=>{
  for (const edit of [(p:Record<string,any>)=>{p.runtimes.claude.operations=['branch.push'];},(p:Record<string,any>)=>{p.version=1;}]) {
    const s=setup(t,'claude',edit), result=await s.remove();
    assert.equal(result.error,'policy-invalid');assert.equal(s.api.calls.length,0);assert.deepEqual(s.receipts(),[]);
  }
});
test('another operation keeps the default limit and refuses its eleventh request',async t=>{
  const s=setup(t,'claude',p=>{for (const r of Object.values(p.runtimes) as any[]) r.repositories[0].merge={method:'rebase'};},{});
  s.api.pulls.set(80,{...s.api.pulls.get(80),state:'open',draft:false,mergeable:true});
  const padded={...mergeHandler,async preflight(c:any){ for (let i=0;i<5;i++) await c.http('GET',`/repos/${repository}`,c.token);return mergeHandler.preflight(c); }};
  HANDLERS['pr.merge']=padded;t.after(()=>{HANDLERS['pr.merge']=mergeHandler;});
  const result=await s.send({operationId:randomUUID(),operation:'pr.merge',prNumber:80,sha:HEAD});
  assert.equal(result.error,'transport-failed');assert.equal(s.api.calls.length,10);
});
test('a branch receipt admits deleted or absent results and its own kind only',t=>{
  const store=new ReceiptStore(setup(t).root,'claude',11,repository,randomUUID());
  const base={version:2 as const,kind:'branch' as const,digest:'0'.repeat(64),operation:'branch.delete' as const,status:'known' as const,fieldHashes:{},branch:BRANCH,sha:HEAD,prNumber:80,targetId:8000};
  for (const result of ['deleted','absent'] as const) { store.write({...base,result});assert.equal(store.read()?.result,result); }
  for (const bad of [{result:'gone'},{kind:'push'},{prNumber:undefined},{branch:undefined},{sha:undefined}]) {
    fs.writeFileSync(store.file,JSON.stringify({...base,...bad}),{mode:0o600});assert.throws(()=>store.read(),{message:'receipt-invalid'},JSON.stringify(bad));
  }
  const merge={version:2,kind:'pull',digest:'0'.repeat(64),operation:'pr.merge',status:'known',fieldHashes:{},prNumber:80,targetId:8000,sha:HEAD,result:'deleted'};
  fs.writeFileSync(store.file,JSON.stringify(merge),{mode:0o600});assert.throws(()=>store.read(),{message:'receipt-invalid'});
});
// Direct handler calls cover the defensive branches the CLI path cannot reach.
test('branch.delete readback refuses an incomplete receipt; mutate of an absent branch sends nothing',async()=>{
  let calls=0;const c={http:async()=>{calls++;return {};},token:'t',repo:{slug:repository,id:55}} as any;
  for (const receipt of [{sha:HEAD,prNumber:80},{branch:BRANCH,prNumber:80},{branch:BRANCH,sha:HEAD}]) await assert.rejects(()=>branchDeleteHandler.readback(c,receipt as any),{message:'outcome-unknown'});
  let saved=0;assert.deepEqual(await branchDeleteHandler.mutate(c,{branch:BRANCH,sha:HEAD,prNumber:80,result:'absent'} as any,()=>{saved++;}),{});
  assert.equal(calls,0);assert.equal(saved,0);
});
test('public IDs carry result only for a verified receipt',()=>{
  const receipt={branch:BRANCH,sha:HEAD,prNumber:80,targetId:8000} as any;
  assert.deepEqual(branchDeleteHandler.ids({...receipt,status:'known',result:'deleted'}),{branch:BRANCH,sha:HEAD,prNumber:80});
  assert.deepEqual(branchDeleteHandler.ids({...receipt,status:'verified'}),{branch:BRANCH,sha:HEAD,prNumber:80,result:'absent'});
  assert.deepEqual(branchDeleteHandler.ids({...receipt,status:'verified',result:'deleted'}),{branch:BRANCH,sha:HEAD,prNumber:80,result:'deleted'});
});
