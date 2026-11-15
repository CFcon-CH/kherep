import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail, pickIds, refName, SHA } from './contract.mts';
import type { Runtime } from './contract.mts';
import { ABSENT } from './transport.mts';
import type { Context, Handler } from './operations.mts';
import { pushSession, recordBrokerPush } from './attribution.mts';
import type { PushSession } from './attribution.mts';
import { canonicalRoot } from './config.mts';
import { protectedDirectory } from './key-access.mts';
import { checkRange } from './commit-range.mts';
import type { Git, Read } from './commit-range.mts';
// Dropped from every git child: tracing, injected configuration, askpass programs,
// alternative repositories, helper program locations, ambient tokens and the search
// path. Prompts are switched off.
const DROPPED = /^(?:PATH|GIT_EXEC_PATH|GIT_TRACE.*|GIT_CURL_VERBOSE|GIT_REDACT_COOKIES|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_SSH.*|GIT_PROXY_COMMAND|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GCM_TRACE.*)$/i;
// Git and the programs it starts come from fixed system locations, never from the caller's PATH.
const GIT_CANDIDATES = {win32:['C:\\Program Files\\Git\\cmd\\git.exe','C:\\Program Files\\Git\\bin\\git.exe'], posix:['/usr/bin/git','/usr/local/bin/git']};
const GIT_PATH = {win32:'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows', posix:'/usr/bin:/bin'};
export function gitEnv(env:NodeJS.ProcessEnv=process.env, platform:NodeJS.Platform=process.platform):NodeJS.ProcessEnv {
  const out:NodeJS.ProcessEnv={};
  for (const [k,v] of Object.entries(env)) if (v!==undefined && !DROPPED.test(k)) out[k]=v;
  return {...out, PATH:platform==='win32'?GIT_PATH.win32:GIT_PATH.posix, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'never', GIT_NO_REPLACE_OBJECTS:'1'};
}
const WINDOWS='C:\\Windows';
/**
 * The environment of every git child in a clean repository, constructed, never filtered: nothing
 * comes from the broker's environment, so no proxy, TLS or CA setting, trace, toolchain or Node
 * option reaches git or the programs it starts. HOME is the clean repository, so ~/.gitconfig,
 * ~/.config/git and ~/.netrc do not apply; system and global configuration are off. Windows
 * programs, Node's networking among them, need SystemRoot.
 */
