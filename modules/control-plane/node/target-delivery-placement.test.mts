import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {successorNode} from './target-resume-fixture.mts';
import {deliver,SESSION,PEER} from './closed-fixture.mts';
import {deliverToClosed} from './closed-delivery.mts';
import {getMessage,storeMessage,listInbox,markOffered} from './inbox.mts';
import {locateInboxRecord,PROCESSING_NAMESPACE} from './inbox-storage.mts';
import {withRoute,routeHistory} from './target-delivery-route.mts';
import {budgetFile} from './budget-store.mts';

for(const runtime of ['codex','claude-code'] as const)for(const bound of [false,true])test(`fresh ${runtime} ${bound?'bound-v1':'flat'} placement preserves every original field`,async t=>{
 const n=successorNode(t,runtime);let id:string;
 if(bound){id='aaaa0000-0000-4000-8000-000000000706';storeMessage(n.paths.inbox,{messageId:id,from:PEER,toSession:SESSION,text:'BOUND ORIGINAL BODY',createdAt:new Date(n.deps().now!()).toISOString(),senderOrigin:{nodeId:PEER.nodeId,sentAt:new Date(n.deps().now!()-5000).toISOString()},binding:{version:1,mode:'exact',leaseId:'aaaa0000-0000-4000-8000-000000000707',localGeneration:1,from:{sessionId:PEER.session,runtime:'codex',lifecycleGeneration:1},to:{sessionId:SESSION,runtime,lifecycleGeneration:7}}},n.deps().now!()-5000);}
 else id=deliver(n);
 const original=getMessage(n.paths.inbox,id)!,source=locateInboxRecord(n.paths.inbox,id)!.file;
 let observed=false;const unlink=fs.unlinkSync;t.mock.method(fs,'unlinkSync',((file:fs.PathLike)=>{if(String(file)===source){const envelope=JSON.parse(fs.readFileSync(path.join(n.paths.inbox,PROCESSING_NAMESPACE,id+'.json'),'utf8'));const {targetAttempt,...preserved}=envelope.record;assert.ok(targetAttempt);assert.deepEqual(preserved,original);observed=true;}return unlink(file);}) as typeof fs.unlinkSync);
 await deliverToClosed(n.deps());t.mock.restoreAll();assert.equal(observed,true);
 const location=locateInboxRecord(n.paths.inbox,id)!;assert.equal(location.namespace,PROCESSING_NAMESPACE);assert.equal(fs.existsSync(source),false);
 for(const key of ['messageId','from','toSession','text','createdAt','senderOrigin','receivedAt','binding','loop'] as const)assert.deepEqual(location.record[key],original[key]);
 assert.ok(location.record.targetAttempt);const placement=withRoute(n.paths,location.record.targetAttempt,s=>s.processing?.placement)!;assert.equal(placement.phase,'committed');assert.equal(placement.members[0].source,bound?'bound-v1':'flat');
 assert.equal(runtime==='codex'?n.queues.length:n.control.effects,1);assert.equal(listInbox(n.paths.inbox).length,1);
 const envelope=JSON.parse(fs.readFileSync(location.file,'utf8'));assert.deepEqual(Object.keys(envelope).sort(),['kind','record','version']);assert.equal(envelope.version,2);assert.equal(envelope.kind,'explicit-processing');
});
for(const fault of ['already-offered','source-change','intent','target-publish','source-unlink','commit'] as const)test(`placement ${fault} remains held without native effect or debit`,async t=>{
 const n=successorNode(t,'claude-code'),id=deliver(n),source=locateInboxRecord(n.paths.inbox,id)!.file;
 if(fault==='already-offered')markOffered(n.paths.inbox,id,n.deps().now!());
 let triggered=false;const write=fs.writeFileSync,link=fs.linkSync,unlink=fs.unlinkSync,rename=fs.renameSync;
 if(fault==='source-change'){const prepare=n.deps().targetResumePort.prepare.bind(n.deps().targetResumePort);const deps={...n.deps(),targetResumePort:{async prepare(...args:Parameters<typeof prepare>){const p=await prepare(...args);markOffered(n.paths.inbox,id,n.deps().now!());triggered=true;return p;}}};await deliverToClosed(deps);}
 else {
  if(fault==='intent'){let ownerFd=-1;const open=fs.openSync;t.mock.method(fs,'openSync',((file:fs.PathLike,...args:unknown[])=>{const fd=Reflect.apply(open,fs,[file,...args]);if(String(file)===path.join(n.paths.dir,'codex-native-pending',SESSION+'.json'))ownerFd=fd;return fd;}) as typeof fs.openSync);t.mock.method(fs,'writeFileSync',((file:fs.PathOrFileDescriptor,...args:Parameters<typeof fs.writeFileSync> extends [unknown,...infer R]?R:never)=>{if(typeof file==='number'&&file===ownerFd&&!triggered){triggered=true;throw Error('synthetic placement intent crash');}return write(file,...args);}) as typeof fs.writeFileSync);}
  if(fault==='target-publish')t.mock.method(fs,'linkSync',((a:fs.PathLike,b:fs.PathLike)=>{triggered=true;throw Error('synthetic publish crash');}) as typeof fs.linkSync);
  if(fault==='source-unlink')t.mock.method(fs,'unlinkSync',((file:fs.PathLike)=>{if(String(file)===source){triggered=true;throw Error('synthetic unlink crash');}return unlink(file);}) as typeof fs.unlinkSync);
  if(fault==='commit')t.mock.method(fs,'renameSync',((a:fs.PathLike,b:fs.PathLike)=>{if(String(b).includes('codex-native-pending')){triggered=true;throw Error('synthetic placement commit crash');}return rename(a,b);}) as typeof fs.renameSync);
  await deliverToClosed(n.deps());t.mock.restoreAll();
 }
 assert.equal(n.control.effects,0);assert.equal(n.queues.length,0);assert.equal(fs.existsSync(budgetFile(n.paths,SESSION)),false);
 if(fault!=='already-offered')assert.equal(triggered,true);
 if(fault==='source-unlink')await assert.rejects(deliverToClosed(n.deps()),/duplicate inbox record/);else await deliverToClosed(n.deps());assert.equal(n.control.effects,0);assert.equal(n.queues.length,0);assert.equal(fs.existsSync(budgetFile(n.paths,SESSION)),false);
});

