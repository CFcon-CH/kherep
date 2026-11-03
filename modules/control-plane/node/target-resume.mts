import {assertTargetAddresses} from './target-resume-address.mts';
import { DELEGATED_PERMISSION_MODES } from '../protocol-tasks.mts';
import { nativeQueueInput } from './codex-native-attempts.mts';
import { busyPolicyFingerprint } from './codex-busy-policy.mts';
import { closedFallbackGeneration, sessionVerdict } from './session-lifecycle.mts';
import { resolveCwd } from './task-prompt.mts';
import { overLimit } from './task-admission.mts';
import { unavailableTargetResumePort, type OriginalMessageContext } from './target-resume-port.mts';
import { decideMessageRoute } from './target-delivery-producer.mts';
import { beginRouteEffect, routeMembersCurrent, verifyRouteDebit, withRoute } from './target-delivery-route.mts';
import { finishRouteEffect, transitionRouteMessages } from './target-delivery-outcome.mts';
import { requireMessageEffect } from './message-admission.mts';
import { readPolicy } from './policy.mts';
import { canonical, uuid } from './target-delivery-state.mts';
import type { TargetHandle } from './target-delivery-reservation.mts';
import type { RunnerDeps } from './session-runner.mts';
import { getMessage, type InboxRecord } from './inbox.mts';

