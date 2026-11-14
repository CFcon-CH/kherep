import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { checkCommits, gitEnv, helperCommand, pushArgs } from './git-push.mts';
import { gitServer } from './git-http.fixture.mts';
import { BOTS, TOKEN, brokerRoot, email, fakeGithub, stubWindowsAcl } from './flow.fixture.mts';
import { run as claude } from './github-claude.mts';
import { run as codex } from './github-codex.mts';
stubWindowsAcl();
type T = {after:(fn:()=>void)=>void};
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
  const env=gitEnv({PATH:'p',GH_TOKEN:'x',GITHUB_TOKEN:'x',GIT_TRACE:'1',GIT_TRACE_CURL:'1',GIT_CURL_VERBOSE:'1',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_PARAMETERS:'x',GIT_ASKPASS:'x',SSH_ASKPASS:'x',GIT_DIR:'x',GIT_TERMINAL_PROMPT:'1'});
  assert.deepEqual(env,{PATH:'p',GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'});
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
  await promisify(execFile)('git',args,{cwd:r.work,env:{...gitEnv(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(r.base,'global.gitconfig')},windowsHide:true,timeout:60000});
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
  assert.deepEqual(result,{ok:true,operationId:request.operationId,runtime,repository:'example/project',operation:'branch.push',branch:'feat/x',sha,status:'verified',attribution:'authenticated-installation',bot:BOTS[index].login});
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
