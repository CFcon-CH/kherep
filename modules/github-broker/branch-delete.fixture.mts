// Test fixture only: a synthetic broker root and fake API with one closed, bot-authored
// pull request 80 whose head `feat/old` is still at HEAD. Nothing reaches the network.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BOTS, brokerRoot, fakeGithub } from './flow.fixture.mts';
import { run as claude } from './github-claude.mts';
import { run as codex } from './github-codex.mts';
type T = {after:(fn:()=>void)=>void};
export const repository = 'example/project', HEAD = 'a'.repeat(40), MAIN = 'c'.repeat(40), BRANCH = 'feat/old';
export const REF = `/repos/${repository}/git/refs/heads/${BRANCH}`;
export function setup(t:T, runtime:'claude'|'codex'='claude', edit:(p:Record<string,any>)=>void=()=>{}, pr:Record<string,unknown>={}) {
  const heads = new Map<string,string>([[BRANCH,HEAD],['main',MAIN]]);
  const root=brokerRoot(t,runtime,edit), api=fakeGithub(runtime,b=>heads.get(b)), run=runtime==='claude'?claude:codex, bot=BOTS[runtime==='claude'?0:1];
  api.pulls.set(80,{id:8000,number:80,state:'closed',merged:false,user:{id:bot.id,login:bot.login,type:'Bot'},
    base:{ref:'main',repo:{full_name:repository}},head:{ref:BRANCH,sha:HEAD,repo:{full_name:repository}},...pr});
  const deps={root,fetch:api.fetch};
  const send=(request:Record<string,unknown>)=>run(JSON.stringify({repository,...request}),deps);
  const remove=(operationId=randomUUID(),extra:Record<string,unknown>={})=>send({operationId,operation:'branch.delete',branch:BRANCH,sha:HEAD,prNumber:80,...extra});
  const verify=(operationId:string)=>send({operationId,operation:'verify'});
  const deletes=()=>api.calls.filter(c=>c.method==='DELETE');
  const receipts=()=>fs.readdirSync(path.join(root,'receipts')).filter(f=>f.endsWith('.json'));
  return {root,api,heads,deps,send,remove,verify,deletes,receipts};
}
