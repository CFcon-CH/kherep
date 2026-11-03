import path from 'node:path';
import type { NodePaths } from './config.mts';
import { getMessage, listInbox, type InboxRecord } from './inbox.mts';
import { readTask, writeTask, type TaskRecord } from './task-records.mts';
import { handoverDeliveryMessages } from './task-handover.mts';
import { readTargetRecord } from './target-delivery-files.mts';
import { effectiveRouteSession, parseRouteReservation } from './target-delivery-operation.mts';
import { withRoute, routeMembersCurrent } from './target-delivery-route.mts';
import { canonical } from './target-delivery-state.mts';

// Select the complete already-owned handover before unrelated fresh arrivals.
// Only records owned by this current local task participate, never old history.
export function pendingTaskHandover(paths:NodePaths,task:TaskRecord,originalId:string,now:number):{task:TaskRecord;records:InboxRecord[]}|null {
  const refs=new Map(listInbox(paths.inbox).filter(r=>r.targetAttempt&&r.delivery?.taskId===task.taskId)
    .map(r=>[canonical(r.targetAttempt),r.targetAttempt!]));
  if(refs.size>16)throw Error('task handover selection capacity');
  for(const h of refs.values()) {
    const saved=parseRouteReservation(readTargetRecord(path.join(paths.dir,'codex-native-pending',`${h.owner}.json`)));
    if(saved.owner!==originalId||saved.group.operation.kind!=='handover'||saved.consumer||saved.budget||saved.phase!=='handover')continue;
    const pending=saved.adoptions?.at(-1);
    if(pending&&pending.phase!=='converged') {
      const current=readTask(paths,task.taskId);
      if(!current||canonical(current)!==canonical(task)||!task.sessionId)throw Error('task handover mapping changed');
      handoverDeliveryMessages(paths,task.sessionId,pending.toSession,{taskId:task.taskId,runtime:task.runtime??'claude'});
      task=writeTask(paths,{...task,sessionId:pending.toSession},now);
    }
    return withRoute(paths,h,s=>{
      if(!routeMembersCurrent(paths,s)||effectiveRouteSession(s)!==task.sessionId)throw Error('task handover members changed');
      const records=s.group.binding.members.map(m=>getMessage(paths.inbox,m.messageId)!);
      if(records.some(r=>r.delivery?.taskId!==task.taskId||r.delivery.runtime!==(task.runtime??'claude')||canonical(r.targetAttempt)!==canonical(h)))throw Error('task handover ownership changed');
      return records.some(r=>r.state==='accepted'||r.state==='offered')?{task,records}:null;
    });
  }
  return null;
}
