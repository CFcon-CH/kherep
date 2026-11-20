import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { branchDeleteHandler } from './branch-delete.mts';
import { ABSENT } from './transport.mts';
import { BOTS, stubWindowsAcl } from './flow.fixture.mts';
import { BRANCH, HEAD, repository, setup } from './branch-delete.fixture.mts';
stubWindowsAcl();
type S = ReturnType<typeof setup>;
const OTHER = 'd'.repeat(40);
const pull = (n:number, extra:Record<string,unknown>={}) => ({id:8000+n,number:n,state:'closed',user:{id:BOTS[0].id,login:BOTS[0].login,type:'Bot'},
  base:{ref:'main',repo:{full_name:repository}},head:{ref:BRANCH,sha:HEAD,repo:{full_name:repository}},...extra});
// Each case: a change to the fake GitHub (or the request) and the one fixed reason it must produce.
const cases:[string,string,(s:S)=>Record<string,unknown>|void][] = [
  ['default-branch','the default branch',()=>({branch:'main'})],
  ['pull-list-incomplete','a head list of thirty pulls',s=>{ for (let n=81;n<110;n++) s.api.pulls.set(n,pull(n)); }],
  ['open-pull-request','a second, open pull on the same head',s=>{ s.api.pulls.set(81,pull(81,{state:'open'})); }],
  ['open-pull-request','an open pull on the same head from a fork',s=>{ s.api.pulls.set(81,pull(81,{state:'open',head:{ref:BRANCH,sha:OTHER,repo:{full_name:'other/project'}}})); }],
  ['pull-not-found','a prNumber that is not in the list',()=>({prNumber:81})],
  ['pull-not-found','a pull of another branch',s=>{ s.api.pulls.set(81,pull(81,{head:{ref:'feat/other',sha:HEAD,repo:{full_name:repository}}})); return {prNumber:81}; }],
  ['open-pull-request','the named pull itself is open',s=>{ s.api.pulls.get(80).state='open'; }],
  ['pull-not-closed','the named pull without a closed state',s=>{ delete s.api.pulls.get(80).state; }],
  ['foreign-head','a head in a fork',s=>{ s.api.pulls.get(80).head.repo={full_name:'other/project'}; }],
  ['foreign-head','a head whose repository is gone',s=>{ s.api.pulls.get(80).head.repo=null; }],
  ['pull-head-mismatch','a pull head at another sha',s=>{ s.api.pulls.get(80).head.sha=OTHER; }],
  ['foreign-author','a pull authored by a user',s=>{ s.api.pulls.get(80).user={id:999,login:'someone',type:'User'}; }],
  ['foreign-author','a pull authored by a bot this runtime may not act for',s=>{ s.api.pulls.get(80).user={id:BOTS[1].id,login:BOTS[1].login,type:'Bot'}; }],
  ['foreign-author','a user with a configured bot ID',s=>{ s.api.pulls.get(80).user={id:BOTS[0].id,login:BOTS[0].login,type:'User'}; }],
  ['open-base-pull-request','an open pull based on the branch',s=>{ s.api.pulls.set(81,pull(81,{state:'open',base:{ref:BRANCH,repo:{full_name:repository}},head:{ref:'feat/next',sha:OTHER,repo:{full_name:repository}}})); }],
  ['branch-rules','an active deletion rule',s=>{ s.api.control.rules=[{type:'deletion'}]; }],
  ['pull-ref-mismatch','a pull ref at another sha',s=>{ s.api.control.pullRefs.set(80,OTHER); }],
  ['pull-ref-mismatch','a missing pull ref',s=>{ s.api.control.pullRefs.set(80,null); }],
  ['protected-branch','a protected branch',s=>{ s.api.control.protectedBranch=true; }],
  ['protected-branch','a branch without a protected flag',s=>{ s.api.control.protectedBranch=undefined; }],
  ['head-moved','a branch head that moved after the pull closed',s=>{ s.heads.set(BRANCH,OTHER); }],
];
for (const [reason,name,arrange] of cases) test(`refuses ${name} with ${reason}, no DELETE and no receipt`,async t=>{
  const s=setup(t), extra=arrange(s) ?? {};
  const result=await s.remove(randomUUID(),extra);
  assert.equal(result.ok,false);assert.equal(result.error,'target-refused',JSON.stringify(result));assert.equal(result.reason,reason);
  assert.equal(result.result,undefined);assert.equal(s.deletes().length,0);assert.deepEqual(s.receipts(),[]);
});
test('a pull of another configured bot is accepted when the policy allows that author',async t=>{
  const s=setup(t,'codex',p=>{p.runtimes.codex.allowedAuthorBotIds=[BOTS[1].id,BOTS[0].id];},{user:{id:BOTS[0].id,login:BOTS[0].login,type:'Bot'}});
  const result=await s.remove();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result,'deleted');
});
test('a merged closed pull is accepted',async t=>{
  const s=setup(t,'claude',()=>{},{merged:true});
  assert.equal((await s.remove()).result,'deleted');
});
test('a refusal is reported with the fixed reason and nothing else new',async t=>{
  const s=setup(t), operationId=randomUUID();s.api.control.rules=[{type:'deletion'}];
  const result=await s.remove(operationId);
  assert.deepEqual(result,{ok:false,error:'target-refused',reason:'branch-rules',operationId,runtime:'claude',repository,operation:'branch.delete'});
  s.api.control.rules=[];
  assert.equal((await s.remove(operationId)).result,'deleted');
});
// Direct handler calls: a malformed answer gets a fixed reason, never a guess.
const GOOD:Record<string,unknown> = {
  head:{items:[pull(80)]}, base:{items:[]}, rules:{items:[]}, ref:{ref:'refs/pull/80/head',object:{type:'commit',sha:HEAD}},
  branch:{name:BRANCH,protected:false,commit:{sha:HEAD}},
};
function context(answers:Record<string,unknown>, target:Record<string,unknown>={default_branch:'main'}) {
  const all={...GOOD,...answers}, calls:string[]=[];
  const http=async(method:string, endpoint:string)=>{
    calls.push(`${method} ${endpoint}`);
    const key=endpoint.includes('head=')?'head':endpoint.includes('base=')?'base':endpoint.includes('/rules/')?'rules':endpoint.includes('/git/ref/pull/')?'ref':'branch';
    return all[key];
  };
  return {calls,c:{http,token:'t',target,request:{operationId:randomUUID(),repository,operation:'branch.delete',branch:BRANCH,sha:HEAD,prNumber:80},
    identity:{botId:BOTS[0].id,botLogin:BOTS[0].login,authorEmails:[`${BOTS[0].id}+${BOTS[0].login}@users.noreply.github.com`],repositories:[{slug:repository,id:55}]},repo:{slug:repository,id:55}} as any};
}
const refusal = (reason:string) => ({message:'target-refused',reason});
test('the handler admits the well-formed answers and returns the receipt fields',async()=>{
  assert.deepEqual(await branchDeleteHandler.preflight(context({}).c),{branch:BRANCH,sha:HEAD,prNumber:80,targetId:8080});
  assert.deepEqual(await branchDeleteHandler.preflight(context({branch:ABSENT}).c),{branch:BRANCH,sha:HEAD,prNumber:80,targetId:8080,result:'absent'});
});
const malformed:[string,Record<string,unknown>,Record<string,unknown>?][] = [
  ['unexpected-answer',{},{}],
  ['unexpected-answer',{},{default_branch:'-x'}],
  ['pull-list-incomplete',{head:{}}],
  ['pull-list-incomplete',{head:{items:{}}}],
  ['unexpected-answer',{head:{items:[pull(80),null]}}],
  ['unexpected-answer',{head:{items:[pull(80),{number:81,state:'closed'}]}}],
  ['unexpected-answer',{head:{items:[pull(80,{id:0})]}}],
  ['unexpected-answer',{head:{items:[pull(80,{base:{ref:'main',repo:{full_name:'other/project'}}})]}}],
  ['unexpected-answer',{base:{}}],
  ['unexpected-answer',{rules:{items:'none'}}],
  ['pull-ref-mismatch',{ref:ABSENT}],
  ['pull-ref-mismatch',{ref:{ref:'refs/pull/81/head',object:{type:'commit',sha:HEAD}}}],
  ['pull-ref-mismatch',{ref:{ref:'refs/pull/80/head',object:{type:'tag',sha:HEAD}}}],
  ['unexpected-answer',{branch:{name:'feat/other',protected:false,commit:{sha:HEAD}}}],
  ['unexpected-answer',{branch:{name:BRANCH,protected:false}}],
  ['unexpected-answer',{branch:{name:BRANCH,protected:false,commit:{sha:42}}}],
];
for (const [reason,answers,target] of malformed) test(`a malformed answer ${JSON.stringify(answers)} ${JSON.stringify(target ?? {})} is ${reason}`,async()=>{
  await assert.rejects(()=>branchDeleteHandler.preflight(context(answers,target).c),refusal(reason));
});
test('the branch read is the last read; nothing is read after a refusal',async()=>{
  const ok=context({});await branchDeleteHandler.preflight(ok.c);
  assert.match(ok.calls.at(-1)!,new RegExp(`^GET /repos/${repository}/branches/${BRANCH}$`));assert.equal(ok.calls.length,5);
  const refused=context({rules:{items:[{type:'deletion'}]}});
  await assert.rejects(()=>branchDeleteHandler.preflight(refused.c),refusal('branch-rules'));assert.equal(refused.calls.length,3);
});
