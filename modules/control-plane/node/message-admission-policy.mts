import {automaticReplyDecision} from './reply-admission.mts';
import {checkMemberGrantsCurrent,type MemberGrant,type GrantTimeBounds} from './message-grant.mts';
import fs from 'node:fs';
import {MESSAGING_PROXY_CAPABILITY} from '../protocol-messages.mts';
import {currentForkAdmission} from './codex-fork-admission.mts';
import {acceptsMessage} from './policy.mts';
import {readLocalSessions} from './exchange-sessions.mts';
import {overLimit} from './task-admission.mts';
import type {ExecutionContext} from './target-delivery-operation.mts';
import {bypassesPermissions,rememberedMode,type WakeGrant} from './autonomy.mts';
import {busyPolicyFingerprint,busyWakeDisabled} from './codex-busy-policy.mts';
import {codexHome,currentCodexApp} from './codex-app.mts';
import {tuiMarker} from './codex-daemon.mts';
import {CODEX_ACTIVE_MS,listCodexSessions,readCodexSession} from './codex-sessions.mts';
import {readConfig,type NodePaths} from './config.mts';
import {MAX_REPLY_DEPTH,type InboxRecord} from './inbox.mts';
import {explicitlyListed,readPolicy,wakeAllowed,type NodePolicy} from './policy.mts';
import {notReadyNow,type Readiness} from './runtime-readiness.mts';
import {resolveCwd} from './task-prompt.mts';
import {listTasks,readTask} from './task-records.mts';
import type {RouteReservation} from './target-delivery-operation.mts';

export type MessageRouteName='target-resume'|'target-queue'|'native-queue'|'task-wake'|'closed-resume'|'closed-start'|'fork-reply'|'codex-stop'|'claude-stop'|'claude-wake';
export interface MessageRoute {
  route:MessageRouteName; grant:'resumeTarget'|'members'|'codexApp'|'resumeClosed'|'fork'|'stop';
  taskId?:string; permissionMode?:string; memberGrants?:readonly MemberGrant[]; attemptId?:string;
}
export interface PolicyDeps {paths:NodePaths;readiness?:Readiness;realpath?:(p:string)=>string;codex?:{home?:string;postToolHook?:()=>boolean};platform?:NodeJS.Platform;workerCapabilities?:()=>readonly string[]|null}

// Shared by initial Queue admission and the final effect. No attempt or debit mutation.
export function queueRouteEligible(deps:PolicyDeps,owner:string,fingerprint:string,now:number,grant?:WakeGrant):NodePolicy|null {
  const policy=readPolicy(deps.paths.policy,true),session=readCodexSession(deps.paths,owner),seen=Date.parse(session?.lastSeen??'');
  if(!readConfig(deps.paths.config)||!policy||busyPolicyFingerprint(policy)!==fingerprint||!policy.wake?.nativeQueue
    ||busyWakeDisabled(deps.paths)||!session||session.sessionId!==owner||!Number.isFinite(seen)||seen>now||now-seen>CODEX_ACTIVE_MS
    ||listTasks(deps.paths).some(t=>t.sessionId===owner)||bypassesPermissions(session.permissionMode)
    ||session.permissionMode===undefined&&!explicitlyListed(policy,[owner]))return null;
  if(!wakeAllowed(policy,[owner])) {
    if(grant!=='codexApp'||!policy.wake.codexApp)return null;
    const home=deps.codex?.home??codexHome();
    if(fs.existsSync(tuiMarker(home,owner))||currentCodexApp(deps.paths,listCodexSessions(deps.paths,now).map(r=>r.sessionId),home)!==owner)return null;
  }
  return policy;
}

