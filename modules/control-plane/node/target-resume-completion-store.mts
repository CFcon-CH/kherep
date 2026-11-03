import {explicitProcessingComplete} from './target-delivery-processing.mts';
/** Cooperative structural retirement, never a replacement admission or native completion proof. */
import fs from 'node:fs';
import path from 'node:path';
import {withOriginalCompletionAdmission} from './message-admission.mts';
import type {PolicyDeps} from './message-admission-policy.mts';
import type {NodePaths} from './config.mts';
import {withNativeOwnerRecords} from './codex-native-pending.mts';
import {getMessage} from './inbox.mts';
import {readTargetRecord,writeTargetRecord} from './target-delivery-files.mts';
import {canonical,hash,integer,keys,object,targetProcessedMembersMatch,uuid} from './target-delivery-state.mts';
import {digest,parseRouteReservation,parseTargetOperation,type ExecutionContext,type RouteReservation,type TargetOperation} from './target-delivery-operation.mts';
import {parseTargetHandle,type TargetHandle,type TargetDebit} from './target-delivery-reservation.mts';
import {routeAliases,routeHistory,routeMembersCurrent,routeSnapshot,verifyRouteDebit} from './target-delivery-route.mts';

import type {OriginalCompletionExpectation} from './target-resume-port.mts';
type CompletedOriginalTurn=OriginalCompletionExpectation;
export type OriginalRetirementResult={status:'retired'|'already-retired'|'refused'|'unavailable'|'incomplete'|'unknown'};
export interface OriginalCompletionProvider {
 withCompletedTurnFence(expected:OriginalCompletionExpectation,consume:(turn:CompletedOriginalTurn)=>OriginalRetirementResult):OriginalRetirementResult;
}
interface Receipt {
 version:1;kind:'original-resume-retirement';phase:'prepared'|'committed';handle:TargetHandle;aliases:string[];completion:CompletedOriginalTurn;
 routeFingerprint:string;membersFingerprint:string;transitionsFingerprint:string;debit:TargetDebit;
}
const expected=(s:RouteReservation):{handle:TargetHandle;operation:TargetOperation;lifecycleGeneration:number}=>({handle:s.handle,operation:s.consumer??s.group.operation,lifecycleGeneration:s.group.binding.lifecycleGeneration});
function completion(value:unknown):CompletedOriginalTurn {
 if(!object(value)||!keys(value,['handle','operation','lifecycleGeneration','runtime','sessionId','cwd','permissionMode','turnId','providerEpoch','background','originalChat'])||!integer(value.lifecycleGeneration)||!uuid(value.sessionId)||!uuid(value.providerEpoch)||typeof value.turnId!=='string'||!/^[a-zA-Z0-9._:-]{1,200}$/.test(value.turnId)||typeof value.cwd!=='string'||value.cwd.length>4096||typeof value.permissionMode!=='string'||value.permissionMode.length>64||value.background!==true||value.originalChat!==true)throw Error('original completion invalid');
 const handle=parseTargetHandle(value.handle),operation=parseTargetOperation(value.operation);
 if(operation.kind!=='exec-resume'||operation.execution.sessionId!==value.sessionId||operation.execution.runtime!==value.runtime||handle.owner!==value.sessionId||operation.producer?.launch?.cwd!==value.cwd)throw Error('original completion differs');return {...value,handle,operation} as unknown as CompletedOriginalTurn;
}
function receipt(value:unknown):Receipt {
 if(!object(value)||!keys(value,['version','kind','phase','handle','aliases','completion','routeFingerprint','membersFingerprint','transitionsFingerprint','debit'])
  ||value.version!==1||value.kind!=='original-resume-retirement'||!['prepared','committed'].includes(value.phase as string)
  ||!Array.isArray(value.aliases)||!value.aliases.length||value.aliases.length>64||!value.aliases.every(uuid)
  ||canonical(value.aliases)!==canonical([...new Set(value.aliases)].sort())
  ||![value.routeFingerprint,value.membersFingerprint,value.transitionsFingerprint].every(hash)
  ||!object(value.debit)||!keys(value.debit,['budgetId','chargedAt'])||!uuid(value.debit.budgetId)||!integer(value.debit.chargedAt))throw Error('retirement receipt invalid');
 const handle=parseTargetHandle(value.handle),turn=completion(value.completion);
 if(!value.aliases.includes(handle.owner)||canonical(handle)!==canonical(turn.handle))throw Error('retirement receipt handle differs');
 return {...value,handle,completion:turn} as unknown as Receipt;
}
function location(paths:NodePaths,handle:TargetHandle,create=false):string {
 const h=parseTargetHandle(handle),base=path.join(paths.dir,'target-delivery-original-completions'),dir=path.join(base,h.owner);
 for(const d of [base,dir]) {
  if(create)fs.mkdirSync(d,{recursive:true,mode:0o700});
  const st=fs.lstatSync(d,{throwIfNoEntry:false});
  if(st&&(!st.isDirectory()||st.isSymbolicLink()||process.platform!=='win32'&&(st.uid!==process.getuid?.()||(st.mode&0o022)!==0)))throw Error('retirement namespace unsafe');
 }
 if(create){const entries=fs.readdirSync(dir,{withFileTypes:true});
  if(entries.length>1024||entries.some(e=>!e.isFile()||!uuid(e.name.replace(/\.json$/,''))||!e.name.endsWith('.json'))
   ||entries.length===1024&&!entries.some(e=>e.name===h.groupId+'.json'))throw Error('retirement namespace capacity');}
 return path.join(dir,h.groupId+'.json');
}
function read(paths:NodePaths,h:TargetHandle):Receipt|null {
 const raw=readTargetRecord(location(paths,h));if(raw===null)return null;const r=receipt(raw);
 if(canonical(r.handle)!==canonical(h))throw Error('retirement handle changed');return r;
}
function finalRoute(paths:NodePaths,s:RouteReservation):string {
 const op=s.consumer??s.group.operation;
 if(op.kind!=='exec-resume'||s.phase!=='settled'||s.outcome?.kind!=='exec'||s.outcome.threadId!==s.owner
  ||s.originalResume?.phase!=='observed'||s.outcomes.filter(o=>o.kind==='exec').length!==1||s.conflicts?.length||s.adoptions?.some(a=>a.phase!=='converged')
  ||s.transitions.some(t=>t.applied!==true)||!routeMembersCurrent(paths,s))throw Error('hook route not complete');
 const rows=s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!);
 if(!s.processing||!explicitProcessingComplete(s,rows,token=>readTargetRecord(path.join(paths.inbox,'codex-offers',token+'.json'))))throw Error('explicit processing incomplete');
 if(!targetProcessedMembersMatch(s.group.binding,rows.map(row=>({...row,closedAttempt:undefined})),s.group.binding.nodeId)
  ||rows.some(row=>canonical(row.targetAttempt)!==canonical(s.handle)))throw Error('hook members incomplete');
 verifyRouteDebit(paths,s);return digest(rows.map(routeSnapshot));
}
function snapshot(paths:NodePaths,s:RouteReservation,turn:CompletedOriginalTurn,phase:Receipt['phase']):Receipt {
 const memberFingerprint=finalRoute(paths,s);
 if(canonical(expected(s))!==canonical({handle:turn.handle,operation:turn.operation,lifecycleGeneration:turn.lifecycleGeneration}))throw Error('completed turn differs');
 return receipt({version:1,kind:'original-resume-retirement',phase,handle:s.handle,aliases:routeAliases(s),completion:turn,
  routeFingerprint:digest(s),membersFingerprint:memberFingerprint,transitionsFingerprint:digest(s.transitions),debit:s.budget});
}
function boundRoute(paths:NodePaths,r:Receipt):RouteReservation {
 const s=parseRouteReservation(readTargetRecord(routeHistory(paths,r.handle)));
 const budgetHistory=path.join(paths.dir,'target-delivery-groups',(s.consumer??s.group.operation).budgetOwner,r.handle.groupId+'.route.json');
 if(canonical(parseRouteReservation(readTargetRecord(budgetHistory)))!==canonical(s)
  ||canonical(snapshot(paths,s,r.completion,'committed'))!==canonical(r))throw Error('retirement history differs');return s;
}
function remove(paths:NodePaths,r:Receipt,file:(owner:string)=>string):OriginalRetirementResult {
 let removed=false;
 const validate=()=>{
  const current=read(paths,r.handle);if(canonical(current)!==canonical(r))throw Error('committed receipt changed');
  const s=boundRoute(paths,r);
  for(const owner of r.aliases){const raw=readTargetRecord(file(owner));
   if(raw!==null&&canonical(raw)!==canonical(owner===r.handle.owner?s:{version:4,owner,handle:r.handle}))throw Error('owner replaced');}
 };
 validate();
 for(const owner of [...r.aliases.filter(o=>o!==r.handle.owner),r.handle.owner]) {
  // Recheck history, transitions, complete members/debit and every remaining owner before EACH unlink.
  validate();if(readTargetRecord(file(owner))===null)continue;
  fs.unlinkSync(file(owner));removed=true;if(readTargetRecord(file(owner))!==null)throw Error('owner removal unconfirmed');
 }
 return {status:removed?'retired':'already-retired'};
}
function fenced(provider:OriginalCompletionProvider|undefined,want:OriginalCompletionExpectation,
 body:(turn:CompletedOriginalTurn)=>OriginalRetirementResult):OriginalRetirementResult {
 if(!provider||typeof provider.withCompletedTurnFence!=='function'||provider.withCompletedTurnFence.constructor.name==='AsyncFunction')return {status:'unavailable'};
 let active=true,result:OriginalRetirementResult|undefined,called=false;
 try {
  const returned=provider.withCompletedTurnFence(structuredClone(want),value=>{
   if(!active||called)throw Error('completion fence ended');called=true;
   const turn=completion(value);
   if(canonical({handle:turn.handle,operation:turn.operation,lifecycleGeneration:turn.lifecycleGeneration})!==canonical({handle:want.handle,operation:want.operation,lifecycleGeneration:want.lifecycleGeneration})
    ||'turnId' in want&&canonical(turn)!==canonical(want))throw Error('completion fence differs');
   result=body(turn);return result;
  });
  return called&&returned===result?result!:{status:'unavailable'};
 }finally{active=false;}
}
export function recoverCommittedOriginalRetirement(paths:NodePaths,value:TargetHandle,provider:OriginalCompletionProvider|undefined):OriginalRetirementResult {
 try {
  const handle=parseTargetHandle(value),initial=read(paths,handle);
  if(!initial||initial.phase!=='committed')return {status:'refused'};
  return fenced(provider,initial.completion,turn=>withNativeOwnerRecords(paths,initial.aliases,file=>{
   const locked=read(paths,handle);
   if(canonical(locked)!==canonical(initial)||canonical(turn)!==canonical(initial.completion))return {status:'refused'};
   return remove(paths,initial,file);
  }));
 }catch{return {status:'unknown'};}
}
export function retireOriginalCompletionStore(deps:Pick<PolicyDeps,'paths'>,context:ExecutionContext|undefined,provider:OriginalCompletionProvider|undefined,want:OriginalCompletionExpectation):OriginalRetirementResult {
 let committing=false,entered=false;
 try {
  if(!context||context.kind!=='message')return {status:'refused'};
  const handle=parseTargetHandle(context.handle),old=read(deps.paths,handle);
  if(old?.phase==='committed')return recoverCommittedOriginalRetirement(deps.paths,handle,provider);
  const initial=parseRouteReservation(readTargetRecord(path.join(deps.paths.dir,'codex-native-pending',handle.owner+'.json')));
  if(canonical(initial.handle)!==canonical(handle))return {status:'refused'};
  return fenced(provider,want,turn=>{
   let outcome:OriginalRetirementResult={status:'refused'};
   withOriginalCompletionAdmission(deps,context,s=>{
    entered=true;const prepared=snapshot(deps.paths,s,turn,'prepared'),file=location(deps.paths,handle,true),current=read(deps.paths,handle);
    if(current&&canonical(current)!==canonical(prepared))throw Error('prepared retirement differs');
    if(!current)writeTargetRecord(file,prepared,true);
    if(canonical(read(deps.paths,handle))!==canonical(prepared))throw Error('prepared retirement unconfirmed');
    const committed={...prepared,phase:'committed' as const};committing=true;writeTargetRecord(file,committed,false);
    if(canonical(read(deps.paths,handle))!==canonical(committed))throw Error('commit uncertain');
    // Admission's existing owner lock is still held; never nest withRoute/another mutex.
    outcome=remove(deps.paths,committed,owner=>{
     if(!committed.aliases.includes(owner))throw Error('unlocked alias');return path.join(deps.paths.dir,'codex-native-pending',owner+'.json');
    });
   });
   return outcome;
  });
 }catch{return {status:committing?'unknown':entered?'incomplete':'refused'};}
}
