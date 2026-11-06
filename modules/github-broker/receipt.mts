import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { exact, fail, object, positive, payload } from './contract.mts';
import type { Operation, Request, Runtime } from './contract.mts';
import { protectedDirectory, readProtectedSync } from './key-access.mts';
import { checkWindowsAccess } from './windows-access.mts';
export type Receipt = {version:1; digest:string; operation:Operation; status:'pending'|'known'|'verified'; fieldHashes:Record<string,string>; issueNumber?:number; targetId?:number};
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ReceiptStore {
  directory:string; file:string; lock:string; root:string;
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
  }
  digest(request:Request): string { return hash([request.operation,request.repository,request.issueNumber ?? null,payload(request)]); }
  fieldHashes(request:Request): Record<string,string> { return Object.fromEntries(Object.entries(payload(request)).map(([k,v])=>[k,hash(k==='labels'?[...v as string[]].sort():v)])); }
  acquire():()=>void {
    try {
      const fd=fs.openSync(this.lock,'wx',0o600);
      try {if(process.platform==='win32') checkWindowsAccess(this.lock,this.root);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    catch { return fail('operation-busy'); }
    return ()=>{fs.unlinkSync(this.lock);};
  }
  read():Receipt | undefined {
    try {
      const s=fs.lstatSync(this.file,{throwIfNoEntry:false}); if (!s) return;
      const r=object(JSON.parse(readProtectedSync(this.directory,path.basename(this.file),4096,this.root).toString('utf8')));
      exact(r,['version','digest','operation','status','fieldHashes','issueNumber','targetId']);
      if (r.version !== 1 || !/^[a-f0-9]{64}$/.test(String(r.digest)) || !['issue.create','issue.comment','issue.update'].includes(String(r.operation)) || !['pending','known','verified'].includes(String(r.status))) fail('receipt-invalid');
      const fields=object(r.fieldHashes);exact(fields,['title','body','labels','state','state_reason']);
      if (Object.values(fields).some(v=>typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) || r.issueNumber !== undefined && !positive(r.issueNumber) || r.targetId !== undefined && !positive(r.targetId) || r.status !== 'pending' && (!positive(r.issueNumber) || !positive(r.targetId))) fail('receipt-invalid');
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
// GitHub returns labels as objects, in its own order; the receipt keeps the sorted names.
const labelNames=(labels:unknown):string[]=>Array.isArray(labels)?labels.map(l=>String(l?.name)).sort():[];
export function matchesFields(value:Record<string,unknown>, hashes:Record<string,string>):boolean {
  return Object.entries(hashes).every(([k,v])=>hash(k==='labels'?labelNames(value.labels):value[k])===v);
}
