import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BOTS, TOKEN, brokerRoot, fakeGithub, stubWindowsAcl } from './flow.fixture.mts';
import { permissionsFor } from './operations.mts';
import { run as claude } from './github-claude.mts';
import { run as codex } from './github-codex.mts';
stubWindowsAcl();
type T = {after:(fn:()=>void)=>void};
const repository = 'example/project';
function setup(t:T, runtime:'claude'|'codex'='claude', edit?:(p:Record<string,any>)=>void) {
  const root=brokerRoot(t,runtime,edit),api=fakeGithub(runtime),run=runtime==='claude'?claude:codex;
  const call=(request:Record<string,unknown>)=>run(JSON.stringify({operationId:randomUUID(),repository,...request}),{root,fetch:api.fetch});
  return {root,api,run,call,deps:{root,fetch:api.fetch}};
}
const tokenScope = (api:ReturnType<typeof fakeGithub>) => api.calls.filter(c=>c.url.endsWith('/access_tokens')).map(c=>c.body.permissions);
test('permission map requests exactly one scope set per operation',()=>{
  assert.deepEqual(permissionsFor('issue.comment',false),{issues:'write'});
  assert.deepEqual(permissionsFor('branch.push',false),{contents:'write'});
  assert.deepEqual(permissionsFor('pr.create',false),{pull_requests:'write'});
  assert.deepEqual(permissionsFor('pr.create',true),{pull_requests:'write',issues:'write'});
  for (const op of ['pr.update','pr.comment'] as const) assert.deepEqual(permissionsFor(op,true),{pull_requests:'write'});
  for (const op of ['run.rerun','run.cancel'] as const) assert.deepEqual(permissionsFor(op,false),{actions:'write'});
});
for (const runtime of ['claude','codex'] as const) test(`${runtime} identity returns the bot commit identity without key or network`,async t=>{
  const s=setup(t,runtime);fs.rmSync(path.join(s.root,'keys'),{recursive:true});
  const result=await s.call({operation:'identity'});const bot=BOTS[runtime==='claude'?0:1];
  assert.equal(result.ok,true);assert.equal(result.name,bot.login);assert.equal(result.email,`${bot.id}+${bot.login}@users.noreply.github.com`);
  assert.equal(s.api.calls.length,0);assert.deepEqual(fs.readdirSync(path.join(s.root,'receipts')),[]);
});
test('pr.create opens a bot-authored PR, labels it, verifies and never replays',async t=>{
  const s=setup(t),operationId=randomUUID(),request={operationId,repository,operation:'pr.create',head:'feat/x',base:'main',title:'Synthetic',body:'Body',draft:true,labels:['b','a']};
  const result=await s.run(JSON.stringify(request),s.deps);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.operation,'pr.create');assert.equal(result.prNumber,70);assert.equal(result.attribution,'bot-author');
  assert.deepEqual(tokenScope(s.api),[{pull_requests:'write',issues:'write'}]);
  assert.deepEqual(s.api.mutations().map(c=>[c.method,c.url]),[['POST','/repos/example/project/pulls'],['PATCH','/repos/example/project/issues/70']]);
  assert.deepEqual(s.api.mutations()[0].body,{title:'Synthetic',head:'feat/x',base:'main',body:'Body',draft:true});
  assert.equal((await s.run(JSON.stringify(request),s.deps)).ok,true);assert.equal(s.api.mutations().length,2);
  assert.equal((await s.run(JSON.stringify({operationId,repository,operation:'verify'}),s.deps)).ok,true);assert.equal(s.api.mutations().length,2);
  assert.equal((await s.run(JSON.stringify({...request,title:'Other'}),s.deps)).error,'operation-conflict');
  const disk=fs.readdirSync(path.join(s.root,'receipts')).map(n=>fs.readFileSync(path.join(s.root,'receipts',n),'utf8')).join('');
  for (const secret of [TOKEN,'Synthetic','Body']) assert.equal(disk.includes(secret),false);
});
test('pr.create without labels needs only pull_requests and refuses a foreign author or dropped labels',async t=>{
  const s=setup(t);
  assert.equal((await s.call({operation:'pr.create',head:'feat/x',base:'main',title:'T'})).ok,true);assert.deepEqual(tokenScope(s.api),[{pull_requests:'write'}]);
  s.api.control.wrongAuthor=true;const foreign=await s.call({operation:'pr.create',head:'feat/y',base:'main',title:'T'});
  assert.equal(foreign.error,'verification-failed');assert.equal(foreign.prNumber,71);
  s.api.control.wrongAuthor=false;s.api.control.dropLabels=true;assert.equal((await s.call({operation:'pr.create',head:'feat/z',base:'main',title:'T',labels:['a']})).error,'verification-failed');
});
test('pr.update and pr.comment act on an existing PR of the repository only',async t=>{
  const s=setup(t);await s.call({operation:'pr.create',head:'feat/x',base:'main',title:'T'});
  const updated=await s.call({operation:'pr.update',prNumber:70,title:'Changed',state:'closed'});
  assert.equal(updated.ok,true,JSON.stringify(updated));assert.equal(updated.attribution,'authenticated-installation');assert.equal(s.api.pulls.get(70).state,'closed');
  const comment=await s.call({operation:'pr.comment',prNumber:70,body:'Hello'});
  assert.equal(comment.ok,true);assert.equal(comment.targetId,8100);assert.equal(comment.attribution,'bot-author');
  const before=s.api.mutations().length;
  for (const request of [{operation:'pr.update',prNumber:99,title:'x'},{operation:'pr.comment',prNumber:99,body:'x'}]) {
    const r=await s.call(request);assert.equal(r.ok,false);
  }
  assert.equal(s.api.mutations().length,before);
  assert.ok(tokenScope(s.api).every(p=>JSON.stringify(p)==='{"pull_requests":"write"}'));
});
test('run.rerun and run.cancel use actions scope, check state first and verify the effect',async t=>{
  const s=setup(t);
  const rerun=await s.call({operation:'run.rerun',runId:9001,failedOnly:true});
  assert.equal(rerun.ok,true,JSON.stringify(rerun));assert.equal(rerun.attribution,'bot-actor');assert.equal(rerun.attempt,1);
  assert.equal(s.api.mutations()[0].url,'/repos/example/project/actions/runs/9001/rerun-failed-jobs');
  assert.deepEqual(tokenScope(s.api),[{actions:'write'}]);
  s.api.control.runStatus='in_progress';
  assert.equal((await s.call({operation:'run.rerun',runId:9001})).error,'target-refused');
  const cancel=await s.call({operation:'run.cancel',runId:9001});assert.equal(cancel.ok,true,JSON.stringify(cancel));
  s.api.control.conclusion='success';assert.equal((await s.call({operation:'run.cancel',runId:9001})).error,'verification-failed');
  s.api.control.runStatus='completed';assert.equal((await s.call({operation:'run.cancel',runId:9001})).error,'target-refused');
  s.api.control.attemptAfter=3;s.api.control.actorId=999;assert.equal((await s.call({operation:'run.rerun',runId:9001})).error,'verification-failed');
});
test('run.rerun settles a lagging attempt readback as outcome-unknown and a later verify confirms it',async t=>{
  const s=setup(t),operationId=randomUUID(),bot=BOTS[0];
  // GitHub still shows the pre-rerun attempt right after the POST; the actor is not yet the bot either.
  s.api.control.attemptAfter=1;s.api.control.actorId=999;
  const lagging=await s.run(JSON.stringify({operationId,repository,operation:'run.rerun',runId:9001}),s.deps);
  assert.equal(lagging.error,'outcome-unknown',JSON.stringify(lagging));assert.equal(lagging.runId,9001);assert.equal(lagging.attempt,1);
  assert.equal(s.api.mutations().length,1);
  Object.assign(s.api.run,{run_attempt:2,triggering_actor:{id:bot.id,login:bot.login,type:'Bot'}});
  const settled=await s.run(JSON.stringify({operationId,repository,operation:'verify'}),s.deps);
  assert.equal(settled.ok,true,JSON.stringify(settled));assert.equal(settled.status,'verified');assert.equal(settled.attribution,'bot-actor');
  assert.equal(s.api.mutations().length,1);
});
test('a token carrying an extra permission is refused before any mutation',async t=>{
  const s=setup(t);s.api.control.extraScope=true;
  for (const request of [{operation:'pr.create',head:'feat/x',base:'main',title:'T'},{operation:'run.rerun',runId:9001}]) assert.equal((await s.call(request)).error,'auth-refused');
  assert.equal(s.api.mutations().length,0);
});
test('policy v1 keeps issue operations and refuses the new operations; v2 checks allowed author bots',async t=>{
  const v1=setup(t,'claude',p=>{p.version=1;for (const r of Object.values(p.runtimes) as any[]) r.operations=['issue.create'];});
  for (const operation of ['identity','pr.create']) assert.equal((await v1.call({operation,head:'feat/x',base:'main',title:'T'})).ok,false);
  for (const bad of [[999],[33,33],[],'33']) {
    const s=setup(t,'claude',p=>{p.runtimes.claude.allowedAuthorBotIds=bad;});
    assert.equal((await s.call({operation:'identity'})).error,'policy-invalid',JSON.stringify(bad));
  }
  const listed=setup(t,'claude',p=>{p.runtimes.claude.operations=['issue.create'];});
  assert.equal((await listed.call({operation:'pr.comment',prNumber:1,body:'x'})).error,'policy-invalid');
  assert.equal(v1.api.calls.length+listed.api.calls.length,0);
});
test('contract refuses unknown fields and malformed targets of the new operations',async t=>{
  const s=setup(t);
  for (const request of [
    {operation:'branch.push',branch:'feat/x'},{operation:'branch.push',branch:'feat/x',sha:'A'.repeat(40)},{operation:'branch.push',branch:'-x',sha:'a'.repeat(40)},
    {operation:'branch.push',branch:'a..b',sha:'a'.repeat(40)},{operation:'branch.push',branch:'x',sha:'a'.repeat(40),force:true},
    {operation:'pr.create',head:'feat/x',base:'main'},{operation:'pr.create',head:'owner:feat',base:'main',title:'T'},{operation:'pr.create',head:'feat/x',base:'main',title:'T',draft:'yes'},
    {operation:'pr.update',prNumber:1},{operation:'pr.update',prNumber:1,state:'merged'},{operation:'pr.update',prNumber:1,stateReason:'completed'},
    {operation:'pr.comment',prNumber:0,body:'x'},{operation:'run.rerun'},{operation:'run.cancel',runId:1,failedOnly:true},{operation:'pr.merge',prNumber:1},
  ]) assert.equal((await s.call(request)).error,'invalid-request',JSON.stringify(request));
  assert.equal(s.api.calls.length,0);
});
