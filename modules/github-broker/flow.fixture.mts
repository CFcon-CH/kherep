// Test fixture only: a synthetic broker root, a version 2 policy and an injected
// GitHub API. Nothing here reaches the network or a real key, policy or token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { generateKeyPairSync, verify } from 'node:crypto';
export const TOKEN = 'synthetic-memory-only';
export const pair = generateKeyPairSync('rsa',{modulusLength:2048});
const key = pair.privateKey.export({type:'pkcs8',format:'pem'});
/**
 * On Windows the private-tree ACL check needs a natively provisioned directory,
 * which a temporary test root is not. Tests there replace only the fixed
 * PowerShell probe with a passing answer, so the flow runs; that is control-flow
 * evidence, never ACL evidence. POSIX runs keep the real mode checks.
 */
export function stubWindowsAcl():void {
  if (process.platform!=='win32') return;
  const original=childProcess.spawnSync;
  childProcess.spawnSync=((command:string,...rest:unknown[])=>/powershell\.exe$/i.test(String(command))
    ? {status:0,signal:null,stdout:'ok',stderr:'',pid:0,output:[]}
    : Reflect.apply(original,childProcess,[command,...rest])) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
}
export const BOTS = [{id:33,login:'synthetic0[bot]'},{id:34,login:'synthetic1[bot]'}];
export const email = (i:number) => `${BOTS[i].id}+${BOTS[i].login}@users.noreply.github.com`;
type T = {after:(fn:()=>void)=>void};
export function brokerRoot(t:T, selected:'claude'|'codex', edit:(policy:Record<string,any>)=>void=()=>{}):string {
  // The Windows path check also requires the private root's canonical name.
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-flow-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'.kherep','github-broker');
  for (const dir of ['keys','receipts']) fs.mkdirSync(path.join(root,dir),{recursive:true,mode:0o700});
  for (const dir of [path.join(base,'.kherep'),root]) fs.chmodSync(dir,0o700);
  const runtimes=Object.fromEntries(['claude','codex'].map((runtime,i)=>[runtime,{appId:11+i,clientId:`Iv.synthetic${i}`,botId:BOTS[i].id,botLogin:BOTS[i].login,installationId:44+i,keyRef:`synthetic${i}.pem`,
    operations:['issue.create','branch.push','pr.create','pr.update','pr.comment','run.rerun','run.cancel','pr.merge'],repositories:[{slug:'example/project',id:55}]}]));
  const policy={version:2,enabled:true,runtimes};edit(policy);
  fs.writeFileSync(path.join(root,'policy.json'),JSON.stringify(policy),{mode:0o600});
  fs.writeFileSync(path.join(root,'keys',runtimes[selected].keyRef),key,{mode:0o600});
  return root;
}
export type Call = {method:string; url:string; body:any; auth:string};
export const MERGED = 'b'.repeat(40);
/**
 * A fake api.github.com: identity endpoints plus pulls, comments, runs, refs and the
 * merge PUT. `mergeAnswer` 'ok' merges and answers; 'lost' merges and then drops the
 * answer; 'noop' answers without merging; a status refuses without merging.
 */
