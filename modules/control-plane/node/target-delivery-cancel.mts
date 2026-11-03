import fs from 'node:fs';
import path from 'node:path';
import { budgetFile, withConfirmedNoGroupDebit, type NoGroupDebitProof } from './budget-store.mts';
import { withNativeOwnerRecords } from './codex-native-pending.mts';
import type { NodePaths } from './config.mts';
import { isMessageAddress, isSessionRef } from '../protocol-messages.mts';
import { isPermissionMode, isTaskRuntime, isTaskState } from '../protocol-tasks.mts';
import { readTargetRecord, writeTargetRecord } from './target-delivery-files.mts';
import { parseRouteReservation, type RouteReservation } from './target-delivery-operation.mts';
import { parseTargetHandle, type TargetHandle } from './target-delivery-reservation.mts';
import { canonical, integer, keys, object, uuid } from './target-delivery-state.mts';

interface Cancellation {
  version:1; kind:'uncharged-cancellation'; handle:TargetHandle; groupFingerprint:string; aliases:string[];
  budgetOwner:string; proof:NoGroupDebitProof; reason:'spacing'|'exhausted';
}
export type CancelStep='receipt'|'terminal'|'alias-removed'|'original-removed';
export interface CancelDeps { step?:(step:CancelStep,owner:string)=>void }
const owners=(s:RouteReservation)=>[...new Set([s.owner,s.group.operation.execution.sessionId].filter((x):x is string=>!!x))].sort();
const alias=(s:RouteReservation,owner:string)=>({version:4,owner,handle:s.handle});
const receiptFile=(p:NodePaths,h:TargetHandle)=>path.join(p.dir,'target-delivery-groups',h.owner,`${h.groupId}.cancel.json`);
function noEffect(s:RouteReservation):void {
  if(!['reserved','cancelled-before-debit'].includes(s.phase)||s.budget||s.consumer||s.executionSessionId||s.innerStarted||s.outcomes.length||s.transitions.length||s.outcome
    ||s.group.operation.kind==='handover')throw Error('no-effect proof unavailable');
}
// These are proof limits, never truncation allowances. Any incomplete pass fences.
const MAX_REFERENCE_RECORDS=4096,MAX_REFERENCE_BYTES=32*1024*1024,MAX_RECORD_BYTES=128*1024,REFERENCE_SCAN_MS=1000;
const stamp=(s:fs.Stats)=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
const date=(x:unknown)=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const safe=(s:fs.Stats)=>!s.isSymbolicLink()&&(process.platform==='win32'||s.uid===process.getuid?.()&&(s.mode&0o022)===0);
function referenceMetadata(x:unknown,id:string,task:boolean):Record<string,unknown> {
  if(!object(x))throw Error();
  if(task) {
    if(x.taskId!==id||typeof x.name!=='string'||!x.name||typeof x.cwd!=='string'||!x.cwd
      ||!isPermissionMode(x.permissionMode)||!isTaskState(x.state)||x.runtime!==undefined&&!isTaskRuntime(x.runtime)
      ||!date(x.startedAt)||!date(x.updatedAt)||!date(x.deadline))throw Error();
  }else if(x.messageId!==id||!isMessageAddress(x.from)||!isSessionRef(x.toSession)||typeof x.text!=='string'
    ||!date(x.createdAt)||!date(x.receivedAt)||!['accepted','offered','delivered','refused'].includes(x.state as string))throw Error();
  return x;
}
// Read only primary-record metadata. The receipt has no member list, so both
// complete local namespaces are required even when the original owner is gone.
// No body, path or underlying I/O error escapes this proof boundary.
function assertNoCurrentReferences(paths:NodePaths,handle:TargetHandle):void {
  let referenced=false;
  try {
    const deadline=performance.now()+REFERENCE_SCAN_MS;
    let count=0,total=0;
    const timely=()=>{if(performance.now()>deadline)throw Error();};
    const parent=fs.lstatSync(paths.dir);
    if(!parent.isDirectory()||!safe(parent))throw Error();
    const snapshots=[paths.inbox,paths.tasks].map((dir,index)=>{
      let before:fs.Stats;
      try{before=fs.lstatSync(dir);}catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        // A verified existing parent distinguishes an uninitialized namespace
        // from a missing/inaccessible ancestor. Recheck absence at the end.
        if(stamp(fs.lstatSync(paths.dir))!==stamp(parent))throw Error();
        return {dir,before:null,names:[] as string[],records:[] as {file:string;stamp:string}[]};
      }
      if(!before.isDirectory()||!safe(before))throw Error();
      const names=fs.readdirSync(dir).sort();
      if(names.length>MAX_REFERENCE_RECORDS)throw Error();
      const records:{file:string;stamp:string}[]=[];
      for(const name of names){
        timely();const file=path.join(dir,name),stat=fs.lstatSync(file);
        if(!safe(stat))throw Error();
        if(index===0&&['receipts','progress','proxied'].includes(name)){
          if(!stat.isDirectory())throw Error();continue;
        }
        const id=name.slice(0,-5);
        if(!name.endsWith('.json')||!uuid(id)){
          // Exact sidecars emitted by writeJsonAtomic and inbox-record-lock.
          const part='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
          if(!stat.isFile()||!new RegExp(`^\\.${part}\\.json(?:\\.${part}\\.tmp|\\.lock(?:\\.${part}\\.tmp)?)$`,'i').test(name))throw Error();
          continue;
        }
        if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_RECORD_BYTES||++count>MAX_REFERENCE_RECORDS)throw Error();
        const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
        let bytes:Buffer;
        try{
          if(stamp(fs.fstatSync(fd))!==stamp(stat))throw Error();
          bytes=fs.readFileSync(fd);
          if(bytes.length>MAX_RECORD_BYTES||stamp(fs.fstatSync(fd))!==stamp(stat))throw Error();
        }finally{fs.closeSync(fd);}
        total+=bytes.length;if(total>MAX_REFERENCE_BYTES)throw Error();
        const record=referenceMetadata(JSON.parse(bytes.toString('utf8')),id,index===1);
        if(record.targetAttempt!==undefined){
          const reference=parseTargetHandle(record.targetAttempt);
          if(canonical(reference)===canonical(handle))referenced=true;
        }
        if(stamp(fs.lstatSync(file))!==stamp(stat))throw Error();
        records.push({file,stamp:stamp(stat)});
      }
      return {dir,before,names,records};
    });
    for(const snapshot of snapshots){
      timely();
      if(snapshot.before===null){
        try{fs.lstatSync(snapshot.dir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
        throw Error();
      }
      for(const record of snapshot.records){timely();if(stamp(fs.lstatSync(record.file))!==record.stamp)throw Error();}
      if(canonical(fs.readdirSync(snapshot.dir).sort())!==canonical(snapshot.names)
        ||stamp(fs.lstatSync(snapshot.dir))!==stamp(snapshot.before))throw Error();
    }
    timely();if(stamp(fs.lstatSync(paths.dir))!==stamp(parent))throw Error();
  }catch{throw Error('reference proof unavailable');}
  if(referenced)throw Error('current reference exists');
}
function parseCancellation(x:unknown):Cancellation {
  if(!object(x)||!keys(x,['version','kind','handle','groupFingerprint','aliases','budgetOwner','proof','reason'])||x.version!==1||x.kind!=='uncharged-cancellation'
    ||!Array.isArray(x.aliases)||!x.aliases.length||x.aliases.length>2||!x.aliases.every(uuid)||canonical(x.aliases)!==canonical([...new Set(x.aliases)].sort())||!uuid(x.budgetOwner)
    ||!['spacing','exhausted'].includes(x.reason as string)||!object(x.proof)||!keys(x.proof,['version','budgetId','revision','key','absent'])
    ||x.proof.version!==1||!uuid(x.proof.budgetId)||!integer(x.proof.revision)||x.proof.absent!==true)throw Error('invalid cancellation receipt');
  const handle=parseTargetHandle(x.handle);
  if(x.groupFingerprint!==handle.groupFingerprint||!x.aliases.includes(handle.owner)||!object(x.proof.key)||!keys(x.proof.key,['groupId','groupFingerprint','reservationId'])
    ||x.proof.key.groupId!==handle.groupId||x.proof.key.groupFingerprint!==handle.groupFingerprint||x.proof.key.reservationId!==handle.reservationId)throw Error('unbound cancellation receipt');
  return x as unknown as Cancellation;
}
export function cancelUnchargedRoute(paths:NodePaths,value:TargetHandle,reason:'spacing'|'exhausted',deps:CancelDeps={}):boolean {
  const handle=parseTargetHandle(value),original=path.join(paths.dir,'codex-native-pending',`${handle.owner}.json`);
  const initial=parseRouteReservation(readTargetRecord(original));
  return withNativeOwnerRecords(paths,owners(initial),file=>{
    const s=parseRouteReservation(readTargetRecord(file(handle.owner)));
    if(canonical(s.handle)!==canonical(handle))return false;
    if(canonical(owners(s))!==canonical(owners(initial)))throw Error('cancellation owner differs');
    noEffect(s);
    for(const owner of owners(s))if(owner!==s.owner&&canonical(readTargetRecord(file(owner)))!==canonical(alias(s,owner)))throw Error('partial cancellation claim');
    return withConfirmedNoGroupDebit(budgetFile(paths,s.group.operation.budgetOwner),{groupId:handle.groupId,groupFingerprint:handle.groupFingerprint,reservationId:handle.reservationId},proof=>{
      assertNoCurrentReferences(paths,handle);
      if(canonical(readTargetRecord(file(s.owner)))!==canonical(s))throw Error('cancellation owner changed');
      for(const owner of owners(s))if(owner!==s.owner&&canonical(readTargetRecord(file(owner)))!==canonical(alias(s,owner)))throw Error('cancellation alias changed');
      const receipt:Cancellation={version:1,kind:'uncharged-cancellation',handle,groupFingerprint:handle.groupFingerprint,aliases:owners(s),budgetOwner:s.group.operation.budgetOwner,proof,reason};
      const prior=readTargetRecord(receiptFile(paths,handle));
      if(prior!==null){const old=parseCancellation(prior);if(canonical(old.handle)!==canonical(handle)||old.proof.budgetId!==proof.budgetId)throw Error('cancellation receipt conflicts');}
      else writeTargetRecord(receiptFile(paths,handle),receipt,true);
      deps.step?.('receipt',s.owner);
      writeTargetRecord(file(s.owner),{...s,phase:'cancelled-before-debit'});deps.step?.('terminal',s.owner);
      for(const owner of owners(s))if(owner!==s.owner){if(canonical(readTargetRecord(file(owner)))!==canonical(alias(s,owner)))throw Error('cancellation alias changed');fs.unlinkSync(file(owner));deps.step?.('alias-removed',owner);}
      const current=parseRouteReservation(readTargetRecord(file(s.owner)));
      if(canonical(current)!==canonical({...s,phase:'cancelled-before-debit'}))throw Error('cancelled owner changed');
      fs.unlinkSync(file(s.owner));deps.step?.('original-removed',s.owner);return true;
    });
  });
}
export function recoverUnchargedCancellation(paths:NodePaths,value:TargetHandle,deps:CancelDeps={}):boolean {
  const handle=parseTargetHandle(value),receipt=parseCancellation(readTargetRecord(receiptFile(paths,handle)));
  if(canonical(receipt.handle)!==canonical(handle))throw Error('cancellation handle differs');
  return withNativeOwnerRecords(paths,receipt.aliases,file=>{
    const locked=parseCancellation(readTargetRecord(receiptFile(paths,handle)));
    if(canonical(locked)!==canonical(receipt))throw Error('cancellation receipt changed');
    const raw=readTargetRecord(file(handle.owner));
    if(raw!==null&&(!object(raw)||canonical(raw.handle)!==canonical(handle)))return false; // replacement is untouched
    const saved=raw===null?null:parseRouteReservation(raw);
    if(saved){noEffect(saved);if(canonical(owners(saved))!==canonical(receipt.aliases)||saved.group.operation.budgetOwner!==receipt.budgetOwner)throw Error('cancellation owner differs');}
    // Validate every alias before changing even the original terminal marker.
    for(const owner of receipt.aliases)if(owner!==handle.owner){const x=readTargetRecord(file(owner));
      if(x!==null&&canonical(x)!==canonical({version:4,owner,handle}))return false;}
    return withConfirmedNoGroupDebit(budgetFile(paths,receipt.budgetOwner),receipt.proof.key,proof=>{
      if(proof.budgetId!==receipt.proof.budgetId||proof.revision<receipt.proof.revision)throw Error('cancellation budget differs');
      assertNoCurrentReferences(paths,handle);
      if(canonical(parseCancellation(readTargetRecord(receiptFile(paths,handle))))!==canonical(receipt))throw Error('cancellation receipt changed');
      if(canonical(readTargetRecord(file(handle.owner)))!==canonical(raw))return false;
      for(const owner of receipt.aliases)if(owner!==handle.owner){const x=readTargetRecord(file(owner));
        if(x!==null&&canonical(x)!==canonical({version:4,owner,handle}))return false;}
      if(saved&&saved.phase!=='cancelled-before-debit')writeTargetRecord(file(handle.owner),{...saved,phase:'cancelled-before-debit'});
      for(const owner of receipt.aliases)if(owner!==handle.owner){const x=readTargetRecord(file(owner));if(x===null)continue;if(canonical(x)!==canonical({version:4,owner,handle}))return false;fs.unlinkSync(file(owner));deps.step?.('alias-removed',owner);}
      if(saved){const x=readTargetRecord(file(handle.owner));if(!object(x)||x.phase!=='cancelled-before-debit'||canonical(x.handle)!==canonical(handle))throw Error('cancelled owner changed');fs.unlinkSync(file(handle.owner));deps.step?.('original-removed',handle.owner);}
      return true;
    });
  });
}

// A common claim may finish only a previously journaled positive cancellation.
// The occupied owner/alias supplies its exact handle; no directory sweep,
// age-based recovery or generic unknown-effect cleanup is permitted.
export function recoverOccupiedCancellation(paths:NodePaths,owners:string[]):void {
  for(const owner of new Set(owners)) {
    const raw=readTargetRecord(path.join(paths.dir,'codex-native-pending',`${owner}.json`));
    if(!object(raw)||raw.owner!==owner||![3,4].includes(raw.version as number))continue;
    const handle=raw.version===3?parseRouteReservation(raw).handle:
      keys(raw,['version','owner','handle'])?parseTargetHandle(raw.handle):null;
    if(!handle)throw Error('cancellation alias unknown');
    const receipt=readTargetRecord(receiptFile(paths,handle));
    if(receipt===null)continue;
    if(canonical(parseCancellation(receipt).handle)!==canonical(handle))throw Error('cancellation reference differs');
    if(!recoverUnchargedCancellation(paths,handle))throw Error('cancellation replacement retained');
  }
}
