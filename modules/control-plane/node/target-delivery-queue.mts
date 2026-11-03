import {explicitProcessingComplete} from './target-delivery-processing.mts';
import fs from 'node:fs';
import path from 'node:path';
import { nativeQueueInput, type NativeQueueGroup } from './codex-native-attempts.mts';
import type { NodePaths } from './config.mts';
import { getMessage } from './inbox.mts';
import { canonical, targetProcessedMembersMatch } from './target-delivery-state.mts';
import { parseRouteReservation } from './target-delivery-operation.mts';
import { withRoute,routeHistory,routeAliases,verifyRouteDebit } from './target-delivery-route.mts';
import { readTargetRecord } from './target-delivery-files.mts';

export function routeQueueGroups(paths:NodePaths,owner:string):NativeQueueGroup[] {
  const raw=readTargetRecord(path.join(paths.dir,'codex-native-pending',`${owner}.json`));
  if(!raw||typeof raw!=='object'||(raw as {version?:unknown}).version!==3)return [];
  const s=parseRouteReservation(raw),op=s.consumer??s.group.operation,p=op.producer;
  if(s.originalResume||op.kind!=='queue'||s.outcome?.kind!=='queue'||!s.budget||!p)return [];
  return withRoute(paths,s.handle,()=>[{version:1,owner,queuedSubmissionId:s.outcome!.kind==='queue'?s.outcome!.queueId:'',
    admissionComplete:true,batchRecorded:true,admissionMessageIds:s.group.binding.members.map(m=>m.messageId),
    expectedInput:nativeQueueInput(owner,s.group.binding.members.length),
    producer:{codexExecutable:p.files[0].path,launchFile:p.launchFile,launchPrefix:p.launchPrefix,approvedFiles:p.files,resolvedCodexHome:p.home!,route:p.route},
    targetGroup:{version:1,...s.handle,...s.budget!}}]);
}
export function releaseReconciledRouteQueue(paths:NodePaths,owner:string):boolean {
  const groups=routeQueueGroups(paths,owner);if(groups.length!==1)return false;
  const group=groups[0];
  const {version:_v,budgetId:_b,chargedAt:_c,...handle}=group.targetGroup!;
  return withRoute(paths,handle,(s)=>{
    const receipt=readTargetRecord(path.join(paths.dir,'codex-native-reconciled',owner,`${group.queuedSubmissionId}.json`));
    if(canonical(receipt)!==canonical(group))return false;
    const rows=s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId));
    if(rows.some(r=>!r)||!targetProcessedMembersMatch(s.group.binding,(rows as NonNullable<typeof rows[number]>[]).map(row=>s.targetResume?{...row,closedAttempt:undefined}:row),s.group.binding.nodeId))return false;
    if(!explicitProcessingComplete(s,rows as NonNullable<typeof rows[number]>[],token=>readTargetRecord(path.join(paths.inbox,'codex-offers',token+'.json'))))return false;
    // Transport retirement plus exact processed membership releases only this queue.
    fs.unlinkSync(path.join(paths.dir,'codex-native-pending',`${owner}.json`));return true;
  });
}

export function readReconciledRouteQueueRetirement(paths:NodePaths,handle:import('./target-delivery-reservation.mts').TargetHandle):boolean {
 const raw=readTargetRecord(routeHistory(paths,handle));if(raw===null)return false;const s=parseRouteReservation(raw);
 if(canonical(s.handle)!==canonical(handle)||s.originalResume||s.consumer||s.outcome?.kind!=='queue'||!s.budget||!s.targetResume)return false;
 const budgetHistory=path.join(paths.dir,'target-delivery-groups',s.group.operation.budgetOwner,handle.groupId+'.route.json');
 if(canonical(readTargetRecord(budgetHistory))!==canonical(s))throw Error('queue history differs');verifyRouteDebit(paths,s);
 const p=s.group.operation.producer;if(!p)throw Error('queue producer missing');
 const group={version:1,owner:s.owner,queuedSubmissionId:s.outcome.queueId,admissionComplete:true,batchRecorded:true,admissionMessageIds:s.group.binding.members.map(m=>m.messageId),expectedInput:nativeQueueInput(s.owner,s.group.binding.members.length),producer:{codexExecutable:p.files[0].path,launchFile:p.launchFile,launchPrefix:p.launchPrefix,approvedFiles:p.files,resolvedCodexHome:p.home!,route:p.route},targetGroup:{version:1,...s.handle,...s.budget}};
 const receipt=readTargetRecord(path.join(paths.dir,'codex-native-reconciled',s.owner,s.outcome.queueId+'.json'));if(canonical(receipt)!==canonical(group))return false;
 const rows=s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId));
 if(rows.some(r=>!r||canonical(r.targetAttempt)!==canonical(handle))||!targetProcessedMembersMatch(s.group.binding,(rows as NonNullable<typeof rows[number]>[]).map(row=>({...row,closedAttempt:undefined})),s.group.binding.nodeId)||s.transitions.some(t=>t.applied!==true))return false;
 if(!explicitProcessingComplete(s,rows as NonNullable<typeof rows[number]>[],token=>readTargetRecord(path.join(paths.inbox,'codex-offers',token+'.json'))))return false;
 return routeAliases(s).every(owner=>readTargetRecord(path.join(paths.dir,'codex-native-pending',owner+'.json'))===null);
}
