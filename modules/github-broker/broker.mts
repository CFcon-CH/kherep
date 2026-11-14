import path from 'node:path';
import { BrokerError, fail, parseRequest } from './contract.mts';
import type { Operation, Runtime } from './contract.mts';
import { canonicalRoot, loadPolicy } from './config.mts';
import { readProtected } from './key-access.mts';
import { authenticateRepository } from './auth.mts';
import { transport } from './transport.mts';
import { ReceiptStore } from './receipt.mts';
import type { Receipt } from './receipt.mts';
import { botIdentity, HANDLERS, permissionsFor } from './operations.mts';
import type { Context, Dependencies } from './operations.mts';
export type { Dependencies } from './operations.mts';
export async function execute(runtime:Runtime, text:string, deps:Dependencies={}):Promise<Record<string,unknown>> {
  let release:(()=>void)|undefined, receipt:Receipt|undefined;
  let publicIds:Record<string,unknown>={};
  try {
    const request=parseRequest(text), isVerify=request.operation==='verify', root=deps.root??canonicalRoot();
    const identity=await loadPolicy(root,runtime,request), repo=identity.repositories.find(r=>r.slug===request.repository)!;
    // Commit identity only: no key, no network, no receipt.
    if (request.operation==='identity') return {ok:true,operationId:request.operationId,runtime,repository:repo.slug,operation:'identity',...botIdentity(identity),bot:identity.botLogin};
    if ((request.operation==='issue.create'||request.operation==='pr.create')&&repo.moduleLabels&&!request.labels?.some(l=>repo.moduleLabels!.includes(l))) fail('label-required');
    const store=new ReceiptStore(root,runtime,identity.appId,repo.slug,request.operationId,!isVerify);
    if(!isVerify) release=store.acquire();
    receipt=store.read();
    if (isVerify && !receipt) fail('receipt-invalid');
    const operation=(isVerify?receipt!.operation:request.operation) as Operation, handler=HANDLERS[operation];
    // The operation name tells a reader (the attribution recorder) what a new-style write did; verify never claims a write.
    const named=!isVerify&&handler.kind!=='issue'?{operation}:{};
    const safe=()=>({operationId:request.operationId,runtime,repository:repo.slug,...named,...(receipt?handler.ids(receipt):{})});
    const done=()=>({ok:true,...safe(),status:'verified',attribution:handler.attribution(receipt!),bot:identity.botLogin});
    if(!isVerify) publicIds=safe();
    if (receipt && !isVerify && receipt.digest!==store.digest(request)) fail('operation-conflict');
    if (receipt?.status==='verified' && !isVerify) return done();
    if (receipt?.status==='pending') fail('outcome-unknown');
    const key=await readProtected(path.join(root,'keys'),identity.keyRef,16384,root);
    const http=transport(deps.fetch), now=(deps.now??Date.now)();
    const labels=isVerify?Object.hasOwn(receipt!.fieldHashes,'labels'):!!request.labels;
    let auth:{token:string; target:Record<string,unknown>};
    try {auth=await authenticateRepository(http,key,identity,repo,now,permissionsFor(operation,labels));}finally{key.fill(0);}
    const context:Context={http,token:auth.token,target:auth.target,request,identity,repo,runtime,now,deps};
    if (!isVerify && !receipt) {
      const admitted=await handler.preflight(context);
      receipt={version:handler.kind==='issue'?1:2,...(handler.kind!=='issue'?{kind:handler.kind}:{}),digest:store.digest(request),operation,status:'pending',fieldHashes:store.hashFields(handler.fields(request)),...admitted} as Receipt;
      store.write(receipt);
      const save=(known:Partial<Receipt>)=>{receipt={...receipt!,...known};if(handler.known(receipt))receipt.status='known';store.write(receipt);publicIds=safe();};
      try {save(await handler.mutate(context,receipt,save));} catch {publicIds=safe();fail('outcome-unknown');}
    }
    if(!isVerify) publicIds=safe();
    if (!receipt || receipt.status==='pending') fail('outcome-unknown');
    await handler.readback(context,receipt);
    if(!isVerify) {receipt.status='verified';store.write(receipt);}
    return done();
  } catch(e) {return {ok:false,error:e instanceof BrokerError?e.code:'receipt-invalid',...publicIds};}
  finally {try{release?.();}catch{/* Retained lock remains fail closed. */}}
}