for(const fault of ['version','kind','extra','message-id','handle','unmarked-route','duplicate'] as const)test(`processing envelope refuses ${fault} without another effect`,async t=>{
 const n=successorNode(t,'claude-code'),id=deliver(n);await deliverToClosed(n.deps());
 const loc=locateInboxRecord(n.paths.inbox,id)!,envelope=JSON.parse(fs.readFileSync(loc.file,'utf8')),handle=loc.record.targetAttempt!,budget=fs.readFileSync(budgetFile(n.paths,SESSION));
 if(fault==='version')envelope.version=3;if(fault==='kind')envelope.kind='other';if(fault==='extra')envelope.extra=true;if(fault==='message-id')envelope.record.messageId=SESSION;if(fault==='handle')delete envelope.record.targetAttempt;
 if(fault==='unmarked-route'){
  const s=withRoute(n.paths,handle,s=>s),{processing:_marker,...unmarked}=s;
  for(const file of new Set([path.join(n.paths.dir,'codex-native-pending',SESSION+'.json'),routeHistory(n.paths,handle)]))fs.writeFileSync(file,JSON.stringify(unmarked));
  assert.throws(()=>withRoute(n.paths,handle,s=>s),/processing placement not committed/);
 }else if(fault==='duplicate'){
  fs.writeFileSync(path.join(n.paths.inbox,id+'.json'),JSON.stringify(loc.record));assert.throws(()=>locateInboxRecord(n.paths.inbox,id),/duplicate inbox record/);
 }else {fs.writeFileSync(loc.file,JSON.stringify(envelope));assert.throws(()=>locateInboxRecord(n.paths.inbox,id));}
 assert.equal(n.control.effects,1);assert.deepEqual(fs.readFileSync(budgetFile(n.paths,SESSION)),budget);
});