export function messagePolicyCurrent(deps:PolicyDeps,selection:MessageRoute,s:RouteReservation,records:InboxRecord[],now:number,context:ExecutionContext):GrantTimeBounds|null {
  const group=s.group.binding,op=s.consumer??s.group.operation;
  const config=readConfig(deps.paths.config),policy=readPolicy(deps.paths.policy,true);
  if(!config||config.nodeId!==group.nodeId||config.policyFile!==deps.paths.policy||!policy
    ||busyPolicyFingerprint(policy)!==group.policyFingerprint||busyWakeDisabled(deps.paths))return null;
  if(records.some(r=>!automaticReplyDecision(r).allowed))return null;
  const allowed:Record<MessageRouteName,string[]>={
    'target-resume':['exec-resume'],'target-queue':['queue'],'native-queue':['queue'],'task-wake':['exec-resume'],'closed-start':['task-start'],'closed-resume':['exec-resume'],
    'fork-reply':['fork'],'codex-stop':['hook-continue'],'claude-stop':['hook-continue'],'claude-wake':['hook-continue'],
  };
  if(!allowed[selection.route]?.includes(op.kind)||listTasks(deps.paths).some(t=>t.sessionId===group.originalId&&t.operatorStoppedAt!==undefined))return null;
  const mode=selection.permissionMode;
  if(bypassesPermissions(mode))return null;
  if(notReadyNow(deps.readiness,op.execution.runtime==='codex'?'codex':'claude'))return null;
  if(selection.route==='target-queue'||selection.route==='target-resume') {
    const currentMode=listTasks(deps.paths).find(t=>t.sessionId===group.originalId)?.permissionMode
      ??readCodexSession(deps.paths,group.originalId)?.permissionMode??rememberedMode(deps.paths,group.originalId);
    if(selection.grant!=='resumeTarget'||policy.messaging?.resumeTarget!==true||policy.messaging.resumeClosed!==true
      ||!policy.sessions?.enabled||!policy.sessions.delegate.accept||!mode||currentMode!==mode
      ||!policy.sessions.permissionModes.includes(mode as never)||!policy.sessions.runtimes.includes(group.runtime==='codex'?'codex':'claude')
      ||op.execution.sessionId!==group.originalId||op.execution.runtime!==group.runtime||op.budgetOwner!==group.originalId
      ||group.runtime==='codex'&&policy.wake?.nativeQueue!==true
      ||records.some(r=>!acceptsMessage(policy,r.closedTo??r.toSession,r.from.nodeId,readLocalSessions(deps.paths)))
      ||overLimit({...deps,policy},now))return null;
    const cwd=op.producer?.launch&&resolveCwd(policy.sessions,op.producer.launch.cwd,deps.realpath);
    return cwd?.ok&&cwd.cwd===op.producer?.launch?.cwd?[]:null;
  }
  if(selection.route==='native-queue') {
    if(op.kind!=='queue'||selection.grant!=='members'&&selection.grant!=='codexApp')return null;
    // A basis cannot silently change from an App grant to a later allowlist.
    if(selection.grant==='codexApp'&&wakeAllowed(policy,[group.originalId]))return null;
    if(readCodexSession(deps.paths,group.originalId)?.permissionMode!==selection.permissionMode)return null;
    if(!queueRouteEligible(deps,group.originalId,group.policyFingerprint,now,selection.grant==='codexApp'?'codexApp':undefined))return null;
    return selection.grant==='codexApp'?[]:checkMemberGrantsCurrent(deps.paths,policy,{runtime:group.runtime,sessionId:group.originalId},records,selection.memberGrants??[],now);
  }
  if(selection.route==='fork-reply'&&readCodexSession(deps.paths,group.originalId)?.permissionMode!==selection.permissionMode)return null;
  if(selection.route==='fork-reply')return deps.workerCapabilities?.()?.includes(MESSAGING_PROXY_CAPABILITY)===true&&selection.grant==='fork'&&!!selection.attemptId&&currentForkAdmission({...deps,now:()=>now,postToolHook:deps.codex?.postToolHook},context,group.policyFingerprint,selection.attemptId)?[]:null;
  const sessions=policy.sessions;
  if(op.producer?.kind==='command') {
    const launch=op.producer.launch;
    if(!sessions?.enabled||!sessions.runtimes.includes(op.execution.runtime==='codex'?'codex':'claude')||!launch)return null;
    const cwd=resolveCwd(sessions,launch.cwd,deps.realpath);
    if(!cwd.ok||cwd.cwd!==launch.cwd)return null;
  }
  if(selection.route==='closed-start'||selection.route==='closed-resume') {
    if(selection.grant!=='resumeClosed'||policy.messaging?.resumeClosed!==true||!sessions?.delegate.accept
      ||!mode||!sessions.permissionModes.includes(mode as never)||records.some(r=>!acceptsMessage(policy,r.closedTo??r.toSession,r.from.nodeId,readLocalSessions(deps.paths))))return null;
  }
  if(op.execution.taskId&&overLimit({...deps,policy},now,op.execution.taskId))return null;
  const task=selection.taskId?readTask(deps.paths,selection.taskId):undefined;
  if(selection.taskId) {
    if(!task||(op.kind!=='hook-continue'&&task.taskId!==op.execution.taskId)||task.operatorStoppedAt!==undefined||task.permissionMode!==mode
      ||task.runtime!==(op.execution.runtime==='codex'?'codex':'claude')&&!(task.runtime===undefined&&op.execution.runtime==='claude-code')
      ||op.execution.sessionId!==null&&task.sessionId!==op.execution.sessionId
      ||op.producer?.launch&&task.cwd!==op.producer.launch.cwd)return null;
  }
  switch(selection.grant) {
    case 'resumeClosed':return [];
    case 'members':return checkMemberGrantsCurrent(deps.paths,policy,{runtime:group.runtime,sessionId:group.originalId},records,selection.memberGrants??[],now);
    case 'stop':return selection.route==='codex-stop'||selection.route==='claude-stop'?[]:null;
    default:return null;
  }
}
