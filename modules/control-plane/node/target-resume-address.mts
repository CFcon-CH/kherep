import {boundRecordValid} from './message-owner.mts';
import fs from 'node:fs';
import path from 'node:path';
import {readSelected} from './inbox-selected-read.mts';
import {readLivenessSnapshot} from './session-lifecycle.mts';
import {isSessionRef} from '../protocol-messages.mts';
import {object,uuid} from './target-delivery-state.mts';
import type {NodePaths} from './config.mts';
import type {InboxRecord} from './inbox.mts';

type Owner={sessionId:string;runtime:'codex'|'claude-code'};
const runtime=(x:unknown):Owner['runtime']=>{if(x==='codex')return x;if(x==='claude'||x==='claude-code')return 'claude-code';throw Error('address runtime unavailable');};
function rows(value:unknown,cap:number):Record<string,unknown>[] {
 if(!Array.isArray(value)||value.length>=cap||!value.every(r=>object(r)&&uuid(r.sessionId)&&typeof r.runtime==='string'&&(r.name===undefined||isSessionRef(r.name))))throw Error('address population incomplete');
 for(const r of value)runtime(r.runtime);
 return value;
}
// Missing tasks means no task has been created; malformed/unreadable entries
// never mean an empty population. Full IDs do not require name discovery.
export function resolveTargetAddress(paths:NodePaths,ref:string,now:number):Owner {
 if(!isSessionRef(ref)||uuid(ref))throw Error('name resolution requires a name');
 const known=readSelected(path.join(paths.dir,'known-sessions.json'));
 const listing=readSelected(paths.sessions),snapshot=readLivenessSnapshot(paths);
 if(!object(known)||!object(listing)||!snapshot||snapshot.capped||listing.generation!==snapshot.generation
  ||!Array.isArray(listing.unseen)||listing.unseen.some(x=>typeof x!=='string')
  ||typeof listing.updatedAt!=='string'||!Number.isFinite(Date.parse(listing.updatedAt))||now<Date.parse(listing.updatedAt)||now-Date.parse(listing.updatedAt)>180000)throw Error('address listing unavailable');
 const population=[...rows(known.sessions,512),...rows(listing.sessions,1024)];
 let names:string[];
 try {const stat=fs.lstatSync(paths.tasks);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('address tasks unavailable');names=fs.readdirSync(paths.tasks);}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;names=[];}
 if(names.length>=1024)throw Error('address tasks incomplete');
 for(const name of names){
  if(!name.endsWith('.json')||!uuid(name.slice(0,-5)))throw Error('address task population malformed');
  const task=readSelected(path.join(paths.tasks,name));
  if(!object(task)||task.taskId!==name.slice(0,-5)||!isSessionRef(task.name)||task.sessionId!==undefined&&!uuid(task.sessionId)||task.mappingConflict!==undefined)throw Error('address task mapping unavailable');
  const r=runtime(task.runtime??'claude');
  if(task.sessionId===undefined){if(task.name===ref)throw Error('address task mapping incomplete');continue;}
  population.push({...task,sessionId:task.sessionId,runtime:r});
 }
 const matches=population.filter(r=>r.name===ref||r.sessionId===ref).map(r=>({sessionId:r.sessionId as string,runtime:runtime(r.runtime)}));
 const unique=new Map(matches.map(r=>[r.runtime+'/'+r.sessionId,r]));
 if(unique.size!==1)throw Error('address mapping ambiguous or unavailable');
 const result=[...unique.values()][0];
 if(listing.unseen.includes('*')||listing.unseen.some(r=>runtime(r)===result.runtime))throw Error('address runtime listing incomplete');
 return result;
}
export function assertTargetAddresses(paths:NodePaths,records:readonly (Pick<InboxRecord,'toSession'>&Partial<InboxRecord>)[],target:Owner&{lifecycleGeneration?:number},now:number):void {
 for(const r of records){
  if(r.binding){if(!r.from||!boundRecordValid({...r,from:r.from})||r.binding.to.sessionId!==target.sessionId||r.binding.to.runtime!==target.runtime||r.binding.to.lifecycleGeneration===null||r.binding.to.lifecycleGeneration!==target.lifecycleGeneration)throw Error("bound original owner/lifecycle differs");continue;}
  const resolved=uuid(r.toSession)?{...target,sessionId:r.toSession}:resolveTargetAddress(paths,r.toSession,now);
  if(resolved.sessionId!==target.sessionId||resolved.runtime!==target.runtime)throw Error('original address changed');
 }
}
