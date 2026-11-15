// A broker push reads and pushes through a broker-owned clean repository with a constructed
// environment: nothing in the session repository's configuration, hooks, refs, shallow file or
// commit-graph, in the user's configuration or in the broker's environment may change what is
// checked, where it goes or who may answer for its credential.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { TOKEN, email, stubWindowsAcl } from './flow.fixture.mts';
import { answering, g, isolateProcess, pushSetup, refused, setEnv } from './git-push.fixture.mts';
import type { T } from './git-push.fixture.mts';
stubWindowsAcl();
isolateProcess();
const sh=(p:string)=>p.split(path.sep).join('/');
/** A loopback HTTP server that counts every request and answers `status`; 401 also asks for Basic credentials. */
async function sink(t:T, status:number) {
  const state={hits:0,authorization:[] as string[]};
  const server=http.createServer((req,res)=>{
    state.hits++;if (req.headers.authorization) state.authorization.push(req.headers.authorization);
    req.resume();res.writeHead(status,status===401?{'WWW-Authenticate':'Basic realm="sink"'}:{});res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  return {origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,state};
}
/**
 * A helper that answers like `answering` and first writes what it sees to `log`: config with scopes, env names,
 * cwd, grant contents, its push nonce and argv, and every file under receipts/ or its cwd that holds the nonce.
 */
const probe=(log:string, receipts:string)=>`import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
for await (const c of process.stdin);
if(process.argv[3]==='get'){
  let config;try{config=execFileSync('git',['config','--list','--show-scope'],{encoding:'utf8'});}catch(e){config='error '+e.message;}
  const receipts=${JSON.stringify(receipts)}, nonce=process.env.KHEREP_PUSH_GRANT??'';
  const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
  const leaks=nonce?[...walk(receipts),...walk(process.cwd())].filter(f=>fs.readFileSync(f,'latin1').includes(nonce)):[];
  const grants=fs.readdirSync(receipts).filter(n=>n.endsWith('.grant')).map(n=>fs.readFileSync(path.join(receipts,n),'utf8'));
  fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({config,env:Object.keys(process.env),cwd:process.cwd(),grants,nonce,argv:process.argv,leaks}));
  process.stdout.write('username=x-access-token\\npassword=${TOKEN}\\n');
}`;
async function probed(t:T) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-probe-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const log=path.join(base,'probe.json'), p=await pushSetup(t,'claude',{helper:''});
  // The probe needs the receipts path, known only after setup.
  fs.writeFileSync(path.join(p.r.base,'helper.mjs'),probe(log,path.join(p.root,'receipts')));
  return {...p,seen:()=>JSON.parse(fs.readFileSync(log,'utf8')) as {config:string; env:string[]; cwd:string; grants:string[]; nonce:string; argv:string[]; leaks:string[]}};
}
test('a repository pre-push hook never runs under a broker push, and one grant exists while the push runs',async t=>{
  const p=await probed(t), hooks=path.join(p.r.base,'hooks'), sentinel=path.join(p.r.base,'hook-ran');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks,'pre-push'),`#!/bin/sh\nprintf '%s' "$GIT_CONFIG_PARAMETERS" > '${sh(sentinel)}'\ncat > /dev/null\nexit 0\n`,{mode:0o755});
  g(p.r.work,'config','core.hooksPath',hooks);
  const result=await p.push();
  assert.equal(fs.existsSync(sentinel),false,'the pre-push hook ran and saw the helper command');
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(p.r.remote('feat/x'),p.sha);
  assert.equal(p.seen().grants.length,1,'exactly one grant while git asks for the credential');
  assert.deepEqual(fs.readdirSync(path.join(p.root,'receipts')).filter(n=>n.endsWith('.grant')),[],'the grant is revoked after the push');
});
test('the push nonce reaches the helper only through the git child environment, and the grant holds only its hash',async t=>{
  const p=await probed(t);
  assert.equal((await p.push()).ok,true);
  const {nonce,argv,grants,leaks}=p.seen();
  assert.match(nonce,/^[a-f0-9]{64}$/);
  assert.equal(argv.some(a=>a.includes(nonce)),false,'the nonce is in argv');
  assert.deepEqual(grants,[createHash('sha256').update(nonce).digest('hex')]);
  assert.deepEqual(leaks,[],'a file under receipts/ or the clean repository holds the nonce');
});
test('repo, user and environment TLS and proxy settings never reach the push',async t=>{
  const p=await probed(t), proxy=await sink(t,502), home=path.join(p.r.base,'home');
  const settings=[['http.sslVerify','false'],[`http.${new URL(p.server.url('example/project')).origin}/.sslVerify`,'false'],['http.proxy',proxy.origin],['http.sslCAInfo',path.join(home,'ca.pem')]];
  for (const [key,value] of settings) g(p.r.work,'config',key,value);
  fs.mkdirSync(home);fs.writeFileSync(path.join(home,'.gitconfig'),`[http]\n\tsslVerify = false\n\tproxy = ${proxy.origin}\n`);
  setEnv(t,{HOME:home,GIT_SSL_NO_VERIFY:'1',http_proxy:proxy.origin,HTTPS_PROXY:proxy.origin,ALL_PROXY:proxy.origin,CURL_CA_BUNDLE:path.join(home,'ca.pem'),NODE_OPTIONS:'--no-warnings'});
  const result=await p.push();
  assert.equal(proxy.state.hits,0,'the push went through the proxy sink');
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(p.r.remote('feat/x'),p.sha);
  const seen=p.seen(), lines=seen.config.split(/\r?\n/).filter(Boolean);
  assert.deepEqual(lines.filter(l=>/^(?:global|system)\t/.test(l)),[],'no global or system configuration');
  assert.deepEqual(lines.filter(l=>/\t(?:http\.(?:.*\.)?(?:sslverify|proxy|sslcainfo)|core\.hookspath)=/i.test(l)),[]);
  assert.deepEqual(seen.env.filter(n=>/proxy|^GIT_SSL|^CURL_|^SSL_CERT|^NODE_OPTIONS$/i.test(n)),[]);
  assert.ok(seen.env.includes('GIT_NO_REPLACE_OBJECTS'));
  // The probe read the clean repository: its git dir reaches the helper, its config is the only local one.
  assert.ok(path.basename(seen.cwd).startsWith('kherep-push-'),seen.cwd);assert.ok(lines.includes('local\tcore.commitgraph=false'),seen.config);
});
test('url.insteadOf in repo config cannot redirect the push or the credential',async t=>{
  const p=await pushSetup(t,'claude'), trap=await sink(t,401), origin=new URL(p.server.url('example/project')).origin;
  g(p.r.work,'config',`url.${trap.origin}/.insteadOf`,`${origin}/`);
  g(p.r.work,'config',`url.${trap.origin}/.pushInsteadOf`,`${origin}/`);
  const result=await p.push();
  assert.equal(trap.state.hits,0,`the push was redirected; credentials sent: ${trap.state.authorization.length}`);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(p.r.remote('feat/x'),p.sha);
});
test('a replace ref cannot fake bot authorship',async t=>{
  const p=await pushSetup(t,'claude'), foreign=p.r.commit('src/f.txt','operator@example.com');
  const twin=execFileSync('git',['-c','user.name=synthetic','-c',`user.email=${email(0)}`,'commit-tree',`${foreign}^{tree}`,'-p',p.sha,'-m','synthetic'],{cwd:p.r.work,encoding:'utf8',windowsHide:true}).trim();
  g(p.r.work,'replace',foreign,twin);
  await refused(p,foreign);
});
test('a shallow file cannot hide a foreign ancestor',async t=>{
  const p=await pushSetup(t,'claude');p.r.commit('src/f.txt','operator@example.com');const bot=p.r.commit('src/b.txt');
  fs.writeFileSync(path.join(p.r.work,'.git','shallow'),`${bot}\n`);
  await refused(p,bot);
});
test('a falsified local origin/main cannot admit a foreign commit: the base comes from GitHub',async t=>{
  const p=await pushSetup(t,'claude'), foreign=p.r.commit('src/f.txt','operator@example.com'), bot=p.r.commit('src/b.txt');
  g(p.r.work,'remote','add','origin',p.r.bare);g(p.r.work,'update-ref','refs/remotes/origin/main',foreign);g(p.r.work,'update-ref','refs/remotes/origin/HEAD',foreign);
  await refused(p,bot);
});
/** Rewrites `commit`'s first parent in the session's commit-graph to `parent` and re-signs the file's checksum. */
function lieInCommitGraph(work:string, commit:string, parent:string):void {
  const file=path.join(work,'.git','objects','info','commit-graph');fs.chmodSync(file,0o644);
  const buf=fs.readFileSync(file), chunks=buf[6];
  const chunk=(id:string)=>{for (let i=0;i<chunks;i++) {const at=8+i*12;if (buf.toString('latin1',at,at+4)===id) return Number(buf.readBigUInt64BE(at+4));} throw new Error(id);};
  const oids=chunk('OIDL'), data=chunk('CDAT'), count=buf.readUInt32BE(chunk('OIDF')+255*4);
  const index=(oid:string)=>{for (let i=0;i<count;i++) if (buf.toString('hex',oids+i*20,oids+i*20+20)===oid) return i;throw new Error(oid);};
  buf.writeUInt32BE(index(parent),data+index(commit)*36+20);
  createHash('sha1').update(buf.subarray(0,buf.length-20)).digest().copy(buf,buf.length-20);
  fs.writeFileSync(file,buf);
}
test('a crafted commit-graph in the session object store cannot hide a foreign ancestor',async t=>{
  const p=await pushSetup(t,'claude');p.r.commit('src/f.txt','operator@example.com');const bot=p.r.commit('src/b.txt');
  g(p.r.work,'commit-graph','write','--reachable');
  lieInCommitGraph(p.r.work,bot,p.sha);
  assert.equal(g(p.r.work,'log','--format=%ae',bot,'--not',p.r.main).split('\n').length,2,'the session repository itself believes the lie');
  await refused(p,bot);
});
/** Records every clean repository the broker creates, with its POSIX mode at creation; `mode` changes it first. */
function watchCleanRepos(t:T, mode?:number) {
  const created:{dir:string; mode:number}[]=[], original=fs.mkdtempSync;
  fs.mkdtempSync=((prefix:string,options?:unknown)=>{
    const dir=Reflect.apply(original,fs,[prefix,options]) as string;
    if (path.basename(dir).startsWith('kherep-push-')) {if (mode!==undefined) fs.chmodSync(dir,mode);created.push({dir,mode:fs.statSync(dir).mode & 0o777});}
    return dir;
  }) as typeof fs.mkdtempSync;
  t.after(()=>{fs.mkdtempSync=original;});
  return created;
}
test('every clean repository is private, under the broker root, and removed on success, refusal and push failure',async t=>{
  const created=watchCleanRepos(t), elsewhere=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-temp-')));
  t.after(()=>fs.rmSync(elsewhere,{recursive:true,force:true}));
  const ok=await pushSetup(t,'claude'), failing=await pushSetup(t,'claude',{helper:answering('wrong-synthetic')});
  // The caller's temporary directory never decides where a clean repository lives.
  setEnv(t,{TEMP:elsewhere,TMP:elsewhere,TMPDIR:elsewhere});
  assert.equal((await ok.push()).ok,true);
  assert.equal(created.length,2,'one clean repository for the preflight and one for the push');
  const foreign=ok.r.commit('src/f.txt','operator@example.com');
  assert.equal((await ok.push({operationId:randomUUID(),branch:'feat/y',sha:foreign})).error,'target-refused');
  assert.equal(created.length,3);
  assert.equal((await failing.push()).error,'outcome-unknown');
  assert.equal(created.length,5);
  for (const [i,{dir,mode}] of created.entries()) {
    assert.equal(fs.existsSync(dir),false,`left behind: ${dir}`);
    assert.equal(path.dirname(dir),i<3?ok.root:failing.root,dir);
    if (process.platform!=='win32') assert.equal(mode,0o700);
  }
});
test('a push removes clean repositories older than ten minutes from the broker root and keeps younger ones',async t=>{
  const p=await pushSetup(t,'claude'), old=path.join(p.root,'kherep-push-old'), young=path.join(p.root,'kherep-push-young');
  for (const dir of [old,young]) fs.mkdirSync(path.join(dir,'objects'),{recursive:true,mode:0o700});
  const past=new Date(Date.now()-11*60000);fs.utimesSync(old,past,past);
  assert.equal((await p.push()).ok,true);
  assert.equal(fs.existsSync(old),false,'the stale clean repository is left behind');assert.equal(fs.existsSync(young),true);
});
const moduleUrl=(name:string)=>pathToFileURL(path.join(import.meta.dirname,name)).href;
test('the real credential helper behind git answers the broker push once, with the nonce from its environment',async t=>{
  const p=await pushSetup(t,'claude',{helper:''});
  // Test-only translation: the loopback remote stands in for github.com, and this helper's synthetic key for the policy's.
  fs.writeFileSync(path.join(p.r.base,'helper.mjs'),`import fs from 'node:fs';
import {credential} from ${JSON.stringify(moduleUrl('credential.mts'))};
import {fakeGithub,pair,stubWindowsAcl} from ${JSON.stringify(moduleUrl('flow.fixture.mts'))};
stubWindowsAcl();
fs.writeFileSync(${JSON.stringify(path.join(p.root,'keys','synthetic0.pem'))},pair.privateKey.export({type:'pkcs8',format:'pem'}));
let input='';for await (const c of process.stdin) input+=c;
input=input.replace(/^protocol=.*$/m,'protocol=https').replace(/^host=.*$/m,'host=github.com');
try{process.stdout.write(await credential('claude',process.argv.slice(2),input,{root:${JSON.stringify(p.root)},fetch:fakeGithub('claude').fetch}));}catch{process.exitCode=1;}`);
  const result=await p.push();
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(p.r.remote('feat/x'),p.sha);
  assert.ok(p.server.authorized.length>0);
  assert.deepEqual(fs.readdirSync(path.join(p.root,'receipts')).filter(n=>n.endsWith('.grant')),[]);
});
test('a clean repository readable by group or others is refused and removed',{skip:process.platform==='win32'&&'POSIX modes only'},async t=>{
  const created=watchCleanRepos(t,0o755), p=await pushSetup(t,'claude');
  await refused(p,p.sha);
  assert.equal(created.length,1);assert.equal(fs.existsSync(created[0].dir),false);
});
