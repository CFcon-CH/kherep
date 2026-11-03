import { mayRetarget } from "./message-owner.mts";
import { isMessageId, isSessionRef } from "../protocol-messages.mts";
import { isTaskId, SUPPORTED_RUNTIMES } from "../protocol-tasks.mts";
import { getMessage, listInbox, replaceInboxRecordLocked, type DeliveryTaskIdentity, type InboxRecord } from "./inbox.mts";
import { withRecordLock } from "./inbox-record-lock.mts";
import type { NodePaths } from './config.mts';
import { adoptRouteCopy } from './target-delivery-adoption.mts';
import { canonical } from './target-delivery-state.mts';

type Scope = Pick<DeliveryTaskIdentity, "taskId" | "runtime">;

// The adoption lane uses the same record lock/atomic replacement as inbox
// writers, judging the fresh body rather than its enumeration snapshot.
function rewrite(dir: string, messageId: string, change: (r: InboxRecord) => InboxRecord | null): boolean {
  if (!isMessageId(messageId)) return false;
  return withRecordLock(dir, messageId, () => {
    const record = getMessage(dir, messageId);
    if(record?.targetAttempt)throw Error('strict task handover requires route journal');
    const next = record ? change(record) : null;
    if (!next || !mayRetarget(record!, { sessionId: next.toSession, runtime: next.binding?.to.runtime ?? null })) return false;
    replaceInboxRecordLocked(dir, messageId, next);
    return true;
  });
}

// A copy takes all pending messages at its previous address (legacy behavior),
// plus pending exact-owned intermediates left by an interrupted adoption.
// Both callers retry typed contention; this is not a historical inbox sweep.
export function handoverTaskMessages(dir: string, from: string, to: string, scope: Scope): void {
  if (!isSessionRef(from) || !isSessionRef(to) || typeof scope !== "object" || scope === null
    || !isTaskId(scope.taskId) || !SUPPORTED_RUNTIMES.includes(scope.runtime)) {
    throw new Error("invalid task handover identity or session");
  }
  if (from === to) return;
  if(listInbox(dir).some(r=>r.targetAttempt&&(r.toSession===from||r.delivery?.taskId===scope.taskId&&r.delivery.runtime===scope.runtime)))throw Error('strict task handover requires route journal');
  handoverLegacy(dir,from,to,scope);
}
function handoverLegacy(dir:string,from:string,to:string,scope:Scope):void {
  const owned = (r: InboxRecord): boolean => !Object.hasOwn(r,"binding") && r.delivery?.taskId === scope.taskId && r.delivery?.runtime === scope.runtime;
  const waiting = (r: InboxRecord): boolean => !Object.hasOwn(r,"binding") && (r.state === "accepted" || r.state === "offered")
    && r.toSession !== to && (r.toSession === from || owned(r));
  const moved: string[] = [];
  for (const record of listInbox(dir).filter(r=>!r.targetAttempt&&waiting(r))) {
    if (rewrite(dir, record.messageId, (fresh) => waiting(fresh)
      ? { ...fresh, toSession: to, closedTo: fresh.closedTo ?? fresh.toSession } : null)) moved.push(record.messageId);
  }
  // Include target-local terminal records: a turn may have consumed a moved
  // message before the interrupted identity phase retries. Never move them.
  const ids = new Set([...moved, ...listInbox(dir, to).filter(r=>!r.targetAttempt&&owned(r)).map((r) => r.messageId)]);
  for (const messageId of ids) {
    rewrite(dir, messageId, (record) => owned(record) && record.toSession === to && record.delivery!.sessionId !== to
      ? { ...record, delivery: { ...record.delivery!, sessionId: to } } : null);
  }
}

export function handoverDeliveryMessages(paths:NodePaths,from:string,to:string,scope:Scope):void {
  if(!isSessionRef(from)||!isSessionRef(to)||!isTaskId(scope.taskId)||!SUPPORTED_RUNTIMES.includes(scope.runtime))throw Error('invalid task copy mapping');
  const selected=listInbox(paths.inbox).filter(r=>r.toSession===from||r.delivery?.taskId===scope.taskId&&r.delivery.runtime===scope.runtime);
  const groups=new Map(selected.filter(r=>r.targetAttempt).map(r=>[canonical(r.targetAttempt),r.targetAttempt!]));
  for(const h of groups.values())adoptRouteCopy(paths,h,scope,to);
  handoverLegacy(paths.inbox,from,to,scope);
}
