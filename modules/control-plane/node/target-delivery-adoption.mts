import path from 'node:path';
import type { NodePaths } from './config.mts';
import { withNativeOwnerRecords } from './codex-native-pending.mts';
import { getMessage } from './inbox.mts';
import { readTask } from './task-records.mts';
import { readTargetRecord, writeTargetRecord } from './target-delivery-files.mts';
import { digest, effectiveRouteSession, parseRouteReservation, type RouteAdoption, type RouteReservation } from './target-delivery-operation.mts';
import { parseTargetHandle, type TargetHandle } from './target-delivery-reservation.mts';
import { canonical, uuid } from './target-delivery-state.mts';
import { routeAliases, routeHistory, routeMembersCurrent, routeSnapshot, withRoute } from './target-delivery-route.mts';
import { replayRouteTransition, transitionRouteMessages } from './target-delivery-outcome.mts';

export class CopyAdoptionRefused extends Error {
  readonly code:'capacity'|'mapping'|'owner'|'members';
  constructor(code:'capacity'|'mapping'|'owner'|'members') {super(`copy-adoption-${code}`);this.code=code;}
}
type Scope={taskId:string;runtime:'codex'|'claude'};
const original=(p:NodePaths,h:TargetHandle)=>path.join(p.dir,'codex-native-pending',`${h.owner}.json`);
const alias=(s:RouteReservation,owner:string)=>({version:4,owner,handle:s.handle});
function persist(paths:NodePaths,s:RouteReservation):void {
  parseRouteReservation(s);writeTargetRecord(original(paths,s.handle),s);
  if(s.budget)for(const f of new Set([routeHistory(paths,s.handle),path.join(paths.dir,'target-delivery-groups',(s.consumer??s.group.operation).budgetOwner,`${s.handle.groupId}.route.json`)]))writeTargetRecord(f,s);
}
function taskMapping(paths:NodePaths,s:RouteReservation,scope:Scope):string {
  const task=readTask(paths,scope.taskId);
  if(!task||task.local!=='intercom'||(task.runtime??'claude')!==scope.runtime||!task.sessionId||!routeAliases(s).includes(task.sessionId))throw new CopyAdoptionRefused('mapping');
  return digest({taskId:task.taskId,runtime:scope.runtime,sessionId:task.sessionId,name:task.name,cwd:task.cwd,
    permissionMode:task.permissionMode,startedAt:task.startedAt,requestedBy:task.requestedBy??null});
}
// Persist the exact non-consuming intent before acquiring the new alias.
// A crash with an intent but no alias can repair only that intent's own alias.
function ensureIntent(paths:NodePaths,h:TargetHandle,scope:Scope,to:string):RouteAdoption {
  const first=parseRouteReservation(readTargetRecord(original(paths,h)));
  return withNativeOwnerRecords(paths,[...routeAliases(first),to],file=>{
    let s=parseRouteReservation(readTargetRecord(file(h.owner)));
    if(canonical(s.handle)!==canonical(h)||routeAliases(s).some(owner=>!routeAliases(first).includes(owner)))throw new CopyAdoptionRefused('owner');
    const last=s.adoptions?.at(-1),pending=last?.phase!=='converged'?last:undefined;
    for(const owner of routeAliases(s)) {
      if(owner===s.owner)continue;
      const saved=readTargetRecord(file(owner));
      if(saved===null&&pending?.toSession===owner)continue;
      if(canonical(saved)!==canonical(alias(s,owner)))throw new CopyAdoptionRefused('owner');
    }
    const mappingFingerprint=taskMapping(paths,s,scope);
    if(pending&&(pending.taskId!==scope.taskId||pending.runtime!==scope.runtime||pending.toSession!==to||pending.mappingFingerprint!==mappingFingerprint))throw new CopyAdoptionRefused('mapping');
    if(s.budget)for(const history of new Set([routeHistory(paths,h),path.join(paths.dir,'target-delivery-groups',(s.consumer??s.group.operation).budgetOwner,`${h.groupId}.route.json`)])) {
      const prior=parseRouteReservation(readTargetRecord(history));
      if(canonical(prior)===canonical(s))continue;
      // Only an exact persisted adoption append can repair its interrupted
      // history write. Different budget/outcome/transition bytes stay fenced.
      if(!pending||pending.phase!=='intent'||(prior.adoptions??[]).length!==(s.adoptions??[]).length-1
        ||canonical({...prior,adoptions:s.adoptions})!==canonical(s))throw new CopyAdoptionRefused('owner');
      writeTargetRecord(history,s);
    }
    if(!pending) {
      if(!routeMembersCurrent(paths,s)||(s.adoptions??[]).length>=16)throw new CopyAdoptionRefused((s.adoptions??[]).length>=16?'capacity':'members');
      const from=effectiveRouteSession(s);
      if(!from||from===to)throw new CopyAdoptionRefused('mapping');
      const rows=s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!);
      if(rows.some(r=>Object.hasOwn(r,'binding')&&r.toSession!==to))throw new CopyAdoptionRefused('mapping');
      if(rows.some(r=>r.delivery?.taskId!==scope.taskId||r.delivery.runtime!==scope.runtime))throw new CopyAdoptionRefused('members');
      const old=readTargetRecord(file(to));
      if(to!==s.owner&&old!==null&&canonical(old)!==canonical(alias(s,to)))throw new CopyAdoptionRefused('owner');
      const next:RouteAdoption={...scope,fromSession:from,toSession:to,mappingFingerprint,
        members:rows.map(r=>({messageId:r.messageId,before:routeSnapshot(r)})),phase:'intent'};
      s={...s,adoptions:[...(s.adoptions??[]),next]};persist(paths,s);
    }
    const intent=s.adoptions!.at(-1)!;
    const saved=readTargetRecord(file(to));
    if(to!==s.owner&&saved===null)writeTargetRecord(file(to),alias(s,to),true);
    else if(to!==s.owner&&canonical(saved)!==canonical(alias(s,to)))throw new CopyAdoptionRefused('owner');
    return intent;
  });
}
function converge(paths:NodePaths,h:TargetHandle,intent:RouteAdoption):void {
  const ctx={kind:'message' as const,handle:h};
  replayRouteTransition(paths,ctx);
  withRoute(paths,h,s=>{if(taskMapping(paths,s,intent)!==intent.mappingFingerprint)throw new CopyAdoptionRefused('mapping');});
  const own=(r:ReturnType<typeof getMessage>)=>r?.delivery?.taskId===intent.taskId&&r.delivery.runtime===intent.runtime;
  transitionRouteMessages(paths,ctx,row=>{
    if(!own(row))throw new CopyAdoptionRefused('members');
    if(row.state!=='accepted'&&row.state!=='offered')return row;
    if(row.toSession===intent.toSession)return row;
    if(row.toSession!==intent.fromSession)throw new CopyAdoptionRefused('members');
    return {...row,toSession:intent.toSession,closedTo:row.closedTo??row.toSession};
  });
  withRoute(paths,h,(s,save)=>{
    if(taskMapping(paths,s,intent)!==intent.mappingFingerprint)throw new CopyAdoptionRefused('mapping');
    save({...s,adoptions:s.adoptions!.map(a=>a===s.adoptions!.at(-1)&&a.phase==='intent'?{...a,phase:'addressed'}:a)});
  });
  transitionRouteMessages(paths,ctx,row=>own(row)&&row.toSession===intent.toSession
    ?{...row,delivery:{...row.delivery!,sessionId:intent.toSession}}:row);
  withRoute(paths,h,(s,save)=>{
    if(taskMapping(paths,s,intent)!==intent.mappingFingerprint)throw new CopyAdoptionRefused('mapping');
    save({...s,adoptions:s.adoptions!.map((a,i)=>i===s.adoptions!.length-1?{...a,phase:'converged'}:a)});
  });
}
export function adoptRouteCopy(paths:NodePaths,value:TargetHandle,scope:Scope,to:string):void {
  const h=parseTargetHandle(value);if(!uuid(to))throw new CopyAdoptionRefused('mapping');
  let s=parseRouteReservation(readTargetRecord(original(paths,h)));
  const pending=s.adoptions?.at(-1);
  if(pending&&pending.phase!=='converged')converge(paths,h,ensureIntent(paths,h,scope,pending.toSession));
  s=parseRouteReservation(readTargetRecord(original(paths,h)));
  if(effectiveRouteSession(s)===to){withRoute(paths,h,latest=>{taskMapping(paths,latest,scope);if(!routeMembersCurrent(paths,latest))throw new CopyAdoptionRefused('members');});return;}
  converge(paths,h,ensureIntent(paths,h,scope,to));
}