import {pendingOriginalResumes as pending,originalResumeKey as key,coalesceOriginalSelection,retireOriginalCache,type PendingOriginalResume} from './target-resume-state.mts';
import {runOriginalResume} from './target-resume-run.mts';
import {readReconciledRouteQueueRetirement} from './target-delivery-queue.mts';
export const TARGET_RESUME_WAIT_MS=600_000;
export type TargetResumeResult={status:'not-selected'|'unavailable'|'refused'|'unknown-fenced'|'original-processing'|'resumed-original-awaiting-completion'|'completed-original'|'retired-original-queue';reason:string}|{status:'queued-awaiting-original';handle:TargetHandle;dueAt:number;reason:string};
export interface TargetResumeSelection {sessionId:string;runtime:'codex'|'claude-code';cwd?:string;permissionMode?:string}
export async function advanceTargetResume(deps:RunnerDeps,sessionId:string):Promise<TargetResumeResult> {
 const state=pending.get(key(deps,sessionId));if(!state)return {status:'unknown-fenced',reason:'current-process-state-unavailable'};
 if(state.flight)return state.flight;
 const flight=Promise.resolve().then(async():Promise<TargetResumeResult>=>{
  try {
   if(state.result||state.candidate){const result=await runOriginalResume(deps,state);if(result.status==='completed-original')retireOriginalCache(deps,sessionId,state);return result;}
   if(state.attempted)return {status:'unknown-fenced',reason:'original-execution-unknown'};
   if(readReconciledRouteQueueRetirement(deps.paths,state.context.handle)){retireOriginalCache(deps,sessionId,state);return {status:'retired-original-queue',reason:'queue-processed'};}
   const route=withRoute(deps.paths,state.context.handle,s=>{if(!routeMembersCurrent(deps.paths,s))throw Error('members changed');verifyRouteDebit(deps.paths,s);return s;}),now=deps.now?.()??Date.now();
   if(state.target.runtime==='claude-code'){
    if(state.dueAt!==null||state.submittedAt!==null||route.targetResume||!Number.isSafeInteger(now))return {status:'unknown-fenced',reason:'queue-state-unknown'};
    if(now>=route.group.binding.deadlineMs)return {status:'refused',reason:'deadline'};
    return await runOriginalResume(deps,state);
   }
   if(state.dueAt===null||state.submittedAt===null||!route.targetResume||canonical(route.targetResume)!==canonical({version:1,queueId:route.targetResume.queueId,submittedAt:state.submittedAt,dueAt:state.dueAt})||!Number.isSafeInteger(now)||now<state.submittedAt)return {status:'unknown-fenced',reason:'queue-state-unknown'};
   if(now>=route.group.binding.deadlineMs)return {status:'refused',reason:'deadline'};
   if(now<state.dueAt)return {status:'queued-awaiting-original',handle:state.context.handle,dueAt:state.dueAt,reason:'pointer-wait'};
   return await runOriginalResume(deps,state);
  }catch{return {status:'unknown-fenced',reason:'queue-state-unknown'};}
 });state.flight=flight;try{return await flight;}finally{if(state.flight===flight)state.flight=undefined;}
}
export async function pendingTargetResumes(deps:RunnerDeps):Promise<{sessionId:string;records:InboxRecord[];result:TargetResumeResult}[]> {
 const result=[];for(const [storedKey,state] of pending){const sessionId=state.context.handle.owner;if(storedKey!==key(deps,sessionId))continue;
 let records:InboxRecord[]=[];try{records=withRoute(deps.paths,state.context.handle,s=>s.group.binding.members.map(m=>getMessage(deps.paths.inbox,m.messageId)).filter((r):r is InboxRecord=>r!==null));}catch{/* exact retirement checked by advance */}
 result.push({sessionId,records,result:await advanceTargetResume(deps,sessionId)});}return result;
}
export function selectTargetResume(deps:RunnerDeps,target:TargetResumeSelection,records:readonly InboxRecord[]):Promise<TargetResumeResult>{return coalesceOriginalSelection(deps,target.sessionId,()=>selectOriginalTarget(deps,target,records));}
async function selectOriginalTarget(deps: RunnerDeps, target: TargetResumeSelection,
  records: readonly InboxRecord[]): Promise<TargetResumeResult> {
  const policy = deps.policy, sessions = policy.sessions;
  if (policy.messaging?.resumeTarget !== true) return { status: 'not-selected', reason: 'not-selected' };
  if (pending.has(key(deps, target.sessionId))) return advanceTargetResume(deps, target.sessionId);
  if (policy.messaging.resumeClosed !== true || !sessions?.enabled || !sessions.delegate.accept
    || !sessions.runtimes.includes(target.runtime === 'codex' ? 'codex' : 'claude')) return { status: 'refused', reason: 'policy-unavailable' };
  const mode = target.permissionMode;
  if (!DELEGATED_PERMISSION_MODES.includes(mode as never) || !sessions.permissionModes.includes(mode as never))
    return { status: 'refused', reason: 'permission-restricted' };
  if (target.runtime === 'codex' && policy.wake?.nativeQueue !== true) return { status: 'unavailable', reason: 'native-queue-disabled' };
  if (overLimit(deps, deps.now?.() ?? Date.now())) return { status: 'refused', reason: 'target-busy' };
  const cwd = resolveCwd(sessions, target.cwd, deps.realpath);
  if (!cwd.ok) return { status: 'refused', reason: 'cwd-refused' };
  const now = deps.now?.() ?? Date.now();
  const generation = closedFallbackGeneration(deps.paths, target, now, undefined, deps.livenessAuthority);
  const lifecycleGeneration = sessionVerdict(deps.paths, target, now).lifecycleGeneration;
  if (generation === null || lifecycleGeneration === undefined) return { status: 'refused', reason: 'authority-unavailable' };
  let context: OriginalMessageContext | undefined;
  try {
    assertTargetAddresses(deps.paths,records,{...target,lifecycleGeneration},now);
    const fingerprint = busyPolicyFingerprint(policy);
    const prepared = await (deps.targetResumePort ?? unavailableTargetResumePort).prepare(Object.freeze({ ...target,
      permissionMode: mode!, cwd: cwd.cwd, lifecycleGeneration, background: true }));
    if (prepared.status === 'unavailable') return { status: 'unavailable', reason: 'native-provider-unavailable' };
    const launch = target.runtime==='codex'?prepared.queueLaunch:prepared.resumeLaunch, current = readPolicy(deps.paths.policy, true), finalNow = deps.now?.() ?? Date.now();
    if (!launch || launch.binding.runtime !== target.runtime || launch.binding.cwd !== cwd.cwd
      || !current || busyPolicyFingerprint(current) !== fingerprint
      || closedFallbackGeneration(deps.paths, target, finalNow, generation, deps.livenessAuthority) === null
      || pending.size >= 512) return { status: 'refused', reason: 'preparation-changed' };
    assertTargetAddresses(deps.paths,records,{...target,lifecycleGeneration},finalNow);
    const decision = decideMessageRoute({ ...deps, messageRoute: { route: target.runtime==='codex'?'target-queue':'target-resume', grant: 'resumeTarget', permissionMode: mode } },
      [...records], target.sessionId, target.runtime==='codex'?'queue':'exec-resume', { runtime: target.runtime, sessionId: target.sessionId, taskId: null },
      launch.producer, target.sessionId, launch);
    if (decision.status !== 'granted' || decision.context.kind !== 'message') return { status: 'unknown-fenced', reason: decision.status };
    context = decision.context;
    const cached:PendingOriginalResume={context,target:Object.freeze({...target,cwd:cwd.cwd,permissionMode:mode!,lifecycleGeneration,background:true}),prepared,submittedAt:null,dueAt:null,attempted:false};
    pending.set(key(deps,target.sessionId),cached);
    transitionRouteMessages(deps.paths, context, row => ({ ...row, closedAttempt: new Date(finalNow).toISOString() }));
    if(target.runtime==='claude-code')return runOriginalResume(deps,cached);
    beginRouteEffect(deps.paths, context, ['queue']);
    const bound = context;
    let admitted = false;
    const beforeEffect = () => {
      if (admitted) throw Error('queue effect already admitted');
      requireMessageEffect(deps, bound, 'queue-spawn'); admitted = true;
    };
    // Outer preparation cannot substitute for the adapter's final synchronous guard.
    requireMessageEffect(deps, context, 'queue-spawn');
    const result = await prepared.queue(context, nativeQueueInput(target.sessionId, records.length), beforeEffect);
    const observedAt = deps.now?.() ?? Date.now();
    if (!admitted || result.status !== 'submitted' || !uuid(result.queueId) || !Number.isSafeInteger(result.submittedAt)
      || result.submittedAt < finalNow || result.submittedAt > observedAt
      || !Number.isSafeInteger(result.submittedAt + TARGET_RESUME_WAIT_MS)) throw Error('queue result unknown');
    finishRouteEffect(deps.paths, context, { kind: 'queue', queueId: result.queueId });
    const dueAt = result.submittedAt + TARGET_RESUME_WAIT_MS;
    withRoute(deps.paths, context.handle, (s, save) => save({ ...s, targetResume: { version: 1, queueId: result.queueId, submittedAt: result.submittedAt, dueAt } }));
    cached.submittedAt=result.submittedAt;cached.dueAt=dueAt;
    return { status: 'queued-awaiting-original', handle: context.handle, dueAt, reason: 'pointer-wait' };
  } catch {
    if (context) try { finishRouteEffect(deps.paths, context, { kind: 'uncertain' }); } catch { /* retain owner */ }
    return { status: 'unknown-fenced', reason: 'queue-state-unknown' };
  }
}
