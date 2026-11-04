import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { jwt, authenticate } from './auth.mts';
import { transport } from './transport.mts';
import { canonicalRoot, validatePolicy } from './config.mts';
import { readProtected } from './key-access.mts';
import { ReceiptStore } from './receipt.mts';
const pair = generateKeyPairSync('rsa',{modulusLength:2048});
const key = Buffer.from(pair.privateKey.export({format:'pem',type:'pkcs8'}));
const now = Date.now();
const identity = {appId:11,clientId:'Iv.synthetic',botId:33,botLogin:'synthetic[bot]',installationId:44,keyRef:'synthetic.pem',operations:['issue.create','issue.comment','issue.update'] as const,repositories:[{slug:'example/project',id:55}]};
const request = {operationId:'550e8400-e29b-41d4-a716-446655440000', repository:'example/project',operation:'issue.create' as const,title:'Synthetic'};
function temp(t: {after:(fn:()=>void)=>void}) { const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-security-'))); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
test('RS256 signature and bounded claims are real',()=> {
  const token=jwt(key,identity.clientId,now), [header,body,signature]=token.split('.');
  assert.equal(verify('RSA-SHA256',Buffer.from(`${header}.${body}`),pair.publicKey,Buffer.from(signature,'base64url')),true);
  const claims=JSON.parse(Buffer.from(body,'base64url').toString()); assert.equal(claims.iss,identity.clientId); assert.equal(claims.exp-claims.iat,360);
});
test('policy identities, scope and overrides fail closed',()=> {
  const policy={version:1,enabled:true,runtimes:{claude:identity}};
  assert.equal(validatePolicy(policy,'claude',request).appId,11);
  for (const bad of [{...policy,approved:true},{...policy,runtimes:{claude:identity,codex:identity}},{...policy,runtimes:{claude:{...identity,repositories:[{slug:'other/project',id:55}]}}}]) assert.throws(()=>validatePolicy(bad,'claude',request));
  assert.throws(()=>validatePolicy(policy,'codex',request));
});
test('transport fixes origin, version, redirect and bounds with fixed errors',async()=> {
  let count=0;
  const http=transport(async(url,init)=>{count++; assert.equal(url,'https://api.github.com/app');assert.equal(init?.redirect,'error');assert.equal((init?.headers as Record<string,string>)['X-GitHub-Api-Version'],'2026-03-10');return new Response('{"id":1}');});
  assert.deepEqual(await http('GET','/app','synthetic'),{id:1}); assert.equal(count,1);
  for (const status of [301,401,403,404,422,429,503]) await assert.rejects(transport(async()=>new Response('private-canary',{status}))('GET','/app','synthetic'),{message:'transport-failed'});
  for (const body of ['{','x'.repeat(1048577)]) await assert.rejects(transport(async()=>new Response(body))('GET','/app','synthetic'),{message:'transport-failed'});
  await assert.rejects(transport(async()=>{throw new Error('private-canary');})('GET','/app','synthetic'),{message:'transport-failed'});
});
test('authentication downscopes exactly and rejects wrong identity before token exchange',async()=> {
  const calls:unknown[][]=[];
  const http = async (...args:unknown[])=>{calls.push(args);return [{id:11,client_id:'Iv.synthetic',slug:'synthetic',permissions:{issues:'write'}},{id:44,app_id:11,suspended_at:null,permissions:{issues:'write'}},{token:'synthetic-token',expires_at:new Date(now+60000).toISOString(),permissions:{issues:'write',metadata:'read'}},{id:33,login:'synthetic[bot]',type:'Bot'},{id:55,full_name:'example/project',private:false}][calls.length-1];};
  assert.equal(await authenticate(http,key,{...identity,operations:[...identity.operations]},identity.repositories[0],now),'synthetic-token');
  assert.deepEqual(calls[2][3],{repository_ids:[55],permissions:{issues:'write'}});
  for (const app of [{id:12,client_id:'Iv.synthetic',permissions:{issues:'write'}},{id:11,client_id:'wrong',permissions:{issues:'write'}},{id:11,client_id:'Iv.synthetic',permissions:{issues:'read'}}]) await assert.rejects(authenticate(async()=>app,key,{...identity,operations:[...identity.operations]},identity.repositories[0],now),{message:'auth-refused'});
});
test('authentication accepts the dotted installation-token format and still refuses other characters',async()=> {
  const answers=(token:string)=>{const calls:unknown[][]=[];return async (...args:unknown[])=>{calls.push(args);return [{id:11,client_id:'Iv.synthetic',slug:'synthetic',permissions:{issues:'write'}},{id:44,app_id:11,suspended_at:null,permissions:{issues:'write'}},{token,expires_at:new Date(now+60000).toISOString(),permissions:{issues:'write',metadata:'read'}},{id:33,login:'synthetic[bot]',type:'Bot'},{id:55,full_name:'example/project',private:false}][calls.length-1];};};
  const dotted='ghs_synthetic.part-two.part_three';
  assert.equal(await authenticate(answers(dotted),key,{...identity,operations:[...identity.operations]},identity.repositories[0],now),dotted);
  for (const token of ['ghs_synthetic token','ghs_synthetic/slash','ghs_synthetic\nline']) await assert.rejects(authenticate(answers(token),key,{...identity,operations:[...identity.operations]},identity.repositories[0],now),{message:'auth-refused'});
});
test('selected protected file refuses symlink, mode, absent path and unsafe ancestor',async(t)=> {
  const root=temp(t);fs.writeFileSync(path.join(root,'selected.pem'),key,{mode:0o600});assert.deepEqual(await readProtected(root,'selected.pem',16384),key);
  fs.linkSync(path.join(root,'selected.pem'),path.join(root,'hardlink.pem'));await assert.rejects(readProtected(root,'selected.pem',16384));fs.unlinkSync(path.join(root,'hardlink.pem'));
  fs.symlinkSync(path.join(root,'selected.pem'),path.join(root,'linked.pem'));await assert.rejects(readProtected(root,'linked.pem',16384));
  fs.chmodSync(path.join(root,'selected.pem'),0o644);await assert.rejects(readProtected(root,'selected.pem',16384));
  await assert.rejects(readProtected(root,'missing.pem',16384));fs.chmodSync(root,0o777);await assert.rejects(readProtected(root,'selected.pem',16384));
});
test('durable receipts prevent conflict, ambiguous replay and parallel admission',async(t)=> {
  const root=temp(t), a=new ReceiptStore(root,'claude',11,'example/project',request.operationId);
  const lease=a.acquire();assert.throws(()=>a.acquire(),{message:'operation-busy'});
  const hash=a.digest(request);a.write({version:1,digest:hash,operation:'issue.create',status:'pending',fieldHashes:a.fieldHashes(request)});
  assert.equal(a.read()?.status,'pending');assert.equal(JSON.stringify(a.read()).includes('Synthetic'),false);
  lease();const b=new ReceiptStore(root,'claude',11,'example/project',request.operationId);assert.equal(b.read()?.digest,hash);
  assert.notEqual(b.digest({...request,title:'changed'}),hash);
});
test('transport deadline aborts an unresponsive request',async(t)=> {
  t.mock.timers.enable({apis:['setTimeout']});
  const http=transport(async(_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('private-canary')))));
  const pending=http('GET','/app','synthetic');t.mock.timers.tick(15001);
  await assert.rejects(pending,{message:'transport-failed'});
});
test('malformed/symlink receipts fail closed and existing locks are never age-stolen',t=> {
  const root=temp(t),a=new ReceiptStore(root,'claude',11,'example/project',request.operationId);
  fs.writeFileSync(a.file,'{"raw":"private-canary"}',{mode:0o600});assert.throws(()=>a.read(),{message:'receipt-invalid'});
  fs.unlinkSync(a.file);fs.symlinkSync(path.join(root,'missing'),a.file);assert.throws(()=>a.read(),{message:'receipt-invalid'});
  fs.writeFileSync(a.lock,'',{mode:0o600});fs.utimesSync(a.lock,new Date(0),new Date(0));assert.throws(()=>a.acquire(),{message:'operation-busy'});
});

