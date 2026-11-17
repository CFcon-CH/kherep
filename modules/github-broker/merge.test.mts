import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MERGED, brokerRoot, fakeGithub, stubWindowsAcl } from './flow.fixture.mts';
import { permissionsFor } from './operations.mts';
import { ReceiptStore } from './receipt.mts';
import { run as claude } from './github-claude.mts';
import { run as codex } from './github-codex.mts';
stubWindowsAcl();
type T = {after:(fn:()=>void)=>void};
const repository = 'example/project', HEAD = 'a'.repeat(40);
const withMerge = (method:string) => (p:Record<string,any>) => { for (const r of Object.values(p.runtimes) as any[]) r.repositories[0].merge = {method}; };
function setup(t:T, runtime:'claude'|'codex'='claude', edit:(p:Record<string,any>)=>void=withMerge('rebase'), pr:Record<string,unknown>={}) {
  const root=brokerRoot(t,runtime,edit), api=fakeGithub(runtime), run=runtime==='claude'?claude:codex;
  api.pulls.set(80,{id:8000,number:80,state:'open',merged:false,draft:false,mergeable:true,merge_commit_sha:null,merged_by:null,
    base:{ref:'main',repo:{full_name:repository}},head:{ref:'feat/m',sha:HEAD,repo:{full_name:repository}},...pr});
  const send=(request:Record<string,unknown>)=>run(JSON.stringify({repository,...request}),{root,fetch:api.fetch});
  const merge=(operationId=randomUUID())=>send({operationId,operation:'pr.merge',prNumber:80,sha:HEAD});
  const verify=(operationId:string)=>send({operationId,operation:'verify'});
  const puts=()=>api.calls.filter(c=>c.method==='PUT');
  const receipts=()=>fs.readdirSync(path.join(root,'receipts'));
  return {root,api,send,merge,verify,puts,receipts};
}
test('pr.merge requests exactly contents:write',()=>{
  assert.deepEqual(permissionsFor('pr.merge',false),{contents:'write'});
});
for (const [runtime,method] of [['claude','rebase'],['codex','squash']] as const) test(`${runtime} pr.merge merges at the head with the policy method, verifies and never replays`,async t=>{
  const s=setup(t,runtime,withMerge(method)), operationId=randomUUID();
  const result=await s.merge(operationId);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.operation,'pr.merge');assert.equal(result.status,'verified');
  assert.equal(result.prNumber,80);assert.equal(result.targetId,8000);assert.equal(result.mergeSha,MERGED);assert.equal(result.attribution,'bot-actor');
  assert.deepEqual(s.puts().map(c=>[c.url,c.body]),[['/repos/example/project/pulls/80/merge',{sha:HEAD,merge_method:method}]]);
  assert.deepEqual(s.api.calls.filter(c=>c.url.endsWith('/access_tokens')).map(c=>c.body.permissions),[{contents:'write'}]);
  assert.deepEqual(s.api.mutations().map(c=>c.method),['PUT']);
  assert.equal((await s.merge(operationId)).ok,true);assert.equal((await s.verify(operationId)).ok,true);
  assert.equal(s.puts().length,1);
});
test('preflight refuses an unmergeable, moved, foreign or non-default-base pull with no PUT and no receipt',async t=>{
  const fork={ref:'feat/m',sha:HEAD,repo:{full_name:'other/project'}};
  for (const pr of [{state:'closed'},{merged:true},{draft:true},{mergeable:null},{mergeable:false},{head:{...fork,sha:'c'.repeat(40),repo:{full_name:repository}}},
    {head:fork},{head:{ref:'feat/m',sha:HEAD,repo:null}},{base:{ref:'develop',repo:{full_name:repository}}}]) {
    const s=setup(t,'claude',withMerge('rebase'),pr), result=await s.merge();
    assert.equal(result.error,'target-refused',JSON.stringify(pr));assert.equal(s.puts().length,0);assert.deepEqual(s.receipts(),[]);
  }
});
test('a repository without a merge entry, or with an unknown method, refuses before any network call',async t=>{
  for (const edit of [()=>{},withMerge('fast-forward'),(p:Record<string,any>)=>{p.runtimes.claude.repositories[0].merge={method:'rebase',auto:true};}]) {
    const s=setup(t,'claude',edit), result=await s.merge();
    assert.equal(result.error,'policy-invalid');assert.equal(s.api.calls.length,0);assert.deepEqual(s.receipts(),[]);
  }
});
for (const status of [405,409]) test(`a PUT refused with ${status} is outcome-unknown; verify and a retry report verification-failed`,async t=>{
  const s=setup(t), operationId=randomUUID();s.api.control.mergeAnswer=status;
  assert.equal((await s.merge(operationId)).error,'outcome-unknown');
  assert.equal((await s.verify(operationId)).error,'verification-failed');
  assert.equal((await s.merge(operationId)).error,'verification-failed');
  assert.equal(s.puts().length,1);assert.equal(s.api.pulls.get(80).merged,false);
});
test('a lost PUT answer is outcome-unknown; verify and a retry settle it without a second PUT',async t=>{
  const s=setup(t), operationId=randomUUID();s.api.control.mergeAnswer='lost';
  const lost=await s.merge(operationId);assert.equal(lost.error,'outcome-unknown');assert.equal(lost.prNumber,80);
  const verified=await s.verify(operationId);assert.equal(verified.ok,true,JSON.stringify(verified));assert.equal(verified.mergeSha,undefined);
  assert.equal((await s.merge(operationId)).ok,true);assert.equal(s.puts().length,1);
});
test('readback refuses a merge by another actor or a pull that stayed unmerged',async t=>{
  const other=setup(t);other.api.control.mergedBy={id:999,login:'someone',type:'User'};
  assert.equal((await other.merge()).error,'verification-failed');
  const noop=setup(t);noop.api.control.mergeAnswer='noop';
  assert.equal((await noop.merge()).error,'verification-failed');
});
test('a pr.merge receipt admits a SHA-checked mergeSha and its pull kind only',t=>{
  const store=new ReceiptStore(setup(t).root,'claude',11,repository,randomUUID());
  const base={version:2 as const,kind:'pull' as const,digest:'0'.repeat(64),operation:'pr.merge' as const,status:'known' as const,fieldHashes:{},prNumber:80,targetId:8000,sha:HEAD};
  store.write({...base,mergeSha:MERGED});assert.equal(store.read()?.mergeSha,MERGED);
  for (const bad of [{mergeSha:MERGED.toUpperCase()},{mergeSha:'b'.repeat(39)},{kind:'push'},{targetId:undefined}]) {
    fs.writeFileSync(store.file,JSON.stringify({...base,...bad}),{mode:0o600});assert.throws(()=>store.read(),{message:'receipt-invalid'},JSON.stringify(bad));
  }
});
test('pr.merge refuses unknown fields and malformed targets before any network call',async t=>{
  const s=setup(t);
  for (const request of [{prNumber:80,sha:HEAD,method:'squash'},{prNumber:80,sha:HEAD,merge_method:'merge'},{prNumber:80},{sha:HEAD},{prNumber:80,sha:HEAD.toUpperCase()},{prNumber:0,sha:HEAD}]) {
    assert.equal((await s.send({operationId:randomUUID(),operation:'pr.merge',...request})).error,'invalid-request',JSON.stringify(request));
  }
  assert.equal(s.api.calls.length,0);
});