export function fakeGithub(selected:'claude'|'codex', refs:(branch:string)=>string|undefined=()=>undefined) {
  const bot=BOTS[selected==='claude'?0:1], appId=selected==='claude'?11:12, installationId=selected==='claude'?44:45;
  const calls:Call[]=[], all={actions:'write',checks:'read',contents:'write',issues:'write',metadata:'read',pull_requests:'write',workflows:'write'};
  const control={extraScope:false,wrongAuthor:false,dropLabels:false,runStatus:'completed',attemptAfter:2,conclusion:'cancelled',actorId:bot.id,
    mergeAnswer:'ok' as 'ok'|'lost'|'noop'|number,mergedBy:undefined as unknown};
  const user={id:bot.id,login:bot.login,type:'Bot'};
  const pulls=new Map<number,any>(), comments=new Map<number,any>();
  const run={id:9001,run_attempt:1,status:'completed',conclusion:'failure',repository:{id:55,full_name:'example/project'},triggering_actor:{id:1,login:'someone',type:'User'}};
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
  const fetcher:typeof fetch=async(url,init)=>{
    const u=new URL(String(url)),endpoint=u.pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;
    const auth=(init?.headers as Record<string,string>).Authorization.slice(7);
    calls.push({method,url:endpoint,body,auth});assert.equal(u.origin,'https://api.github.com');
    if (endpoint==='/app') {
      const [a,b,c]=auth.split('.');assert.equal(verify('RSA-SHA256',Buffer.from(`${a}.${b}`),pair.publicKey,Buffer.from(c,'base64url')),true);
      return json({id:appId,client_id:`Iv.synthetic${appId-11}`,slug:bot.login.slice(0,-5),permissions:all});
    }
    if (endpoint.endsWith('/installation')) return json({id:installationId,app_id:appId,suspended_at:null,permissions:all});
    if (endpoint.endsWith('/access_tokens')) return json({token:TOKEN,expires_at:new Date(Date.now()+600000).toISOString(),permissions:{...body.permissions,metadata:'read',...(control.extraScope?{workflows:'write'}:{})},repository_selection:'selected'});
    assert.equal(auth,TOKEN);
    if (endpoint.startsWith('/users/')) return json(user);
    const repo='/repos/example/project';
    if (endpoint===repo) return json({id:55,full_name:'example/project',private:false,default_branch:'main'});
    const ref=/^\/repos\/example\/project\/git\/ref\/heads\/(.+)$/.exec(endpoint);
    if (ref) { const sha=refs(ref[1]); return sha?json({ref:`refs/heads/${ref[1]}`,object:{type:'commit',sha}}):json({message:'Not Found'},404); }
    if (endpoint===`${repo}/pulls` && method==='POST') {
      const pr={id:7100+pulls.size,number:70+pulls.size,title:body.title,body:body.body??null,state:'open',draft:body.draft??false,labels:[],base:{ref:body.base,repo:{full_name:'example/project'}},head:{ref:body.head,repo:{full_name:'example/project'}},user:control.wrongAuthor?{id:999,login:'someone',type:'User'}:user};
      pulls.set(pr.number,pr);return json(pr,201);
    }
    const merge=/^\/repos\/example\/project\/pulls\/(\d+)\/merge$/.exec(endpoint);
    if (merge && method==='PUT') {
      const pr=pulls.get(Number(merge[1])),answer=control.mergeAnswer;
      if (!pr) return json({message:'Not Found'},404);
      if (typeof answer==='number') return json({message:'synthetic refusal'},answer);
      if (answer!=='noop') Object.assign(pr,{state:'closed',merged:true,merged_by:control.mergedBy??user,merge_commit_sha:MERGED});
      if (answer==='lost') throw new Error('synthetic lost answer');
      return json({sha:MERGED,merged:answer!=='noop',message:'synthetic'});
    }
    const pull=/^\/repos\/example\/project\/(?:pulls|issues)\/(\d+)$/.exec(endpoint);
    if (pull) {
      const pr=pulls.get(Number(pull[1]));if (!pr) return json({message:'Not Found'},404);
      if (method==='PATCH') {
        if (body.labels) pr.labels=control.dropLabels?[]:[...body.labels].reverse().map((name:string,i:number)=>({id:i,name}));
        for (const k of ['title','body','state']) if (body[k]!==undefined) pr[k]=body[k];
        if (body.base) pr.base={...pr.base,ref:body.base};
      }
      return json(pr);
    }
    const comment=/^\/repos\/example\/project\/issues\/(\d+)\/comments$/.exec(endpoint);
    if (comment) { const c={id:8100+comments.size,body:body.body,issue_url:`https://api.github.com${repo}/issues/${comment[1]}`,user};comments.set(c.id,c);return json(c,201); }
    const read=/^\/repos\/example\/project\/issues\/comments\/(\d+)$/.exec(endpoint);
    if (read) return json(comments.get(Number(read[1])));
    if (endpoint===`${repo}/actions/runs/9001`) return json({...run,status:control.runStatus});
    if (/\/actions\/runs\/9001\/(rerun|rerun-failed-jobs)$/.test(endpoint)) { Object.assign(run,{run_attempt:control.attemptAfter,status:'queued',triggering_actor:{id:control.actorId,login:bot.login,type:'Bot'}});return new Response(null,{status:201}); }
    if (endpoint.endsWith('/actions/runs/9001/cancel')) { Object.assign(run,{status:'completed',conclusion:control.conclusion});return new Response(null,{status:202}); }
    return json({message:'Not Found'},404);
  };
  return {fetch:fetcher,calls,control,pulls,comments,mutations:()=>calls.filter(c=>c.method!=='GET'&&!c.url.endsWith('/access_tokens'))};
}
