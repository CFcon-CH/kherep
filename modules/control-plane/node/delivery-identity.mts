import { setInboxDelivery } from "./target-delivery-inbox.mts";
import { transitionRouteMessages, replayRouteTransition, bindRouteExecutionSession, finishRouteEffect } from "./target-delivery-outcome.mts";
import { checkExecution, withRoute } from "./target-delivery-route.mts";
import type { TaskRuntime } from "../protocol-tasks.mts";
import type { NodePaths } from "./config.mts";
import { getMessage, setDeliveryTask } from "./inbox.mts";
import { RecordLockBusy } from "./inbox-record-lock.mts";
import type { TaskRecord } from "./task-records.mts";
import { effectiveRouteSession } from './target-delivery-operation.mts';
import { handoverDeliveryMessages } from './task-handover.mts';

const runtimeOf = (task: TaskRecord): TaskRuntime => task.runtime ?? "claude";

// busy: a caller past an irreversible start or resume skips a record whose
// lock stays held (issue #627); without it, RecordLockBusy ends the round.
export function attachDelivery(paths: NodePaths, task: TaskRecord, messageIds: string[], busy?: (error: RecordLockBusy) => void): TaskRecord {
  const ids = [...new Set(messageIds)];
  if(task.targetAttempt) {
    const ctx={kind:"message" as const,handle:task.targetAttempt};
    if(task.mappingPendingSince||task.observedSessionId) {
      const saved=withRoute(paths,task.targetAttempt,s=>s),op=saved.consumer??saved.group.operation;
      if(op.execution.taskId!==task.taskId||JSON.stringify([...ids].sort())!==JSON.stringify(saved.group.binding.members.map(m=>m.messageId).sort()))throw Error('pending delivery mapping group differs');
      return {...task,deliveryPending:ids};
    }
    replayRouteTransition(paths,ctx);
    const saved=checkExecution(paths,ctx,["task-start","exec-resume","hook-continue"]);
    const op=saved?.consumer??saved?.group.operation;
    if(!op||op.execution.taskId!==task.taskId||op.execution.runtime!==(runtimeOf(task)==="codex"?"codex":"claude-code")
      ||task.sessionId!==undefined&&task.sessionId!==effectiveRouteSession(saved!))throw Error("delivery task/runtime/session differs");
    if(!saved||JSON.stringify([...ids].sort())!==JSON.stringify(saved.group.binding.members.map(m=>m.messageId).sort()))throw Error("delivery mapping group differs");
    transitionRouteMessages(paths,ctx,r=>({...r,delivery:{taskId:task.taskId,runtime:runtimeOf(task),...(task.sessionId?{sessionId:task.sessionId}:{})}}));
    return task.sessionId?task:{...task,deliveryPending:ids};
  }
  for (const messageId of ids) {
    try {
      setInboxDelivery(paths, messageId, {
        taskId: task.taskId,
        runtime: runtimeOf(task),
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      });
    } catch (error) {
      if (!busy || !(error instanceof RecordLockBusy)) throw error;
      busy(error);
    }
  }
  if (task.sessionId || ids.length === 0) return task;
  return { ...task, deliveryPending: [...new Set([...(task.deliveryPending ?? []), ...ids])] };
}

export function resolveDelivery(paths: NodePaths, task: TaskRecord): TaskRecord {
  if(task.targetAttempt)task=finalizeMessageTaskIdentity(paths,task);
  if(task.observedSessionId)return task;
  if (!task.sessionId || !task.deliveryPending?.length) return task;
  if(task.targetAttempt) {
    const ctx={kind:"message" as const,handle:task.targetAttempt};
    bindRouteExecutionSession(paths,ctx,task.sessionId);
    attachDelivery(paths,task,task.deliveryPending);
    return {...task,deliveryPending:undefined};
  }
  for (const messageId of task.deliveryPending) {
    if (getMessage(paths.inbox, messageId)?.delivery?.taskId !== task.taskId) continue;
    setInboxDelivery(paths, messageId, {
      taskId: task.taskId,
      runtime: runtimeOf(task),
      sessionId: task.sessionId,
    });
  }
  return { ...task, deliveryPending: undefined };
}

// Never publish a newly observed native UUID before its exact process result
// and same-namespace alias have been bound to the original message attempt.
export function finalizeMessageTaskIdentity(paths:NodePaths,task:TaskRecord,copyFrom?:string):TaskRecord {
  if(!task.targetAttempt)return task;
  const candidate=task.observedSessionId??task.sessionId;
  if(!candidate)return task;
  const ctx={kind:"message" as const,handle:task.targetAttempt};
  replayRouteTransition(paths,ctx);
  const s=withRoute(paths,task.targetAttempt,s=>s),op=s.consumer??s.group.operation;
  if(op.execution.taskId!==task.taskId||op.execution.runtime!==(runtimeOf(task)==="codex"?"codex":"claude-code"))throw Error("task result attempt differs");
  const pending={...task,observedSessionId:candidate,sessionId:effectiveRouteSession(s)??undefined,mappingPendingSince:task.mappingPendingSince??task.updatedAt};
  if(s.executionSessionId&&candidate!==s.executionSessionId&&effectiveRouteSession(s)===candidate&&s.adoptions?.at(-1)?.phase==='converged') {
    const {observedSessionId:_observed,mappingPendingSince:_pending,mappingConflict:_conflict,...rest}=task;
    return {...rest,sessionId:candidate};
  }
  if(copyFrom&&task.local==='intercom'&&runtimeOf(task)==='claude'&&s.executionSessionId&&candidate!==s.executionSessionId) {
    if(copyFrom!==effectiveRouteSession(s))return {...pending,mappingConflict:'identity-or-alias'};
    handoverDeliveryMessages(paths,copyFrom,candidate,{taskId:task.taskId,runtime:'claude'});
    const {observedSessionId:_observed,mappingPendingSince:_pending,mappingConflict:_conflict,...rest}=task;
    return {...rest,sessionId:candidate};
  }
  if(!task.pid||!task.pidStart)return pending;
  try {
    finishRouteEffect(paths,ctx,{kind:"exec",pid:task.pid,pidStart:task.pidStart,threadId:candidate});
    bindRouteExecutionSession(paths,ctx,candidate);
  }catch{return {...pending,mappingConflict:"identity-or-alias"};}
  if(s.adoptions?.length&&effectiveRouteSession(s)!==candidate)handoverDeliveryMessages(paths,effectiveRouteSession(s)!,candidate,{taskId:task.taskId,runtime:runtimeOf(task)});
  transitionRouteMessages(paths,ctx,r=>({...r,delivery:{taskId:task.taskId,runtime:runtimeOf(task),sessionId:candidate},
    ...(r.toSession!==candidate?{closedTo:r.closedTo??r.toSession,toSession:candidate}:{})}));
  const {observedSessionId:_observed,mappingPendingSince:_pending,mappingConflict:_conflict,...rest}=task;
  return {...rest,sessionId:candidate};
}
