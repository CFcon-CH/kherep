// Process-local grant provenance. These witnesses never confer launch Authority.
import fs from 'node:fs';
import {canonical} from './target-delivery-state.mts';
import {readLivenessSnapshot} from './session-lifecycle.mts';
import type {NodePaths} from './config.mts';
import type {InboxRecord} from './inbox.mts';
import type {NodePolicy} from './policy.mts';
import {readTask,taskGrants,type TaskRecord} from './task-records.mts';
import {replyProof,taskMessageProof,requestsByTask,REPLY_GRANT_MAX_AGE_MS} from './wake-reply.mts';

export interface GrantTarget {runtime:string;sessionId:string}
export interface TaskIdentity {
  taskId:string;runtime?:string;sessionId?:string;name:string;cwd:string;permissionMode:string;
  local?:string;requestedBy?:string;startedAt:string;sourceRequestId?:string;
}
export function grantTaskIdentity(t:TaskRecord):TaskIdentity {
  return {taskId:t.taskId,runtime:t.runtime,sessionId:t.sessionId,name:t.name,cwd:t.cwd,permissionMode:t.permissionMode,
    local:t.local,requestedBy:t.requestedBy,startedAt:t.startedAt,sourceRequestId:t.sourceRequestId};
}
export type ListedBasis={kind:'listed';entry:string;via:'full-id'|'wildcard';target:GrantTarget}
  |{kind:'listed';entry:string;via:'session-name';target:GrantTarget;source:'directory'}
  |{kind:'listed';entry:string;via:'task-name';target:GrantTarget;source:'task';task:TaskIdentity};
export type ReplyIdentity={messageId:string;nodeId:string;binding:string;createdAt:string;via:'fromSessionId'|'fromSession'};
export type RequestIdentity={requestId:string;taskId:string;nodeId:string;binding:string;createdAt:string;via:'requestedBySessionId'|'requestedBy'};
export type MemberGrant=({messageId:string}&ListedBasis)
  |{messageId:string;kind:'owner-task';task:TaskIdentity;via:'task-id'|'intercom-sender'}
  |{messageId:string;kind:'reply';original:ReplyIdentity}
  |{messageId:string;kind:'task-message';original:RequestIdentity};