export function cleanEnv(dir:string, platform:NodeJS.Platform=process.platform):NodeJS.ProcessEnv {
  const win=platform==='win32';
  return {PATH:win?GIT_PATH.win32:GIT_PATH.posix, HOME:dir, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:path.join(dir,'gitconfig'), GIT_ATTR_NOSYSTEM:'1',
    GIT_NO_REPLACE_OBJECTS:'1', GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'never', ...(win?{SystemRoot:WINDOWS,WINDIR:WINDOWS}:{})};
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
      if (!s.isFile()) continue;
      if (!win && !(rootOnly(s) && rootOnly(stat(path.posix.dirname(file))))) continue;
      if (isDefault) defaultGit=file;
      return file;
    } catch { /* Absent candidate: try the next one. */ }
  }
  return fail('git-unavailable');
}
function git(cwd:string, args:string[], env:NodeJS.ProcessEnv=gitEnv()):string|undefined {
  // Outside the try: a missing trusted git must fail `git-unavailable`, not read as an empty answer.
  const exe=trustedGit();
  try { return execFileSync(exe,args,{cwd,env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','ignore']}).trim(); }
  catch { return undefined; }
}
export type CleanRepo = {dir:string; toplevel:string; git:Git; read:Read; dispose:()=>void};
// Commit-graph files of an alternate object store would be trusted for parents during
// traversal, so a crafted one could hide a foreign ancestor; bitmaps likewise describe
// reachability. Both are off. Git still does not verify object hashes on read, so the
// preflight decides from bytes it hashed itself (commit-range.mts).
const CLEAN_CONFIG='[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tcommitGraph = false\n[pack]\n\tuseBitmaps = false\n';
const STALE_MS = 10*60000;
/**
 * A broker-owned bare repository that borrows only the session's objects through
 * objects/info/alternates: no repository configuration, hooks, refs (so no replace refs),
 * shallow file or grafts. It lives under the broker's private root, checked first (on Windows
 * the new directory is safe by inheriting that root's ACL), from mkdtemp (unpredictable, never
 * pre-created; on POSIX owned and private, else refused); the caller disposes of it in `finally`,
 * and clean repositories a crashed broker left there are removed after ten minutes. Discovery is
 * the only git call in the session repository, and it has no credential capability.
 */
export function cleanRepo(cwd:string, root:string):CleanRepo {
  const [toplevel,objects,extra]=git(cwd,['rev-parse','--path-format=absolute','--show-toplevel','--git-path','objects'])?.split('\n') ?? [];
  // An alternates line starting with # or a quote is special; an absolute path starts with neither.
  if (!toplevel || !objects || extra!==undefined || /[\r\n]/.test(objects) || !path.isAbsolute(objects) || !fs.statSync(objects,{throwIfNoEntry:false})?.isDirectory()) fail('target-refused');
  protectedDirectory(root);
  // A live push's repository is younger than its timeouts; an older one is a crash leftover.
  try {
    for (const name of fs.readdirSync(root).filter(n=>n.startsWith('kherep-push-'))) {
      const stale=path.join(root,name), s=fs.lstatSync(stale);
      if (s.isDirectory() && Date.now()-s.mtimeMs>STALE_MS) fs.rmSync(stale,{recursive:true,force:true});
    }
  } catch { /* Best effort: a leftover holds no secret. */ }
  const dir=fs.mkdtempSync(path.join(root,'kherep-push-'));
  const dispose=()=>{try {fs.rmSync(dir,{recursive:true,force:true,maxRetries:3});} catch { /* Best effort: the directory holds no secret. */ }};
  try {
    const s=fs.lstatSync(dir);
    if (process.platform!=='win32' && (!s.isDirectory() || s.uid!==process.getuid?.() || s.mode & 0o077)) fail('target-refused');
    fs.mkdirSync(path.join(dir,'refs'));fs.mkdirSync(path.join(dir,'objects','info'),{recursive:true});
    fs.writeFileSync(path.join(dir,'HEAD'),'ref: refs/heads/broker\n');
    fs.writeFileSync(path.join(dir,'objects','info','alternates'),`${objects.split(path.sep).join('/')}\n`);
    fs.writeFileSync(path.join(dir,'config'),CLEAN_CONFIG);
    fs.writeFileSync(path.join(dir,'gitconfig'),'');
  } catch (e) { dispose();throw e; }
  const read:Read=shas=>{
    const exe=trustedGit();
    try { return execFileSync(exe,['--git-dir',dir,'cat-file','--batch'],{cwd:dir,env:cleanEnv(dir),input:`${shas.join('\n')}\n`,windowsHide:true,timeout:30000,maxBuffer:256*1024*1024,stdio:['pipe','pipe','ignore']}); }
    catch { return undefined; }
  };
  return {dir,toplevel,dispose,read,git:args=>git(dir,['--git-dir',dir,...args],cleanEnv(dir))};
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
function run(dir:string, args:string[], env:NodeJS.ProcessEnv):Promise<boolean> {
  return new Promise(resolve=>{execFile(trustedGit(),args,{cwd:dir,env,timeout:120000,windowsHide:true,maxBuffer:1024*1024},error=>resolve(!error));});
}
// The session of a push in progress, resolved before the push, recorded after its readback.
const pushes=new WeakMap<Context,{session:PushSession; toplevel:string}>();
export const pushHandler: Handler = {
  kind:'push',
  fields:()=>({}),
  async preflight(c) {
    const {branch,sha}=c.request as {branch:string; sha:string}, main=c.target.default_branch;
    if (typeof main!=='string' || !refName(main) || branch===main || branch.startsWith('v')) fail('target-refused');
    const repo=cleanRepo(c.deps.cwd ?? process.cwd(),c.deps.root ?? canonicalRoot());
    try {
      // Both bases come from GitHub's readback, never from a ref of the caller's checkout.
      const current=await remoteSha(c,branch,'target-refused'), base=await remoteSha(c,main,'target-refused');
      if (!base) fail('target-refused');
      // Bot authorship, workflows and fast-forward, enforced here independently of the runtime.
      checkRange(repo.git,repo.read,{sha,base,current,emails:c.identity.authorEmails ?? []});
    } finally { repo.dispose(); }
    return {branch,sha,admittedAt:c.now};
  },
  async mutate(c, receipt) {
    const url=c.deps.push?.url ?? `https://github.com/${c.repo.slug}.git`;
    const helper=helperCommand(process.execPath,c.deps.push?.helperScript ?? helperScript(c.runtime),c.request.operationId);
    const repo=cleanRepo(c.deps.cwd ?? process.cwd(),c.deps.root ?? canonicalRoot());
    try {
      // Before the push: a Codex marker lives as long as the push may take.
      pushes.set(c,{session:pushSession(c.runtime,repo.toplevel,process.env,c.now),toplevel:repo.toplevel});
      // No repository hook runs here; KHEREP_BROKER_PUSH stays as a second stand-down for the pre-push hook.
      // The grant's nonce exists only in this child's environment, never in argv or a file.
      const {nonce,revoke}=c.permit();
      try {
        if (!await run(repo.dir,['--git-dir',repo.dir,...pushArgs(helper,url,receipt.sha!,receipt.branch!)],{...cleanEnv(repo.dir),KHEREP_BROKER_PUSH:'1',KHEREP_PUSH_GRANT:nonce})) fail('outcome-unknown');
      } finally { revoke(); }
    } finally { repo.dispose(); }
    return {};
  },
  known:receipt=>typeof receipt.branch==='string' && typeof receipt.sha==='string',
  async readback(c, receipt) {
    if (await remoteSha(c,receipt.branch!,'verification-failed')!==receipt.sha) fail('verification-failed');
  },
  ids:receipt=>pickIds(receipt,['branch','sha']),
  attribution:()=>'authenticated-installation',
  recorded(c, receipt) {
    const push=pushes.get(c);
    pushes.delete(c);
    return !!push && recordBrokerPush({...push,runtime:c.runtime,repo:c.repo.slug,branch:receipt.branch!,sha:receipt.sha!},process.env,Date.now());
  },
};
