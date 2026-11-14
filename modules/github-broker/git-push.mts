import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail, pickIds, refName, SHA } from './contract.mts';
import type { Runtime } from './contract.mts';
import { ABSENT } from './transport.mts';
import type { Context, Handler } from './operations.mts';
const MAX_COMMITS = 256;
// Dropped from every git child: tracing, injected configuration, askpass programs,
// alternative repositories, ambient tokens and the search path. Prompts are switched off.
const DROPPED = /^(?:PATH|GIT_TRACE.*|GIT_CURL_VERBOSE|GIT_REDACT_COOKIES|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_SSH.*|GIT_PROXY_COMMAND|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GCM_TRACE.*)$/i;
// Git and the programs it starts come from fixed system locations, never from the caller's PATH.
const GIT_CANDIDATES = {win32:['C:\\Program Files\\Git\\cmd\\git.exe','C:\\Program Files\\Git\\bin\\git.exe'], posix:['/usr/bin/git','/usr/local/bin/git']};
const GIT_PATH = {win32:'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows', posix:'/usr/bin:/bin'};
export function gitEnv(env:NodeJS.ProcessEnv=process.env, platform:NodeJS.Platform=process.platform):NodeJS.ProcessEnv {
  const out:NodeJS.ProcessEnv={};
  for (const [k,v] of Object.entries(env)) if (v!==undefined && !DROPPED.test(k)) out[k]=v;
  return {...out, PATH:platform==='win32'?GIT_PATH.win32:GIT_PATH.posix, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'never'};
}
// POSIX: owned by root and writable by nobody else.
const rootOnly = (s:fs.Stats) => s.uid===0 && (s.mode & 0o022)===0;
let defaultGit:string|undefined;
/** The first fixed candidate that is a regular file (on POSIX root-owned, in a root-owned directory); none fails `git-unavailable`. */
export function trustedGit(platform:NodeJS.Platform=process.platform, stat:typeof fs.statSync=fs.statSync):string {
  const isDefault=platform===process.platform && stat===fs.statSync;
  if (isDefault && defaultGit) return defaultGit;
  const win=platform==='win32';
  for (const file of win?GIT_CANDIDATES.win32:GIT_CANDIDATES.posix) {
    try {
      const s=stat(file);
      if (!s.isFile() || !win && !(rootOnly(s) && rootOnly(stat(path.posix.dirname(file))))) continue;
      if (isDefault) defaultGit=file;
      return file;
    } catch { /* Absent candidate: try the next one. */ }
  }
  return fail('git-unavailable');
}
function git(cwd:string, args:string[]):string|undefined {
  const exe=trustedGit();
  try { return execFileSync(exe,args,{cwd,env:gitEnv(),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','ignore']}).trim(); }
  catch { return undefined; }
}
const isCommit = (dir:string, sha:string) => git(dir,['cat-file','-t',sha])==='commit';
function toplevel(c:Context):string {
  const dir=git(c.deps.cwd ?? process.cwd(),['rev-parse','--show-toplevel']);
  return dir || fail('target-refused');
}
/** One `!` helper command: single-quoted paths with forward slashes, then the operation ID. */
export function helperCommand(node:string, script:string, operationId:string):string {
  const quote=(value:string)=>{const p=value.split(path.sep).join('/');if (p.includes("'")) fail('target-refused');return `'${p}'`;};
  return `!${quote(node)} ${quote(script)} ${operationId}`;
}
/**
 * The fixed push. The empty helper first resets every configured helper (manager,
 * keychain, store), so only the broker's own helper can answer; no extra header,
 * askpass or non-HTTP transport. No force, no delete, no tag: one fast-forward
 * branch refspec.
 */
export function pushArgs(helper:string, url:string, sha:string, branch:string):string[] {
  return ['-c','credential.helper=','-c',`credential.helper=${helper}`,'-c','credential.useHttpPath=true','-c','http.extraHeader=','-c','core.askPass=',
    '-c','protocol.ssh.allow=never','-c','protocol.git.allow=never','-c','protocol.file.allow=never','push','--porcelain',url,`${sha}:refs/heads/${branch}`];
}
export function helperScript(runtime:Runtime):string {
  return fileURLToPath(new URL(`./github-${runtime}-credential.mts`,import.meta.url));
}
async function remoteSha(c:Context, branch:string, code:'target-refused'|'verification-failed'):Promise<string|undefined> {
  const ref=await c.http('GET',`/repos/${c.repo.slug}/git/ref/heads/${branch}`,c.token,undefined,true);
  if (ref===ABSENT) return undefined;
  const object=ref.object as Record<string,unknown>|null;
  if (ref.ref!==`refs/heads/${branch}` || object?.type!=='commit' || typeof object.sha!=='string' || !SHA.test(object.sha)) fail(code);
  return object.sha;
}
/**
 * Bot authorship is enforced here, independently of the runtime: every commit the
 * push would add beyond the remote default branch must carry an allowed bot email
 * as author and committer, and none may touch `.github/workflows`.
 */
export function checkCommits(dir:string, sha:string, base:string, emails:string[]):void {
  const log=git(dir,['log','-z','-m','--no-renames','--name-only',`--max-count=${MAX_COMMITS+1}`,'--format=%x01%H%x09%ae%x09%ce',sha,'--not',base]);
  if (log===undefined) fail('target-refused');
  const commits=new Set<string>();
  for (const token of log.split(/[\0\n]/)) {
    if (token.startsWith('\x01')) {
      const [hash,author,committer]=token.slice(1).split('\t');
      commits.add(hash);
      if (![author,committer].every(e=>typeof e==='string' && emails.includes(e.toLowerCase()))) fail('target-refused');
    } else if (token.toLowerCase().startsWith('.github/workflows/')) fail('target-refused');
  }
  if (commits.size>MAX_COMMITS) fail('target-refused');
}
function run(dir:string, args:string[]):Promise<boolean> {
  return new Promise(resolve=>{execFile(trustedGit(),args,{cwd:dir,env:gitEnv(),timeout:120000,windowsHide:true,maxBuffer:1024*1024},error=>resolve(!error));});
}
export const pushHandler: Handler = {
  kind:'push',
  fields:()=>({}),
  async preflight(c) {
    const {branch,sha}=c.request as {branch:string; sha:string}, dir=toplevel(c), main=c.target.default_branch;
    if (typeof main!=='string' || !refName(main) || branch===main || branch.startsWith('v')) fail('target-refused');
    if (!isCommit(dir,sha)) fail('target-refused');
    const current=await remoteSha(c,branch,'target-refused');
    // Fast-forward only: the remote branch tip must be a local ancestor of sha.
    if (current && current!==sha && (!isCommit(dir,current) || git(dir,['merge-base','--is-ancestor',current,sha])===undefined)) fail('target-refused');
    const base=await remoteSha(c,main,'target-refused');
    if (!base || !isCommit(dir,base)) fail('target-refused');
    checkCommits(dir,sha,base,c.identity.authorEmails ?? []);
    return {branch,sha,admittedAt:c.now};
  },
  async mutate(c, receipt) {
    const url=c.deps.push?.url ?? `https://github.com/${c.repo.slug}.git`;
    const helper=helperCommand(process.execPath,c.deps.push?.helperScript ?? helperScript(c.runtime),c.request.operationId);
    if (!await run(toplevel(c),pushArgs(helper,url,receipt.sha!,receipt.branch!))) fail('outcome-unknown');
    return {};
  },
  known:receipt=>typeof receipt.branch==='string' && typeof receipt.sha==='string',
  async readback(c, receipt) {
    if (await remoteSha(c,receipt.branch!,'verification-failed')!==receipt.sha) fail('verification-failed');
  },
  ids:receipt=>pickIds(receipt,['branch','sha']),
  attribution:()=>'authenticated-installation',
};