export type GrantTimeBounds=readonly number[];
export type TargetRefsResult={status:'available';refs:string[];name?:string}|{status:'refused';reason:'missing'|'unreadable'|'malformed'|'incoherent'|'ambiguous'};
// Deliberately separate from the fail-soft directory accessor. Alias-dependent
// grants need one coherent, complete publication and unique local addressing.
export function currentTargetRefs(paths:NodePaths,target:GrantTarget,generation:number,now:number):TargetRefsResult {
  let text:string;
  try {const stat=fs.statSync(paths.sessions);if(!stat.isFile()||stat.size>1024*1024)return {status:'refused',reason:'malformed'};text=fs.readFileSync(paths.sessions,'utf8');}
  catch(e){return {status:'refused',reason:(e as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unreadable'};}
  let value:unknown;
  try {value=JSON.parse(text);}
  catch {return {status:'refused',reason:'malformed'};}
  if(!value||typeof value!=='object')return {status:'refused',reason:'malformed'};
  const v=value as {generation?:unknown;sessions?:unknown;unseen?:unknown;updatedAt?:unknown};
  if(!Array.isArray(v.sessions)||!Array.isArray(v.unseen)||v.unseen.some(r=>typeof r!=='string')||typeof v.updatedAt!=='string'
    ||!Number.isFinite(Date.parse(v.updatedAt))||Date.parse(v.updatedAt)>now)return {status:'refused',reason:'malformed'};
  if(v.generation!==generation||v.unseen.length!==0)return {status:'refused',reason:'incoherent'};
  const rows=v.sessions as {sessionId?:unknown;runtime?:unknown;name?:unknown;state?:unknown}[];
  if(rows.some(r=>!r||typeof r!=='object'||typeof r.sessionId!=='string'||typeof r.runtime!=='string'
    ||(r.name!==undefined&&typeof r.name!=='string')||typeof r.state!=='string'))return {status:'refused',reason:'malformed'};
  if(new Set(rows.map(r=>r.sessionId)).size!==rows.length)return {status:'refused',reason:'ambiguous'};
  const matches=rows.filter(r=>r.sessionId===target.sessionId&&r.runtime===target.runtime);
  if(matches.length!==1)return {status:'refused',reason:'ambiguous'};
  const name=matches[0].name as string|undefined;
  if(rows.filter(r=>r.sessionId===target.sessionId).length!==1||name&&rows.filter(r=>r.name===name||r.sessionId===name).length!==1)return {status:'refused',reason:'ambiguous'};
  return {status:'available',refs:[target.sessionId,...(name?[name]:[])],...(name?{name}:{})};
}
export function captureListedGrant(policy:NodePolicy,target:GrantTarget,source?:{kind:'directory';name:string}|{kind:'task';task:TaskRecord}):ListedBasis|null {
  const entries=policy.wake?.sessions??[];
  if(entries.includes(target.sessionId))return {kind:'listed',entry:target.sessionId,via:'full-id',target:{...target}};
  if(source?.kind==='directory'&&entries.includes(source.name))return {kind:'listed',entry:source.name,via:'session-name',source:'directory',target:{...target}};
  if(source?.kind==='task'&&entries.includes(source.task.name))return {kind:'listed',entry:source.task.name,via:'task-name',source:'task',target:{...target},task:grantTaskIdentity(source.task)};
  return entries.includes('*')?{kind:'listed',entry:'*',via:'wildcard',target:{...target}}:null;
}
export function captureOwnerGrant(task:TaskRecord,row:InboxRecord):MemberGrant|null {
  if(!taskGrants(task,row))return null;
  return {messageId:row.messageId,kind:'owner-task',task:grantTaskIdentity(task),via:row.taskId===task.taskId?'task-id':'intercom-sender'};
}
export function replyIdentity(s:import('./exchange.mts').SentRecord):ReplyIdentity {
  return {messageId:s.messageId,nodeId:s.to!.nodeId,binding:(s.fromSessionId??s.fromSession)!,createdAt:s.createdAt!,via:s.fromSessionId===undefined?'fromSession':'fromSessionId'};
}
export function requestIdentity(r:import('./task-records.mts').TaskRequestRecord):RequestIdentity {
  return {requestId:r.requestId,taskId:r.taskId!,nodeId:r.nodeId!,binding:r.requestedBySessionId??r.requestedBy,createdAt:r.createdAt,via:r.requestedBySessionId===undefined?'requestedBy':'requestedBySessionId'};
}
export function exactGrantMembers(rows:readonly Pick<InboxRecord,'messageId'>[],witnesses:readonly MemberGrant[]):boolean {
  return rows.length===witnesses.length&&new Set(witnesses.map(w=>w.messageId)).size===rows.length
    &&new Set(rows.map(r=>r.messageId)).size===rows.length&&rows.every(r=>witnesses.some(w=>w.messageId===r.messageId));
}
export function freezeMemberGrants(rows:readonly Pick<InboxRecord,'messageId'>[],witnesses:readonly MemberGrant[]):readonly MemberGrant[] {
  if(!exactGrantMembers(rows,witnesses)||witnesses.some(w=>!['listed','owner-task','reply','task-message'].includes(w.kind)))throw Error('complete grant membership missing');
  const copy=structuredClone(witnesses) as MemberGrant[];
  function freeze(value:object):void {Object.values(value).forEach(v=>{if(v&&typeof v==='object')freeze(v);});Object.freeze(value);}
  freeze(copy);return copy;
}
export function grantTimesValid(bounds:GrantTimeBounds,now:number):boolean {
  return Number.isSafeInteger(now)&&bounds.every(created=>Number.isFinite(created)&&now>=created&&now-created<=REPLY_GRANT_MAX_AGE_MS);
}
export function checkMemberGrantsCurrent(paths:NodePaths,policy:NodePolicy,target:GrantTarget,rows:readonly InboxRecord[],witnesses:readonly MemberGrant[],now:number):GrantTimeBounds|null {
  if(!exactGrantMembers(rows,witnesses))return null;
  const bounds:number[]=[];let refs:TargetRefsResult|undefined,requests:ReturnType<typeof requestsByTask>|undefined;
  const alias=(name:string)=>{const generation=readLivenessSnapshot(paths)?.generation;
    refs??=generation===undefined?{status:'refused',reason:'incoherent'}:currentTargetRefs(paths,target,generation,now);
    return refs.status==='available'&&refs.name===name;};
  for(const witness of witnesses) {
    const row=rows.find(r=>r.messageId===witness.messageId)!;
    switch(witness.kind) {
      case 'listed': {
        if(canonical(witness.target)!==canonical(target)||!policy.wake?.sessions.includes(witness.entry))return null;
        if(witness.via==='full-id'){if(witness.entry!==target.sessionId)return null;}
        else if(witness.via==='wildcard'){if(witness.entry!=='*')return null;}
        else if(witness.via==='session-name'){if(witness.source!=='directory'||!alias(witness.entry))return null;}
        else if(witness.via==='task-name') {
          const task=readTask(paths,witness.task.taskId);
          if(witness.source!=='task'||!task||task.sessionId!==target.sessionId||(task.runtime??'claude')!==(target.runtime==='claude-code'?'claude':target.runtime)
            ||task.name!==witness.entry||canonical(grantTaskIdentity(task))!==canonical(witness.task))return null;
        }else return null;
        break;
      }
      case 'owner-task': {
        const task=readTask(paths,witness.task.taskId);
        if(!task||task.sessionId!==target.sessionId||(task.runtime??'claude')!==(target.runtime==='claude-code'?'claude':target.runtime)||canonical(grantTaskIdentity(task))!==canonical(witness.task)||!taskGrants(task,row)
          ||(witness.via==='task-id'?row.taskId!==task.taskId:witness.via!=='intercom-sender'||task.local!=='intercom'||task.requestedBy!==`${row.from.nodeId}/${row.from.session}`))return null;
        break;
      }
      case 'reply': {
        const original=witness.original;
        if(policy.wake?.replies!==true||(original.via==='fromSessionId'?original.binding!==target.sessionId:original.via!=='fromSession'||!alias(original.binding)))return null;
        const proof=replyProof(paths,[original.binding],row,now);
        if(!proof||canonical(replyIdentity(proof))!==canonical(original))return null;
        bounds.push(Date.parse(original.createdAt));break;
      }
      case 'task-message': {
        const original=witness.original;
        if(policy.wake?.replies!==true||(original.via==='requestedBySessionId'?original.binding!==target.sessionId:original.via!=='requestedBy'||!alias(original.binding)))return null;
        requests??=requestsByTask(paths);
        const proof=taskMessageProof(paths,[original.binding],row,now,()=>requests!);
        if(!proof||canonical(requestIdentity(proof))!==canonical(original))return null;
        bounds.push(Date.parse(original.createdAt));break;
      }
      default:return null;
    }
  }
  return grantTimesValid(bounds,now)?Object.freeze(bounds):null;
}
