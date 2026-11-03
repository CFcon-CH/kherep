import { automaticReplyDecision } from "./reply-admission.mts";
import {captureListedGrant,freezeMemberGrants} from './message-grant.mts';
import {queueRouteEligible} from './message-admission-policy.mts';
import { prepareMessageLaunch } from "./target-delivery-launch.mts";
import { commandProducer, decideMessageRoute } from "./target-delivery-producer.mts";
import { finishRouteEffect } from "./target-delivery-outcome.mts";
import { checkExecution } from "./target-delivery-route.mts";
import type { ExecutionContext } from "./target-delivery-operation.mts";
import fs from "node:fs";
import { beginTargetSubmission, finishTargetSubmission } from "./target-delivery.mts";
import type { TargetHandle, TargetReservation } from "./target-delivery-reservation.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";
import type { NodePaths } from "./config.mts";
import { livenessAdmission } from "./session-lifecycle.mts";
import path from "node:path";

import { bypassesPermissions, type WakeGrant } from "./autonomy.mts";
import { codexHome, currentCodexApp } from "./codex-app.mts";
import { findCodex } from "./codex-binary.mts";
import { busyPolicyFingerprint, busyWakeDisabled } from "./codex-busy-policy.mts";
import { tuiMarker } from "./codex-daemon.mts";
import { queueProducerIdentity } from "./codex-queue-context.mts";
import { queueArgs, runQueue } from "./codex-queue-run.mts";
import { MAX_NATIVE_ATTEMPTS, nativeAttemptsPath, nativeQueueInput } from "./codex-native-attempts.mts";
import { reserveNativeOwner, releaseNativeOwner } from "./codex-native-pending.mts";
import { reconcileNativeQueues } from "./codex-native-reconcile.mts";
import { CODEX_ACTIVE_MS, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { ensureDir, readConfig } from "./config.mts";
import { getMessage, writeJsonAtomic } from "./inbox.mts";
import { explicitlyListed, readPolicy, wakeAllowed, wakeBudget } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { waitForServiceAdmission, type ServiceAdmission } from "./service-drain.mts";
import { listTasks } from "./task-records.mts";

// A separate namespace leaves legacy Queue cards/bindings untouched. An
// unreadable, partial or uncertain attempt is never interpreted as absent.
export { MAX_NATIVE_ATTEMPTS } from "./codex-native-attempts.mts";
const MAX_BATCH = 8;
const pending = new Map<string, Promise<void>>();
let nativeLane: Promise<void> = Promise.resolve();
export function nativeAttemptDir(deps: RunnerDeps, owner: string): string {
  return nativeAttemptsPath(deps.paths, owner);
}

export async function nativeQueueIdle(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
}

function reconcile(deps: RunnerDeps, owner: string, admission: ServiceAdmission): Promise<void> {
  return deps.codex?.reconcileQueue?.(owner, admission) ?? reconcileNativeQueues(deps.paths, owner, {}, admission);
}

// Recovery shares the bounded serial lane, but never reserves an enqueue slot.
export function scheduleNativeReconciliation(deps: RunnerDeps, owner: string, log: (line: string) => void): void {
  const key = `${path.join(deps.paths.dir, owner)}:reconcile`;
  if (pending.has(key)) return;
  const work = nativeLane.then(() => new Promise<void>((resolve) => { setImmediate(resolve); }))
    .then(() => waitForServiceAdmission(deps.paths, admission => reconcile(deps, owner, admission), { probe: deps.serviceOwner }))
    .catch(() => { log("kherep-node: native queue reconciliation pending"); })
    .finally(() => { pending.delete(key); });
  pending.set(key, work);
  nativeLane = work;
}

// Independent of the CP hint lane: a stalled CLI cannot delay publication.
// Off unless wake.nativeQueue is true (issue #429); the CP hint path is unchanged.
export function scheduleNativeQueue(deps: RunnerDeps, owner: string, messageIds: string[],
  grant: WakeGrant | undefined, log: (line: string) => void): void {
  if (deps.policy.wake?.nativeQueue !== true) return;
  const key = path.join(deps.paths.dir, owner);
  if (pending.has(key)) return;
  const fingerprint = busyPolicyFingerprint(deps.policy);
  const work = nativeLane.then(() => new Promise<void>((resolve) => { setImmediate(resolve); }))
    .then(() => waitForServiceAdmission(deps.paths,
      admission => produce(deps, owner, messageIds, fingerprint, grant, admission), { probe: deps.serviceOwner }))
    .catch(() => { log("kherep-node: native Codex Queue outcome unavailable; original intake remains pending"); })
    .finally(() => { pending.delete(key); });
  pending.set(key, work);
  nativeLane = work;
}

function admitted(deps: RunnerDeps, owner: string, messageIds: string[], fingerprint: string, grant?: WakeGrant):
  { ids: string[]; budget: ReturnType<typeof wakeBudget> } | null {
  const now = deps.now?.() ?? Date.now();
  if (livenessAdmission(deps.paths, { runtime: "codex", sessionId: owner }, "queue", now, undefined, deps.livenessAuthority) === null) return null;
  const policy=queueRouteEligible(deps,owner,fingerprint,now,grant);
  if(!policy)return null;
  const ids = messageIds.filter((id) => {
    const record = getMessage(deps.paths.inbox, id);
    return record?.messageId === id && record.toSession === owner && record.state === "accepted"
      && automaticReplyDecision(record).allowed;
  });
  return ids.length ? { ids: [...new Set(ids)], budget: wakeBudget(policy) } : null;
}

function absent(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function produce(deps: RunnerDeps, owner: string, messageIds: string[], fingerprint: string, grant: WakeGrant | undefined,
  serviceAdmission: ServiceAdmission): Promise<void> {
  const file = (deps.codex?.findCodex ?? findCodex)();
  if (!file) return;
  const admission = admitted(deps, owner, messageIds, fingerprint, grant);
  if (!admission) return;
  const dir = nativeAttemptDir(deps, owner);
  ensureDir(dir);
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("invalid native attempt directory");
  const storedAttemptCount = fs.readdirSync(dir).length;
  const remainingCapacity = Math.max(0, MAX_NATIVE_ATTEMPTS - storedAttemptCount);
  const available = admission.ids.filter((id) => absent(path.join(dir, `${id}.json`)));
  const ids = available.slice(0, Math.min(MAX_BATCH, remainingCapacity));
  if (!ids.length) return;
  const producer = queueProducerIdentity(file, queueArgs(owner, ids.length), deps);
  if (producer.route !== "local" || producer.approvedFiles.length === 0) return;
  const now = deps.now?.() ?? Date.now();
  const records=ids.map(id=>getMessage(deps.paths.inbox,id)!);
  const policy=readPolicy(deps.paths.policy,true);
  const basis=policy&&captureListedGrant(policy,{runtime:'codex',sessionId:owner});
  if(grant!=='codexApp'&&!basis)return;
  const memberGrants=basis?freezeMemberGrants(records,records.map(r=>({...basis,messageId:r.messageId}))):undefined;
  const launch=await prepareMessageLaunch(deps,{runtime:"codex",file,args:queueArgs(owner,ids.length),cwd:process.cwd(),detached:(deps.codex?.platform??process.platform)!=="win32"});
  const decision=decideMessageRoute({...deps,messageRoute:{route:'native-queue',grant:grant==='codexApp'?'codexApp':'members',memberGrants,permissionMode:readCodexSession(deps.paths,owner)?.permissionMode}},records,owner,"queue",{runtime:"codex",sessionId:owner,taskId:null},launch.producer,owner,launch);
  if(decision.status!=="granted")return;
  const context=decision.context;if(context.kind!=="message")return;
  await submitTargetQueueGroup(deps.paths,context.handle,()=>deps.now?.()??Date.now(),async()=>
    runQueue({...deps,codex:{...deps.codex,findCodex:()=>file,home:producer.resolvedCodexHome}},
      queueArgs(owner,ids.length),producer,serviceAdmission,context),context);
  // Explicit processing ACK may have delivered content while native admission was in flight.
  // Cleanup failure must never overwrite the successfully persisted queue ID.
  await reconcile(deps, owner, serviceAdmission);
}

// Shared queue submission. The version2 core adapter remains compatible;
// production uses the explicit version3 operation context.
export function submitTargetQueueGroup(paths:NodePaths,handle:TargetHandle,now:()=>number,
  submit:(request:{owner:string;input:ReturnType<typeof nativeQueueInput>;producer:QueueProducerIdentity})=>Promise<{queueId?:string}>):Promise<TargetReservation>;
export function submitTargetQueueGroup(paths:NodePaths,handle:TargetHandle,now:()=>number,
  submit:(request:{owner:string;input:ReturnType<typeof nativeQueueInput>;producer:QueueProducerIdentity})=>Promise<{queueId?:string}>,context:ExecutionContext):Promise<void>;
export async function submitTargetQueueGroup(paths: NodePaths,
  handle: TargetHandle, now: () => number,
  submit: (request: { owner: string; input: ReturnType<typeof nativeQueueInput>; producer: QueueProducerIdentity }) => Promise<{ queueId?: string }>, context?:ExecutionContext): Promise<TargetReservation | void> {
  if(context) {
    const state=checkExecution(paths,context,["queue"],handle.owner)!;
    const p=(state.consumer??state.group.operation).producer!;
    const producer:QueueProducerIdentity={codexExecutable:p.files[0].path,launchFile:p.launchFile,launchPrefix:p.launchPrefix,approvedFiles:p.files,resolvedCodexHome:p.home!,route:p.route};
    try { const result=await submit({owner:handle.owner,input:nativeQueueInput(handle.owner,state.group.binding.members.length),producer});
      finishRouteEffect(paths,context,result.queueId?{kind:"queue",queueId:result.queueId}:{kind:"uncertain"});
    } catch {finishRouteEffect(paths,context,{kind:"uncertain"});}
    return;
  }
  const saved = beginTargetSubmission(paths, handle, now());
  let result: { queueId?: string };
  try { result = await submit({ owner: saved.owner, input: nativeQueueInput(saved.owner, saved.group.members.length), producer: saved.group.producer! }); }
  catch { return finishTargetSubmission(paths, handle); }
  return finishTargetSubmission(paths, handle, result.queueId);
}
