import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { checkCommits, gitEnv, helperCommand, pushArgs, trustedGit } from './git-push.mts';
import { gitServer } from './git-http.fixture.mts';
import { BOTS, TOKEN, brokerRoot, email, fakeGithub, stubWindowsAcl } from './flow.fixture.mts';
import { run as claude } from './github-claude.mts';
import { run as codex } from './github-codex.mts';
import { nodePaths } from '../control-plane/node/config.mts';
import { writePendingMarker } from '../control-plane/node/attribution.mts';
stubWindowsAcl();
type T = {after:(fn:()=>void)=>void; diagnostic?:(message:string)=>void};
// No broker push in this file may reach the operator's attribution log.
const configHome=fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-attribution-'));after(()=>fs.rmSync(configHome,{recursive:true,force:true}));
process.env.KHEREP_CONFIG_DIR=configHome;
const savedEnv=new WeakMap<T,Map<string,string|undefined>>();
/** Sets process variables for one test (undefined removes one) and restores each original once afterwards. */
function setEnv(t:T, vars:Record<string,string|undefined>):void {
  let saved=savedEnv.get(t);
  if (!saved) {const s=new Map<string,string|undefined>();saved=s;savedEnv.set(t,s);t.after(()=>{for (const [k,v] of s) if (v===undefined) delete process.env[k]; else process.env[k]=v;});}
  for (const [k,v] of Object.entries(vars)) {if (!saved.has(k)) saved.set(k,process.env[k]);if (v===undefined) delete process.env[k]; else process.env[k]=v;}
}
const g = (cwd:string, ...args:string[]) => execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();
/** A bare remote that already holds main, and a work clone with commits on top. */
function repos(t:T) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-git-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const projects=path.join(base,'remote'), bare=path.join(projects,'example','project.git'), work=path.join(base,'work');
  fs.mkdirSync(path.dirname(bare),{recursive:true});g(base,'init','-q','--bare','-b','main',bare);
  fs.mkdirSync(work);g(work,'init','-q','-b','main');
  const commit=(file:string, author=email(0), committer=author)=>{
    fs.mkdirSync(path.dirname(path.join(work,file)),{recursive:true});fs.writeFileSync(path.join(work,file),randomUUID());g(work,'add','-A');
    execFileSync('git',['-c','user.name=synthetic','-c',`user.email=${committer}`,'commit','-q','-m','synthetic',`--author=synthetic <${author}>`],{cwd:work,windowsHide:true});
    return g(work,'rev-parse','HEAD');
  };
  const main=commit('README.md','operator@example.com');g(work,'push','-q',bare,'main');
  return {base,projects,bare,work,main,commit,remote:(ref:string)=>{try{return g(bare,'rev-parse','--verify','-q',`refs/heads/${ref}`);}catch{return undefined;}}};
}
test('helper command single-quotes forward-slash paths and refuses a quote',()=>{
  const id=randomUUID();
  assert.equal(helperCommand('/usr/bin/node','/opt/k tools/github-claude-credential.mts',id),`!'/usr/bin/node' '/opt/k tools/github-claude-credential.mts' ${id}`);
  assert.throws(()=>helperCommand("/o'neil/node",'/x.mts',id),{message:'target-refused'});
  const args=pushArgs('!helper','https://github.com/example/project.git','a'.repeat(40),'feat/x');
  assert.deepEqual(args.slice(0,4),['-c','credential.helper=','-c','credential.helper=!helper']);
  for (const setting of ['credential.useHttpPath=true','http.extraHeader=','core.askPass=','protocol.ssh.allow=never','protocol.git.allow=never','protocol.file.allow=never']) assert.ok(args.includes(setting),setting);
  assert.deepEqual(args.slice(-4),['push','--porcelain','https://github.com/example/project.git',`${'a'.repeat(40)}:refs/heads/feat/x`]);
  assert.equal(args.some(a=>/force|delete|tags|mirror|^\+/.test(a)),false);
});
test('git child environment drops ambient tokens, tracing and injected configuration',()=>{
  const input={PATH:'p',Path:'evil',GH_TOKEN:'x',GITHUB_TOKEN:'x',GIT_TRACE:'1',GIT_TRACE_CURL:'1',GIT_CURL_VERBOSE:'1',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_PARAMETERS:'x',GIT_ASKPASS:'x',SSH_ASKPASS:'x',GIT_DIR:'x',GIT_EXEC_PATH:'evil',GIT_TERMINAL_PROMPT:'1',LANG:'C'};
  assert.deepEqual(gitEnv(input,'win32'),{LANG:'C',PATH:'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows',GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'});
  assert.deepEqual(gitEnv(input,'linux'),{LANG:'C',PATH:'/usr/bin:/bin',GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'});
});
test('trusted git comes from fixed system paths only, never from PATH',()=>{
  type Entry={file?:boolean; uid?:number; mode?:number};
  const stat=(entries:Record<string,Entry>)=>{
    const seen:string[]=[];
    const fn=((p:string)=>{seen.push(p);const e=entries[p];if (!e) throw new Error('ENOENT');return {isFile:()=>e.file ?? true,uid:e.uid ?? 0,mode:e.mode ?? 0o755};}) as unknown as typeof fs.statSync;
    return {fn,seen};
  };
  const cmd='C:\\Program Files\\Git\\cmd\\git.exe';
  const bin='C:\\Program Files\\Git\\bin\\git.exe';
  const saved=process.env.PATH;process.env.PATH='/attacker/bin';
  try {
    assert.equal(trustedGit('win32',stat({[cmd]:{},[bin]:{}}).fn),cmd);
    assert.equal(trustedGit('win32',stat({[cmd]:{file:false},[bin]:{}}).fn),bin);
    assert.throws(()=>trustedGit('win32',stat({}).fn),{message:'git-unavailable'});
    const posix=stat({'/usr/bin/git':{},'/usr/bin':{},'/usr/local/bin/git':{},'/usr/local/bin':{}});
    assert.equal(trustedGit('linux',posix.fn),'/usr/bin/git');
    assert.equal(posix.seen.some(p=>p.startsWith('/attacker')),false);
    // Non-root owner, group/other-writable file or directory: refused, next candidate.
    assert.equal(trustedGit('darwin',stat({'/usr/bin/git':{uid:501},'/usr/bin':{},'/usr/local/bin/git':{},'/usr/local/bin':{}}).fn),'/usr/local/bin/git');
    assert.throws(()=>trustedGit('linux',stat({'/usr/bin/git':{mode:0o775},'/usr/bin':{},'/usr/local/bin/git':{},'/usr/local/bin':{mode:0o777}}).fn),{message:'git-unavailable'});
    assert.throws(()=>trustedGit('linux',stat({'/usr/bin/git':{},'/usr/bin':{uid:1000},'/usr/local/bin/git':{mode:0o757},'/usr/local/bin':{}}).fn),{message:'git-unavailable'});
  } finally {if (saved===undefined) delete process.env.PATH; else process.env.PATH=saved;}
});
test('author preflight admits own-bot commits and refuses foreign authors, committers and workflow paths',t=>{
  const r=repos(t),own=[email(0).toLowerCase()];
  const good=r.commit('src/a.txt');assert.doesNotThrow(()=>checkCommits(r.work,good,r.main,own));
  const workflow=r.commit('.github/workflows/ci.yml');assert.throws(()=>checkCommits(r.work,workflow,r.main,own),{message:'target-refused'});
  g(r.work,'reset','-q','--hard',good);
  const other=r.commit('src/b.txt',email(1));assert.throws(()=>checkCommits(r.work,other,r.main,own),{message:'target-refused'});
  assert.doesNotThrow(()=>checkCommits(r.work,other,r.main,[...own,email(1).toLowerCase()]));
  g(r.work,'reset','-q','--hard',good);
  const operator=r.commit('src/c.txt',email(0),'operator@example.com');assert.throws(()=>checkCommits(r.work,operator,r.main,own),{message:'target-refused'});
});
test('Windows-safe helper quoting reaches a credential helper, and no configured personal helper answers',async t=>{
  const r=repos(t),sha=r.commit('src/a.txt'),id=randomUUID(),log=path.join(r.base,'helper.log'),personal=path.join(r.base,'personal.log');
  const dir=path.join(r.base,'helper dir');fs.mkdirSync(dir);
  const fake=path.join(dir,'fake helper.mjs');
  fs.writeFileSync(fake,`import fs from 'node:fs';let input='';for await (const c of process.stdin) input+=c;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),input,env:Object.values(process.env).some(v=>v&&v.includes(${JSON.stringify(TOKEN)}))})+'\\n');
if(process.argv[3]==='get') process.stdout.write('username=x-access-token\\npassword=${TOKEN}\\n');`);
  fs.writeFileSync(path.join(r.base,'personal.mjs'),`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(personal)},'called\\n');process.stdout.write('username=me\\npassword=${TOKEN}\\n');`);
  g(r.work,'config','credential.helper',helperCommand(process.execPath,path.join(r.base,'personal.mjs'),id));
  const server=await gitServer(r.projects,TOKEN);t.after(()=>server.close());
  // A URL-scoped helper is more specific than the plain reset; it must not answer either.
  g(r.work,'config',`credential.${new URL(server.url('example/project')).origin}.helper`,helperCommand(process.execPath,path.join(r.base,'personal.mjs'),id));
  const args=pushArgs(helperCommand(process.execPath,fake,id),server.url('example/project'),sha,'feat/x');
  assert.equal(args.join(' ').includes(TOKEN),false);
  // Asynchronous: the loopback server runs in this process.
  // System and global configuration stay out, so even a regression cannot reach a real credential manager.
  await promisify(execFile)(trustedGit(),args,{cwd:r.work,env:{...gitEnv(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(r.base,'global.gitconfig')},windowsHide:true,timeout:60000});
  assert.equal(r.remote('feat/x'),sha);assert.ok(server.authorized.length>0);assert.ok(server.authorized.every(u=>u==='x-access-token'));
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert.deepEqual(calls[0].argv,[id,'get']);assert.match(calls[0].input,/path=example\/project\.git/);
  assert.equal(calls.some(c=>c.env),false);assert.equal(fs.existsSync(personal),false);
});
for (const [runtime,run,index] of [['claude',claude,0],['codex',codex,1]] as const) test(`${runtime} branch.push pushes own-bot commits through the helper and reads the ref back`,async t=>{
  const r=repos(t),root=brokerRoot(t,runtime),api=fakeGithub(runtime,b=>r.remote(b));
  r.commit('src/one.txt',email(index));const sha=r.commit('src/two.txt',email(index));
  const helperLog=path.join(r.base,'helper.log'),fake=path.join(r.base,'helper.mjs');
  fs.writeFileSync(fake,`import fs from 'node:fs';for await (const c of process.stdin);fs.appendFileSync(${JSON.stringify(helperLog)},process.argv.slice(2).join(' ')+'\\n');if(process.argv[3]==='get')process.stdout.write('username=x-access-token\\npassword=${TOKEN}\\n');`);
  const server=await gitServer(r.projects,TOKEN);t.after(()=>server.close());
  const deps={root,fetch:api.fetch,cwd:r.work,push:{url:server.url('example/project'),helperScript:fake}};
  const request={operationId:randomUUID(),repository:'example/project',operation:'branch.push',branch:'feat/x',sha};
  const result=await run(JSON.stringify(request),deps);
  assert.deepEqual(result,{ok:true,operationId:request.operationId,runtime,repository:'example/project',operation:'branch.push',branch:'feat/x',sha,status:'verified',attribution:'authenticated-installation',bot:BOTS[index].login,attributionRecorded:true});
  assert.equal(r.remote('feat/x'),sha);assert.match(fs.readFileSync(helperLog,'utf8'),new RegExp(`^${request.operationId} get`));
  assert.deepEqual(api.calls.find(c=>c.url.endsWith('/access_tokens'))?.body.permissions,{contents:'write'});
  assert.equal(JSON.stringify(result).includes(TOKEN),false);
  const disk=fs.readdirSync(path.join(root,'receipts')).map(n=>fs.readFileSync(path.join(root,'receipts',n),'utf8')).join('');
  assert.equal(disk.includes(TOKEN),false);assert.match(disk,/"version":2,"kind":"push"/);
  assert.equal((await run(JSON.stringify(request),deps)).ok,true);
  assert.equal((await run(JSON.stringify({...request,branch:'feat/y'}),deps)).error,'operation-conflict');
});
test('branch.push refusals happen before any push',async t=>{
  const r=repos(t),root=brokerRoot(t,'claude'),api=fakeGithub('claude',b=>r.remote(b));
  const good=r.commit('src/a.txt');
  const server=await gitServer(r.projects,TOKEN);t.after(()=>server.close());
  const deps={root,fetch:api.fetch,cwd:r.work,push:{url:server.url('example/project'),helperScript:path.join(r.base,'absent.mjs')}};
  const push=(extra:Record<string,unknown>)=>claude(JSON.stringify({operationId:randomUUID(),repository:'example/project',operation:'branch.push',branch:'feat/x',sha:good,...extra}),deps);
  for (const branch of ['main','v1.2.0']) assert.equal((await push({branch})).error,'target-refused',branch);
  assert.equal((await push({sha:'0'.repeat(40)})).error,'target-refused');
  const foreign=r.commit('src/b.txt',email(1));assert.equal((await push({sha:foreign})).error,'target-refused');
  g(r.work,'reset','-q','--hard',good);const workflow=r.commit('.github/workflows/x.yml');assert.equal((await push({sha:workflow})).error,'target-refused');
  // The remote branch moved to a commit that sha does not contain: not a fast-forward.
  g(r.work,'reset','-q','--hard',good);const side=r.commit('src/side.txt');g(r.work,'push','-q',r.bare,`${side}:refs/heads/feat/x`);
  g(r.work,'reset','-q','--hard',good);const diverged=r.commit('src/c.txt');assert.equal((await push({sha:diverged})).error,'target-refused');
  for (const workflows of [true]) assert.equal((await push({workflows})).error,'invalid-request');
  assert.equal(server.refused+server.authorized.length,0);assert.equal(r.remote('feat/x'),side);
});
const githooks=path.resolve(import.meta.dirname,'..','..','claude','kherep','githooks');
const sh=(p:string)=>p.split(path.sep).join('/');
/** One runtime's broker and loopback remote. `password` is what the helper answers; `lie` makes the readback see another commit. */
async function pushSetup(t:T, runtime:'claude'|'codex', options:{password?:string; lie?:boolean}={}) {
  const r=repos(t), root=brokerRoot(t,runtime), sha=r.commit('src/one.txt',email(runtime==='claude'?0:1));
  const api=fakeGithub(runtime,b=>options.lie && b==='feat/x' && r.remote(b) ? 'f'.repeat(40) : r.remote(b));
  const fake=path.join(r.base,'helper.mjs'), config=path.join(r.base,'config'), log=path.join(config,'control-plane','attribution.jsonl');
  fs.writeFileSync(fake,`for await (const c of process.stdin);if(process.argv[3]==='get')process.stdout.write('username=x-access-token\\npassword=${options.password ?? TOKEN}\\n');`);
  const server=await gitServer(r.projects,TOKEN);t.after(()=>server.close());
  setEnv(t,{KHEREP_CONFIG_DIR:config,CLAUDE_CODE_SESSION_ID:undefined,KHEREP_SESSION_ID:undefined});
  const request={operationId:randomUUID(),repository:'example/project',operation:'branch.push',branch:'feat/x',sha};
  const push=()=>(runtime==='claude'?claude:codex)(JSON.stringify(request),{root,fetch:api.fetch,cwd:r.work,push:{url:server.url('example/project'),helperScript:fake}});
  const records=():Record<string,unknown>[]=>fs.existsSync(log)?fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  return {r,sha,config,log,request,push,records};
}
/**
 * The real pre-push hook beside its recorder, as the installer places them, wired into the work clone,
 * and a node shim the hook finds on the fixed git PATH (Git for Windows adds $HOME/bin). Returns the shim's run log.
 */
function installHook(t:T, r:ReturnType<typeof repos>):string {
  const hooks=path.join(r.base,'hooks'), home=path.join(r.base,'home'), runs=path.join(r.base,'node-shim.log');
  fs.mkdirSync(hooks);fs.mkdirSync(path.join(home,'bin'),{recursive:true});
  for (const name of ['pre-push','attribution-record.mts']) fs.copyFileSync(path.join(githooks,name),path.join(hooks,name));
  fs.chmodSync(path.join(hooks,'pre-push'),0o755);
  fs.writeFileSync(path.join(home,'bin','node'),`#!/bin/sh\necho run >> '${sh(runs)}'\nexec '${sh(process.execPath)}' "$@"\n`,{mode:0o755});
  g(r.work,'config','core.hooksPath',hooks);
  setEnv(t,{HOME:home,KHEREP_WORKSPACE:r.base});
  return runs;
}
test('a verified broker push leaves exactly one attribution record, and the pre-push hook stands down',async t=>{
  const p=await pushSetup(t,'claude'), shimLog=installHook(t,p.r);
  setEnv(t,{CLAUDE_CODE_SESSION_ID:'synthetic-claude-780'});
  const runs=()=>fs.existsSync(shimLog)?fs.readFileSync(shimLog,'utf8').split('\n').filter(Boolean).length:0;
  // Control: the same fixed git environment without KHEREP_BROKER_PUSH lets the hook record a plain push.
  execFileSync(trustedGit(),['push','-q',p.r.bare,`${p.r.main}:refs/heads/control`],{cwd:p.r.work,windowsHide:true,
    env:{...gitEnv(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(p.r.base,'global.gitconfig')}});
  const control=p.records().length, before=runs();
  if (process.platform==='win32') assert.equal(control,1,'the hook reaches node through $HOME/bin');
  if (control) assert.deepEqual([p.records()[0].remoteRef,p.records()[0].sessionSource],['refs/heads/control','CLAUDE_CODE_SESSION_ID']);
  else t.diagnostic?.('node is not on the fixed git PATH here; bootstrap/pre-push-hook.test.mts proves the stand-down');
  const result=await p.push();
  assert.equal(result.ok,true);assert.equal(result.attributionRecorded,true);
  const records=p.records();
  assert.equal(records.length,control+1,JSON.stringify(records));
  assert.deepEqual({...records.at(-1),ts:undefined},{v:1,ts:undefined,kind:'push',sessionId:'synthetic-claude-780',runtime:'claude',sessionSource:'CLAUDE_CODE_SESSION_ID',
    repo:'example/project',toplevel:g(p.r.work,'rev-parse','--show-toplevel'),branch:'feat/x',remoteRef:'refs/heads/feat/x',sha:p.sha,pr:null});
  assert.equal(runs(),before,'the hook started no node for the broker push');
  const text=fs.readFileSync(p.log,'utf8');
  for (const secret of [TOKEN,'x-access-token','127.0.0.1',p.request.operationId]) assert.equal(text.includes(secret),false,secret);
  // A replay of the verified receipt writes nothing and reports no recording.
  const replay=await p.push();
  assert.equal(replay.ok,true);assert.equal(Object.hasOwn(replay,'attributionRecorded'),false);assert.equal(p.records().length,control+1);
});
test('a rejected push and a failed verification leave no attribution record',async t=>{
  for (const options of [{password:'wrong-synthetic'},{lie:true}]) {
    const p=await pushSetup(t,'claude',options);setEnv(t,{CLAUDE_CODE_SESSION_ID:'synthetic-claude-780'});
    assert.equal((await p.push()).error,options.lie?'verification-failed':'outcome-unknown');
    assert.equal(fs.existsSync(p.log),false);
  }
});
test('an unwritable attribution log never fails a verified push',async t=>{
  const p=await pushSetup(t,'claude');setEnv(t,{CLAUDE_CODE_SESSION_ID:'synthetic-claude-780'});
  fs.writeFileSync(p.config,'a file where the config directory should be\n');
  const result=await p.push();
  assert.equal(result.ok,true);assert.equal(result.status,'verified');assert.equal(result.attributionRecorded,false);assert.equal(p.r.remote('feat/x'),p.sha);
});
test('a Codex broker push takes its session from the pending marker and consumes it',async t=>{
  const p=await pushSetup(t,'codex'), paths=nodePaths(p.config);
  writePendingMarker(paths,g(p.r.work,'rev-parse','--show-toplevel'),'synthetic-codex-780','codex',Date.now());
  assert.equal((await p.push()).attributionRecorded,true);
  assert.deepEqual(p.records().map(r=>[r.sessionId,r.runtime,r.sessionSource]),[['synthetic-codex-780','codex','marker']]);
  assert.deepEqual(fs.readdirSync(paths.attributionPending),[]);
});
