import path from 'node:path';
import { BrokerError, fail, parseRequest } from './contract.mts';
import type { Runtime } from './contract.mts';
import { canonicalRoot, loadPolicy } from './config.mts';
import { readProtected } from './key-access.mts';
import { authenticate } from './auth.mts';
import { transport } from './transport.mts';
import { mutate, preflightIssue, readback } from './issues.mts';
import { ReceiptStore } from './receipt.mts';
import type { Receipt } from './receipt.mts';
export type Dependencies = {root?:string; fetch?:typeof fetch; now?:()=>number};
export async function execute(runtime:Runtime, text:string, deps:Dependencies={}):Promise<Record<string,unknown>> {
  let release:(()=>void)|undefined, receipt:Receipt|undefined;
  let publicIds:Record<string,unknown>={};
  try {
    const request=parseRequest(text), isVerify=request.operation==='verify', root=deps.root??canonicalRoot();
    const identity=await loadPolicy(root,runtime,request), repo=identity.repositories.find(r=>r.slug===request.repository)!;
    const store=new ReceiptStore(root,runtime,identity.appId,repo.slug,request.operationId,!isVerify);
    if(!isVerify) release=store.acquire();
    receipt=store.read();
    const safe=()=>({operationId:request.operationId,runtime,repository:repo.slug,...(receipt?.issueNumber?{issueNumber:receipt.issueNumber}:{}),...(receipt?.targetId?{targetId:receipt.targetId}:{})});
    if(!isVerify) publicIds=safe();
    if (isVerify && !receipt) fail('receipt-invalid');
    if (receipt && !isVerify && receipt.digest!==store.digest(request)) fail('operation-conflict');
    if (receipt?.status==='verified' && !isVerify) return {ok:true,...safe(),status:'verified',attribution:receipt.operation==='issue.update'?'authenticated-installation':'bot-author',bot:identity.botLogin};
    if (receipt?.status==='pending') fail('outcome-unknown');
    const key=await readProtected(path.join(root,'keys'),identity.keyRef,16384,root);
    const http=transport(deps.fetch);
    let token:string;
    try {token=await authenticate(http,key,identity,repo,(deps.now??Date.now)());}finally{key.fill(0);}
    if (!isVerify && !receipt) {
      if (request.issueNumber) await preflightIssue(http,token,repo.slug,request.issueNumber);
      receipt={version:1,digest:store.digest(request),operation:request.operation as Receipt['operation'],status:'pending',fieldHashes:store.fieldHashes(request),...(request.issueNumber?{issueNumber:request.issueNumber}:{})};
      store.write(receipt);
      try {
        const known=await mutate(http,token,request);receipt={...receipt,...known};
        if(!isVerify) publicIds=safe();
        if (receipt.targetId && receipt.issueNumber) receipt.status='known';
        store.write(receipt);
      } catch {publicIds=safe();fail('outcome-unknown');}
    }
    if(!isVerify) publicIds=safe();
    if (!receipt || receipt.status==='pending') fail('outcome-unknown');
    await readback(http,token,repo.slug,identity,receipt);
    if(!isVerify) {receipt.status='verified';store.write(receipt);}
    return {ok:true,...safe(),status:'verified',attribution:receipt.operation==='issue.update'?'authenticated-installation':'bot-author',bot:identity.botLogin};
  } catch(e) {return {ok:false,error:e instanceof BrokerError?e.code:'receipt-invalid',...publicIds};}
  finally {try{release?.();}catch{/* Retained lock remains fail closed. */}}
}
