/** Trusted source composition. Production native provider remains unavailable. */
import type {PreparedMessageLaunch} from './target-delivery-launch.mts';
import type {ExecutionContext,TargetOperation} from './target-delivery-operation.mts';
import type {TargetHandle} from './target-delivery-reservation.mts';
export interface OriginalTarget {runtime:'codex'|'claude-code';sessionId:string;lifecycleGeneration:number;permissionMode:string;cwd:string;background:true}
export type OriginalMessageContext=Extract<ExecutionContext,{kind:'message'}>;
export type QueueSubmission={status:'submitted';queueId:string;submittedAt:number}|{status:'unknown'};
export interface OriginalPointerExpectation {target:Readonly<OriginalTarget>;handle:TargetHandle;queueId:string|null;members:string[];operation:TargetOperation;resumeProducer:PreparedMessageLaunch['producer']}
export interface OriginalPointerLease {epoch:string;assertActive():void}
export interface OriginalResumeGuards {beforeOuterSpawn():void;beforePromptRelease():void;beforeInnerSpawn():void;beforeInnerInput():void}
export interface OriginalResumeObservation {status:'observed';runtime:'codex'|'claude-code';sessionId:string;cwd:string;permissionMode:string;turnId:string;providerEpoch:string;background:true;originalChat:true;pid:number;pidStart:string|null}
export interface OriginalCompletionExpectation {handle:TargetHandle;operation:TargetOperation;lifecycleGeneration:number;runtime:'codex'|'claude-code';sessionId:string;cwd:string;permissionMode:string;turnId:string;providerEpoch:string;background:true;originalChat:true}
export type OriginalRetirementResult={status:'retired'|'already-retired'|'refused'|'unavailable'|'incomplete'|'unknown'};
export interface PreparedOriginalPort {
 status:'prepared';queueLaunch:PreparedMessageLaunch|null;resumeLaunch:PreparedMessageLaunch;
 queue(context:OriginalMessageContext,input:import('./codex-queue-binding.mts').QueueBinding['expectedInput'],beforeEffect:()=>void):Promise<QueueSubmission>;
 withRetiredPointerFence?<T>(expected:OriginalPointerExpectation,consume:(lease:OriginalPointerLease)=>Promise<T>):Promise<T|{status:'original-processing'|'unavailable'|'unknown'}>;
 resume?(context:OriginalMessageContext,input:string,guards:OriginalResumeGuards):Promise<OriginalResumeObservation|{status:'unknown'}>;
 withCompletedOriginalTurnFence?(expected:OriginalCompletionExpectation,consume:(turn:OriginalCompletionExpectation)=>OriginalRetirementResult):OriginalRetirementResult;
}
export interface TargetResumePort {prepare(target:Readonly<OriginalTarget>):Promise<PreparedOriginalPort|{status:'unavailable'}>}
export const unavailableTargetResumePort:TargetResumePort=Object.freeze({async prepare(){return {status:'unavailable' as const};}});
