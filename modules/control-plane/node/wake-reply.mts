import {captureOwnerGrant,replyIdentity,requestIdentity,type MemberGrant} from './message-grant.mts';
import { isNodeId } from "../protocol.mts";
import { isMessageId } from "../protocol-messages.mts";
import { isTaskId } from "../protocol-tasks.mts";
import { audit, type AutonomyAction, type WakeGrant } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { getSent, type SentRecord } from "./exchange.mts";
import type { InboxRecord } from "./inbox.mts";
import type { NodePolicy } from "./policy.mts";
import { readRequest, requestIds, type TaskRecord, type TaskRequestRecord } from "./task-records.mts";

// Reply grant (issue #253, operator decisions of 2026-10-05): with wake.replies
// a reply to a message this node sent from a session may wake that session
// without a listing. A per-message grant like the task grant, not a listing:
// wakeAllowed and explicitlyListed are unchanged, and every other guard
// (kill switch, bypassPermissions, reply depth, budget) applies as before.

// The original may be this old by the sender's own clock (sent createdAt).
export const REPLY_GRANT_MAX_AGE_MS = 24 * 60 * 60_000;

const ENDED: SentRecord["state"][] = ["refused", "expired", "error"];

// Whether record answers a message the session with these refs (its id and
// current name) sent, from the node it was sent to. The Worker sets from.nodeId
// from the authenticated connection but does not check inReplyTo, so the node
// clause stops a third node that knows a message id. The session binds by the
// id the sent record keeps; only a record without one (older version) falls
// back to its fromSession name. Any doubt or read error denies.
export function replyProof(paths: NodePaths, refs: string[], record: InboxRecord, now: number): SentRecord | null {
  if (!isMessageId(record.inReplyTo) || !isNodeId(record.from?.nodeId)) return null;
  let sent: SentRecord | null;
  try {
    sent = getSent(paths, record.inReplyTo);
  } catch {
    return null;
  }
  if (sent?.messageId !== record.inReplyTo || !sent?.to || typeof sent.createdAt !== "string" || typeof sent.fromSession !== "string") return null;
  if (sent.to.nodeId !== record.from.nodeId) return null;
  if (!refs.includes(sent.fromSessionId ?? sent.fromSession)) return null;
  const age = now - Date.parse(sent.createdAt);
  return age >= 0 && age <= REPLY_GRANT_MAX_AGE_MS && !ENDED.includes(sent.state) ? sent : null;
}

export function replyGrants(paths:NodePaths,refs:string[],record:InboxRecord,now:number):boolean {return replyProof(paths,refs,record,now)!==null;}

// Task message grant (issue #264): a task this node requested answers with
// messages that carry its task id and no inReplyTo (task-prompt.mts tells it to
// answer with a plain msg send), so neither grant above covers them.

// This node's task requests by the task id the Worker dispatched them as; null
// marks a task id two requests claim. Requests are keyed by request id, so a
// grant would otherwise scan the directory for every record: the index is
// built once per poll or observation (lazyRequests), over task-requests/, which
// holds one file per `msg send --new` or `task new`. Any read error leaves
// it empty, so nothing is granted: an unreadable file could be a second claim.
export type RequestIndex = Map<string, TaskRequestRecord | null>;
export function requestsByTask(paths: NodePaths): RequestIndex {
  const index: RequestIndex = new Map();
  try {
    for (const requestId of requestIds(paths)) {
      const request = readRequest(paths, requestId);
      if (!request || request.requestId !== requestId || request.taskId !== undefined && !isTaskId(request.taskId)) return new Map();
      if (typeof request.taskId === "string") index.set(request.taskId, index.has(request.taskId) ? null : request);
    }
  } catch {
    return new Map();
  }
  return index;
}

// requestsByTask, read on first use and kept for one poll or observation.
export function lazyRequests(paths: NodePaths): () => RequestIndex {
  let index: RequestIndex | undefined;
  return () => (index ??= requestsByTask(paths));
}

// Whether record is a message of a task the session with these refs requested,
// from the node the Worker dispatched it to. The Worker accepts a taskId only
// from or to the node running the task, but not only from the task's own
// session, so the node clause is the essential one. The session binds by the
// id the request keeps; a request an earlier version wrote without one binds
// by its requestedBy name. The task's lifetime is not observable here, so the
// bound is 24 h from the request's createdAt. Any doubt or read error denies.
export function taskMessageProof(paths: NodePaths, refs: string[], record: InboxRecord, now: number,
  requests: () => RequestIndex = () => requestsByTask(paths)): TaskRequestRecord | null {
  if (!isTaskId(record.taskId) || !isNodeId(record.from?.nodeId)) return null;
  const request = requests().get(record.taskId);
  if (request?.state !== "dispatched" || request.nodeId !== record.from.nodeId) return null;
  if (!refs.includes(request.requestedBySessionId ?? request.requestedBy)) return null;
  const age = now - Date.parse(request.createdAt);
  return age >= 0 && age <= REPLY_GRANT_MAX_AGE_MS ? request : null;
}

export function taskMessageGrants(paths:NodePaths,refs:string[],record:InboxRecord,now:number,requests:()=>RequestIndex=()=>requestsByTask(paths)):boolean {return taskMessageProof(paths,refs,record,now,requests)!==null;}

export function captureUnlistedGrant(paths:NodePaths,policy:NodePolicy,refs:string[],task:TaskRecord|undefined,row:InboxRecord,now:number,requests:()=>RequestIndex=()=>requestsByTask(paths)):MemberGrant|null {
  const owner=task&&captureOwnerGrant(task,row);
  if(owner)return owner;
  if(policy.wake?.replies!==true)return null;
  const sent=replyProof(paths,refs,row,now);
  if(sent)return {messageId:row.messageId,kind:'reply',original:replyIdentity(sent)};
  const request=taskMessageProof(paths,refs,row,now,requests);
  return request?{messageId:row.messageId,kind:'task-message',original:requestIdentity(request)}:null;
}

// What a listener its listing does not cover wakes for (wake-hook.mts): the
// records of its task grant and, with wake.replies, granted replies and task
// messages. kinds names the grant of each id granted that way, for the audit.
export function unlistedGrants(paths: NodePaths, policy: NodePolicy, refs: string[], task: TaskRecord | undefined, now: number) {
  const kinds = new Map<string, WakeGrant>();
  const witnesses = new Map<string,MemberGrant>();
  const requests = lazyRequests(paths);
  const grants = (record: InboxRecord): boolean => {
    const witness=captureUnlistedGrant(paths,policy,refs,task,record,now,requests);
    if(!witness)return false;
    witnesses.set(record.messageId,witness);
    if(witness.kind==='reply')kinds.set(record.messageId,'reply');
    else if(witness.kind==='task-message')kinds.set(record.messageId,'task');
    return true;
  };
  return { grants, kinds, witnesses };
}

// One audit line for the ids woken through the listing or a task grant, one
// per grant for those only a reply or task message grant covered.
export function auditGranted(paths: NodePaths, now: number, sessionId: string, ids: string[], action: AutonomyAction,
  kinds: ReadonlyMap<string, WakeGrant>): void {
  for (const grant of [undefined, "reply", "task"] as const) {
    const some = ids.filter((id) => kinds.get(id) === grant);
    if (some.length > 0) audit(paths, now, sessionId, some, action, grant);
  }
}