test('canonical root uses OS account metadata, never environment home selectors',t=> {
  t.mock.method(os,'userInfo',()=>({homedir:'/synthetic-os-account'}));
  t.mock.method(os,'homedir',()=>{throw new Error('environment home must not select policy');});
  assert.equal(canonicalRoot(),path.join('/synthetic-os-account','.kherep','github-broker'));
});
test('read-only receipt construction never creates its missing directory',t=>{
  const root=temp(t);
  assert.throws(()=>new ReceiptStore(root,'claude',11,'example/project',request.operationId,false),{message:'receipt-invalid'});
  assert.equal(fs.existsSync(path.join(root,'receipts')),false);
  const mutation=new ReceiptStore(root,'claude',11,'example/project',request.operationId);assert.ok(fs.existsSync(mutation.directory));
});
test('protected snapshot refuses a path replacement during the descriptor read',async t=>{
  const root=temp(t),target=path.join(root,'snapshot.json'),replacement=path.join(root,'replacement.json');
  fs.writeFileSync(target,'{"version":1}',{mode:0o600});fs.writeFileSync(replacement,'{"version":2}',{mode:0o600});
  const original=fs.readSync;let replaced=false;
  t.mock.method(fs,'readSync',(...args:unknown[])=>{const result=Reflect.apply(original,fs,args);if(!replaced){replaced=true;fs.renameSync(replacement,target);}return result;});
  await assert.rejects(readProtected(root,'snapshot.json',4096),{message:'key-access-denied'});assert.equal(replaced,true);
});
