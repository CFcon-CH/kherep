import {withTargetResumeSuccessor,withRoute} from './target-delivery-route.mts';
import {withAdmittedOriginalSuccessor} from './message-admission.mts';
import {canonical} from './target-delivery-state.mts';
import type {RunnerDeps} from './session-runner.mts';
import type {OriginalMessageContext,OriginalPointerExpectation,PreparedOriginalPort} from './target-resume-port.mts';
import type {OriginalPointerToken} from './target-resume-fence.mts';
import type {TargetOperation} from './target-delivery-operation.mts';
export function prepareOriginalResumeSuccessor(deps:RunnerDeps,context:OriginalMessageContext,prepared:PreparedOriginalPort,token:OriginalPointerToken,expected:OriginalPointerExpectation):OriginalMessageContext {
 const op:TargetOperation={version:1,kind:'exec-resume',producer:prepared.resumeLaunch.producer,budgetOwner:context.handle.owner,execution:{runtime:expected.target.runtime,sessionId:expected.target.sessionId,taskId:null}};
 if(expected.queueId===null){const direct=withTargetResumeSuccessor(deps.paths,context.handle,token,expected,(s,save)=>{
  const originalResume={version:1 as const,source:'direct' as const,successor:op,phase:'prepared' as const};save({...s,originalResume});save({...s,originalResume:{...originalResume,phase:'committed'}});return {...s,originalResume:{...originalResume,phase:'committed' as const}};
 });if(canonical(withRoute(deps.paths,context.handle,s=>s))!==canonical(direct))throw Error('direct successor readback differs');return context;
 }
 const next=withTargetResumeSuccessor(deps.paths,context.handle,token,expected,(s,save)=>withAdmittedOriginalSuccessor<{context:OriginalMessageContext;committed:import('./target-delivery-operation.mts').RouteReservation}>(deps,context,s,bind=>{
  if(canonical(s.group.binding.members.map(m=>m.messageId))!==canonical(expected.members)||s.group.binding.lifecycleGeneration!==expected.target.lifecycleGeneration||prepared.resumeLaunch.binding.cwd!==expected.target.cwd||!prepared.resumeLaunch.binding.detached)throw Error('original preparation differs');
  const intent={version:1 as const,source:'queue' as const,successor:op,phase:'prepared' as const};save({...s,originalResume:intent});
  const committed={...s,consumer:op,phase:'ready' as const,originalResume:{...intent,phase:'committed' as const}};save(committed);
  return {context:bind(committed,prepared.resumeLaunch),committed};
 }));
 if(canonical(withRoute(deps.paths,context.handle,s=>s))!==canonical(next.committed))throw Error('successor readback differs');return next.context;
}
