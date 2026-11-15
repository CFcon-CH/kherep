// Test fixture only: synthetic git repositories, per-test process variables and one
// runtime's broker push against a loopback remote. No real key, token or gitconfig.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gitServer } from './git-http.fixture.mts';
import { TOKEN, brokerRoot, email, fakeGithub } from './flow.fixture.mts';
import { run as claude } from './github-claude.mts';
import { run as codex } from './github-codex.mts';
export type T = {after:(fn:()=>void)=>void; diagnostic?:(message:string)=>void};
/**
 * Once per test file: no broker push may reach the operator's attribution log, and no
 * fixture git call reads the system configuration or reads or writes the real global one.
 */
export function isolateProcess():void {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-process-'));after(()=>fs.rmSync(home,{recursive:true,force:true}));
  Object.assign(process.env,{KHEREP_CONFIG_DIR:path.join(home,'config'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(home,'global.gitconfig')});
}
const savedEnv=new WeakMap<T,Map<string,string|undefined>>();
/** Sets process variables for one test (undefined removes one) and restores each original once afterwards. */
export function setEnv(t:T, vars:Record<string,string|undefined>):void {
  let saved=savedEnv.get(t);
  if (!saved) {const s=new Map<string,string|undefined>();saved=s;savedEnv.set(t,s);t.after(()=>{for (const [k,v] of s) if (v===undefined) delete process.env[k]; else process.env[k]=v;});}
  for (const [k,v] of Object.entries(vars)) {if (!saved.has(k)) saved.set(k,process.env[k]);if (v===undefined) delete process.env[k]; else process.env[k]=v;}
}
export const g = (cwd:string, ...args:string[]) => execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();
/** A bare remote that already holds main, and a work clone with commits on top. */
export function repos(t:T) {
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
/** The source of a fake credential helper that answers every `get` with `password`. */
export const answering = (password=TOKEN) => `for await (const c of process.stdin);if(process.argv[3]==='get')process.stdout.write('username=x-access-token\\npassword=${password}\\n');`;
/**
 * One runtime's broker and loopback remote. `password` is what the helper answers, `helper` replaces
 * the helper's whole source; `lie` makes the readback see another commit.
 */
export async function pushSetup(t:T, runtime:'claude'|'codex', options:{password?:string; lie?:boolean; helper?:string}={}) {
  const r=repos(t), root=brokerRoot(t,runtime), sha=r.commit('src/one.txt',email(runtime==='claude'?0:1));
  const api=fakeGithub(runtime,b=>options.lie && b==='feat/x' && r.remote(b) ? 'f'.repeat(40) : r.remote(b));
  const fake=path.join(r.base,'helper.mjs'), config=path.join(r.base,'config'), log=path.join(config,'control-plane','attribution.jsonl');
  fs.writeFileSync(fake,options.helper ?? answering(options.password));
  const server=await gitServer(r.projects,TOKEN);t.after(()=>server.close());
  setEnv(t,{KHEREP_CONFIG_DIR:config,CLAUDE_CODE_SESSION_ID:undefined,KHEREP_SESSION_ID:undefined});
  const request={operationId:randomUUID(),repository:'example/project',operation:'branch.push',branch:'feat/x',sha};
  const push=(extra:Record<string,unknown>={})=>(runtime==='claude'?claude:codex)(JSON.stringify({...request,...extra}),{root,fetch:api.fetch,cwd:r.work,push:{url:server.url('example/project'),helperScript:fake}});
  const records=():Record<string,unknown>[]=>fs.existsSync(log)?fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  return {r,root,sha,config,log,request,push,records,server};
}
