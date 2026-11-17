import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { exact, fail, GITHUB_OPERATIONS, ISSUE_OPERATIONS, object, positive, payload, refName, SHA } from './contract.mts';
import type { Operation, Request, Runtime } from './contract.mts';
import { protectedDirectory, readProtectedSync } from './key-access.mts';
import { checkWindowsAccess } from './windows-access.mts';
// Version 1 records an issue operation; version 2 a push, pull request or run
// operation, with its kind and public targets (a merge adds the merge commit
// `mergeSha` when GitHub answered). Neither ever holds a body or token.
export type Receipt = {version:1|2; kind?:'push'|'pull'|'run'; digest:string; operation:Operation; status:'pending'|'known'|'verified'; fieldHashes:Record<string,string>; issueNumber?:number; targetId?:number;
  branch?:string; sha?:string; prNumber?:number; runId?:number; attempt?:number; admittedAt?:number; mergeSha?:string};
const KIND:Record<string,Receipt['kind']>={'branch.push':'push','pr.create':'pull','pr.update':'pull','pr.comment':'pull','run.rerun':'run','run.cancel':'run','pr.merge':'pull'};
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ReceiptStore {
  directory:string; file:string; lock:string; grant:string; root:string;
  constructor(root:string, runtime:Runtime, appId:number, repo:string, operationId:string, createDirectory=true) {
    protectedDirectory(root);this.root=root;
    this.directory=path.join(root,'receipts');
    if (!fs.existsSync(this.directory)) {
      if (!createDirectory || process.platform==='win32') fail('receipt-invalid');
      fs.mkdirSync(this.directory,{mode:0o700});
    }
    protectedDirectory(this.directory,root);
    this.file=path.join(this.directory,`${hash([runtime,appId,repo,operationId])}.json`);
    this.lock=`${this.file}.lock`;
    this.grant=`${this.file}.grant`;
  }
  digest(request:Request): string {
    if ((ISSUE_OPERATIONS as readonly string[]).includes(request.operation)) return hash([request.operation,request.repository,request.issueNumber ?? null,payload(request)]);
    const fields=Object.entries(request).filter(([k])=>!['operationId','repository','operation'].includes(k)).sort(([a],[b])=>byCodeUnit(a,b));
    return hash([request.operation,request.repository,fields]);
  }
  fieldHashes(request:Request): Record<string,string> { return this.hashFields(payload(request)); }
  hashFields(fields:Record<string,unknown>): Record<string,string> { return Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,hash(k==='labels'?[...v as string[]].sort(byCodeUnit):v)])); }
  acquire():()=>void {
    try { exclusive(this.lock,this.root); } catch { return fail('operation-busy'); }
    return ()=>{fs.unlinkSync(this.lock);};
  }
  /**
   * The one credential grant of a push, created exclusively while this broker holds the lock. The
   * file holds only the SHA-256 of a fresh nonce, which the caller passes to its git child's
   * environment alone. The helper's first `get` that presents the nonce redeems it; `revoke`
   * removes an unused one.
   */
  permit():{nonce:string; revoke:()=>void} {
    const revoke=()=>{try {fs.rmSync(this.grant,{force:true});} catch { /* A remaining grant still expires with the 120 s window. */ }};
    if (!fs.lstatSync(this.lock,{throwIfNoEntry:false})?.isFile()) fail('operation-busy');
    const nonce=randomBytes(32).toString('hex');
    try { exclusive(this.grant,this.root,sha256(nonce)); } catch { revoke();return fail('operation-busy'); }
    return {nonce,revoke};
  }
  /** True only for the caller that presented the grant's nonce and removed the grant; a wrong nonce leaves it. */
  redeem(nonce:unknown):boolean {
    try {
      if (typeof nonce!=='string' || !HEX64.test(nonce)) return false;
      const stored=readProtectedSync(this.directory,path.basename(this.grant),64,this.root).toString('latin1');
      if (!HEX64.test(stored) || !timingSafeEqual(Buffer.from(sha256(nonce),'hex'),Buffer.from(stored,'hex'))) return false;
      fs.unlinkSync(this.grant);return true;
    } catch { return false; }
  }
  read():Receipt | undefined {
    try {
      const s=fs.lstatSync(this.file,{throwIfNoEntry:false}); if (!s) return;
      const r=object(JSON.parse(readProtectedSync(this.directory,path.basename(this.file),4096,this.root).toString('utf8')));
      if (r.version===1) {
        exact(r,['version','digest','operation','status','fieldHashes','issueNumber','targetId']);
        if (!(ISSUE_OPERATIONS as readonly string[]).includes(String(r.operation))) fail('receipt-invalid');
      } else {
        exact(r,['version','kind','digest','operation','status','fieldHashes','targetId','branch','sha','prNumber','runId','attempt','admittedAt','mergeSha']);
        if (r.version!==2 || !(GITHUB_OPERATIONS as readonly string[]).includes(String(r.operation)) || r.kind!==KIND[String(r.operation)]) fail('receipt-invalid');
        if (r.branch!==undefined && !refName(r.branch) || [r.sha,r.mergeSha].some(v=>v!==undefined && !SHA.test(String(v))) || [r.prNumber,r.runId,r.attempt,r.admittedAt].some(v=>v!==undefined && !positive(v))) fail('receipt-invalid');
      }
      if (!/^[a-f0-9]{64}$/.test(String(r.digest)) || !['pending','known','verified'].includes(String(r.status))) fail('receipt-invalid');
      const fields=object(r.fieldHashes);exact(fields,['title','body','labels','state','state_reason','base','head','draft']);
      if (Object.values(fields).some(v=>typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) || r.issueNumber !== undefined && !positive(r.issueNumber) || r.targetId !== undefined && !positive(r.targetId)) fail('receipt-invalid');
      if (r.status !== 'pending' && !known(r as Receipt)) fail('receipt-invalid');
      return r as Receipt;
    } catch { return fail('receipt-invalid'); }
  }
  write(receipt:Receipt):void {
    const temp=`${this.file}.${randomUUID()}.tmp`;
    try {
      if (!fs.existsSync(this.file) && fs.readdirSync(this.directory).length >= 4096) fail('receipt-full');
      const fd=fs.openSync(temp,'wx',0o600);
      try { if(process.platform==='win32') checkWindowsAccess(temp,this.root);fs.writeFileSync(fd,JSON.stringify(receipt));fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp,this.file);
      if(process.platform==='win32') checkWindowsAccess(this.file,this.root);
      if (process.platform !== 'win32') { const dir=fs.openSync(this.directory,'r'); try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);} }
    } catch { if (fs.existsSync(temp)) fs.unlinkSync(temp);fail('receipt-invalid'); }
  }
}
const HEX64=/^[a-f0-9]{64}$/;
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
// Created with O_EXCL and mode 0600, on Windows ACL-checked, filled with `content` and synced; throws when it exists or is unsafe.
function exclusive(file:string, root:string, content=''):void {
  const fd=fs.openSync(file,'wx',0o600);
  try {if(process.platform==='win32') checkWindowsAccess(file,root);if (content) fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
// A settled receipt names its target: issue and PR number with target ID, branch with sha, or run with attempt.
function known(r:Receipt):boolean {
  if (r.kind==='push') return !!r.branch && !!r.sha;
  if (r.kind==='run') return positive(r.runId) && positive(r.attempt);
  return r.kind==='pull' ? positive(r.prNumber) && positive(r.targetId) : positive(r.issueNumber) && positive(r.targetId);
}
// GitHub returns labels as objects, in its own order; the receipt keeps the sorted names.
// The order feeds a stored hash, so it must not depend on the host's locale.
const byCodeUnit=(a:string,b:string):number=>a<b?-1:Number(a>b);
const labelNames=(labels:unknown):string[]=>Array.isArray(labels)?labels.map(l=>String(l?.name)).sort(byCodeUnit):[];
export function matchesFields(value:Record<string,unknown>, hashes:Record<string,string>):boolean {
  return Object.entries(hashes).every(([k,v])=>hash(k==='labels'?labelNames(value.labels):value[k])===v);
}
