import fs from 'node:fs';
import path from 'node:path';
import { fail, slug, UUID } from './contract.mts';
import type { Request, Runtime } from './contract.mts';
import { canonicalRoot, loadPolicy } from './config.mts';
import { readProtected } from './key-access.mts';
import { authenticate } from './auth.mts';
import { transport } from './transport.mts';
import { ReceiptStore } from './receipt.mts';
import { isMainModule } from './cli.mts';
import type { Dependencies } from './operations.mts';
export const PUSH_WINDOW_MS = 120000;
const MAX_INPUT = 4096;
function parse(input:string):Map<string,string> {
  if (Buffer.byteLength(input)>MAX_INPUT) fail('invalid-request');
  const fields=new Map<string,string>();
  for (const line of input.split('\n')) {
    if (!line) continue;
    const at=line.indexOf('='), key=line.slice(0,at), value=line.slice(at+1);
    if (at<1) fail('invalid-request');
    if (key==='capability[]' || key==='wwwauth[]') continue;
    if (!['protocol','host','path'].includes(key) || fields.has(key)) fail('invalid-request');
    fields.set(key,value);
  }
  return fields;
}
/**
 * Git credential helper of one runtime, started by the broker's own push only.
 * argv is `<operationId> <action>`. It answers `get` for exactly
 * https://github.com/<allowlisted slug>.git, and only while the broker holds the
 * lock of a pending branch.push receipt for that operation admitted less than
 * 120 s ago. The contents-scoped token goes to git's pipe and nowhere else.
 * `store` and `erase` get no answer: nothing is ever persisted.
 */
export async function credential(runtime:Runtime, argv:string[], input:string, deps:Dependencies={}):Promise<string> {
  if (argv.length!==2 || !UUID.test(argv[0]) || !/^[a-z]{1,10}$/.test(argv[1])) fail('invalid-request');
  if (argv[1]!=='get') return '';
  const fields=parse(input), repository=fields.get('path')?.replace(/\.git$/,'');
  if (fields.get('protocol')!=='https' || fields.get('host')!=='github.com' || !fields.get('path')?.endsWith('.git') || !slug(repository)) fail('target-refused');
  const request:Request={operationId:argv[0].toLowerCase(),repository,operation:'branch.push'};
  const root=deps.root??canonicalRoot(), identity=await loadPolicy(root,runtime,request);
  const repo=identity.repositories.find(r=>r.slug===repository)!;
  const store=new ReceiptStore(root,runtime,identity.appId,repo.slug,request.operationId,false);
  const receipt=store.read(), now=(deps.now??Date.now)(), lock=fs.lstatSync(store.lock,{throwIfNoEntry:false});
  if (receipt?.operation!=='branch.push' || receipt.status!=='pending' || !receipt.admittedAt || now-receipt.admittedAt>PUSH_WINDOW_MS || receipt.admittedAt-now>5000 || !lock?.isFile()) fail('auth-refused');
  const key=await readProtected(path.join(root,'keys'),identity.keyRef,16384,root);
  let token:string;
  try { token=await authenticate(transport(deps.fetch),key,identity,repo,now,{contents:'write'}); } finally { key.fill(0); }
  return `username=x-access-token\npassword=${token}\n`;
}
export function credentialEntry(runtime:Runtime) { return (argv:string[], input:string, deps:Dependencies={})=>credential(runtime,argv,input,deps); }
/** Any refusal is silent: no output, exit 1. Git then has no credential and stops. */
export async function startCredential(runtime:Runtime, url:string):Promise<void> {
  if (!isMainModule(url)) return;
  try {
    const chunks:Buffer[]=[];let bytes=0;
    for await (const chunk of process.stdin) {const b=Buffer.from(chunk);bytes+=b.length;if (bytes>MAX_INPUT) throw new Error();chunks.push(b);}
    process.stdout.write(await credential(runtime,process.argv.slice(2),Buffer.concat(chunks).toString('utf8')));
  } catch { process.exitCode=1; }
}
