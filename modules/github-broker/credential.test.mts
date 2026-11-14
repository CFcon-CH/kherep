import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PUSH_WINDOW_MS } from './credential.mts';
import { ReceiptStore } from './receipt.mts';
import type { Receipt } from './receipt.mts';
import { TOKEN, brokerRoot, fakeGithub, stubWindowsAcl } from './flow.fixture.mts';
import { run as claude } from './github-claude-credential.mts';
import { run as codex } from './github-codex-credential.mts';
stubWindowsAcl();
type T = {after:(fn:()=>void)=>void};
const input = 'capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=github.com\npath=example/project.git\nwwwauth[]=Basic realm="GitHub"\n';
function pending(t:T, runtime:'claude'|'codex', receipt:Partial<Receipt>={}, lock=true) {
  const root=brokerRoot(t,runtime),id=randomUUID(),now=Date.now();
  const store=new ReceiptStore(root,runtime,runtime==='claude'?11:12,'example/project',id);
  store.write({version:2,kind:'push',digest:'0'.repeat(64),operation:'branch.push',status:'pending',fieldHashes:{},branch:'feat/x',sha:'a'.repeat(40),admittedAt:now,...receipt} as Receipt);
  if (lock) store.acquire();
  return {root,id,now};
}
for (const [runtime,run] of [['claude',claude],['codex',codex]] as const) test(`${runtime} helper answers get only for its locked, fresh, pending push`,async t=>{
  const p=pending(t,runtime),api=fakeGithub(runtime);
  const out=await run([p.id,'get'],input,{root:p.root,fetch:api.fetch,now:()=>p.now+1000});
  assert.equal(out,`username=x-access-token\npassword=${TOKEN}\n`);
  const exchange=api.calls.find(c=>c.url.endsWith('/access_tokens'));
  assert.deepEqual(exchange?.body,{repository_ids:[55],permissions:{contents:'write'}});
  assert.equal(api.calls.length<=10,true);
  for (const action of ['store','erase']) assert.equal(await run([p.id,action],`${input}username=x-access-token\npassword=${TOKEN}\n`,{root:p.root,fetch:api.fetch}),'');
});
test('helper refuses wrong argv, host, protocol, path and repository without a provider call',async t=>{
  const p=pending(t,'claude'),api=fakeGithub('claude'),deps={root:p.root,fetch:api.fetch,now:()=>p.now};
  for (const argv of [[],[p.id],['get'],[p.id,'get','extra'],['not-a-uuid','get'],[p.id,'--get']]) await assert.rejects(claude(argv,input,deps),{message:'invalid-request'},JSON.stringify(argv));
  for (const bad of [input.replace('https','http'),input.replace('github.com','example.com'),input.replace('project.git','project'),input.replace('path=example/project.git\n',''),input.replace('example/project','example/../x')]) await assert.rejects(claude([p.id,'get'],bad,deps),{message:'target-refused'});
  for (const bad of [`${input}username=someone\n`,`${input}protocol=https\n`,'garbage\n','x'.repeat(5000)]) await assert.rejects(claude([p.id,'get'],bad,deps),{message:'invalid-request'});
  await assert.rejects(claude([p.id,'get'],input.replace('example/project','other/project'),deps),{message:'policy-invalid'});
  assert.equal(api.calls.length,0);
});
test('helper refuses a missing, stale, future, unlocked, settled or foreign receipt',async t=>{
  const api=fakeGithub('claude');
  const cases:[string,(t:T)=>{root:string;id:string;now:number},number][]=[
    ['stale',t=>pending(t,'claude'),PUSH_WINDOW_MS+1],
    ['future',t=>pending(t,'claude'),-6000],
    ['unlocked',t=>pending(t,'claude',{},false),0],
    ['known',t=>pending(t,'claude',{status:'known'}),0],
    ['other operation',t=>pending(t,'claude',{operation:'pr.create',kind:'pull',branch:undefined,sha:undefined,admittedAt:undefined}),0],
    ['missing',t=>({...pending(t,'claude'),id:randomUUID()}),0],
  ];
  for (const [name,make,skew] of cases) {
    const p=make(t);
    await assert.rejects(claude([p.id,'get'],input,{root:p.root,fetch:api.fetch,now:()=>p.now+skew}),{message:'auth-refused'},name);
  }
  // The other runtime's helper never answers this runtime's push.
  const p=pending(t,'claude');
  await assert.rejects(codex([p.id,'get'],input,{root:p.root,fetch:fakeGithub('codex').fetch,now:()=>p.now}));
  assert.equal(api.calls.length,0);
});
test('helper entry point is silent with exit 1 on refusal and prints nothing for store',()=>{
  const entry=path.join(import.meta.dirname,'github-claude-credential.mts'),id=randomUUID();
  const call=(args:string[])=>spawnSync(process.execPath,[entry,...args],{input,encoding:'utf8',windowsHide:true,timeout:10000,env:{PATH:process.env.PATH}});
  for (const args of [[],['get'],[id,'get','x'],['bad','get']]) {const r=call(args);assert.equal(r.status,1);assert.equal(r.stdout,'');}
  const stored=call([id,'store']);assert.equal(stored.status,0);assert.equal(stored.stdout,'');
});
