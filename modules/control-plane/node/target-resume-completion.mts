import {canonical,uuid,object,keys} from './target-delivery-state.mts';
import {withRoute} from './target-delivery-route.mts';
import {retireOriginalCompletionStore,type OriginalCompletionProvider} from './target-resume-completion-store.mts';
import type {RunnerDeps} from './session-runner.mts';
import type {OriginalMessageContext,OriginalResumeObservation,OriginalCompletionExpectation,PreparedOriginalPort,OriginalRetirementResult} from './target-resume-port.mts';
const originals=new WeakMap<OriginalMessageContext,object>();
const observations=new WeakMap<object,{fingerprint:string;context:OriginalMessageContext;port:PreparedOriginalPort;expected:OriginalCompletionExpectation}>();
export function registerOriginalResumeObservation(deps:RunnerDeps,context:OriginalMessageContext,port:PreparedOriginalPort,result:OriginalResumeObservation,epoch:string):void {
 const s=withRoute(deps.paths,context.handle,s=>s),op=s.consumer??s.group.operation;
 if(!object(result)||!keys(result,['status','runtime','sessionId','cwd','permissionMode','turnId','providerEpoch','background','originalChat','pid','pidStart'])||result.status!=='observed'||result.runtime!==op.execution.runtime||result.cwd!==op.producer?.launch?.cwd||typeof result.permissionMode!=='string'||result.permissionMode.length>64||result.sessionId!==s.owner||result.background!==true||result.originalChat!==true||result.providerEpoch!==epoch||!uuid(epoch)||!Number.isSafeInteger(result.pid)||result.pid<1||typeof result.turnId!=='string'||!/^[a-zA-Z0-9._:-]{1,200}$/.test(result.turnId)||!s.originalResume||!['started','unknown','observed'].includes(s.originalResume.phase))throw Error('original observation differs');
 const original=originals.get(context);if(original&&original!==result)throw Error('original observation replaced');
 if(observations.has(result)){const bound=observations.get(result)!;if(bound.context!==context||bound.port!==port||bound.fingerprint!==canonical(result))throw Error('original observation changed');return;}originals.set(context,result);
 observations.set(result,{fingerprint:canonical(result),context,port,expected:{handle:s.handle,operation:op,lifecycleGeneration:s.group.binding.lifecycleGeneration,runtime:result.runtime,sessionId:result.sessionId,cwd:result.cwd,permissionMode:result.permissionMode,turnId:result.turnId,providerEpoch:epoch,background:true,originalChat:true}});
}
export function retireCompletedOriginalResult(deps:RunnerDeps,result:object):OriginalRetirementResult {
 const bound=observations.get(result);if(!bound||canonical(result)!==bound.fingerprint)return {status:'refused'};
 if(!bound.port.withCompletedOriginalTurnFence||bound.port.withCompletedOriginalTurnFence.constructor.name==='AsyncFunction')return {status:'unavailable'};
 const provider:OriginalCompletionProvider={withCompletedTurnFence(want,consume){return bound.port.withCompletedOriginalTurnFence!(want,turn=>canonical(turn)===canonical(bound.expected)?consume(turn):{status:'refused'});}};
 const retired=retireOriginalCompletionStore(deps,bound.context,provider,bound.expected);
 return retired;
}
export {recoverCommittedOriginalRetirement} from './target-resume-completion-store.mts';
