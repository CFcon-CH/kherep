import {canonical} from './target-delivery-state.mts';
import type {RunnerDeps} from './session-runner.mts';
import type {OriginalMessageContext,OriginalTarget,PreparedOriginalPort,OriginalResumeObservation} from './target-resume-port.mts';
export interface PendingOriginalResume {context:OriginalMessageContext;target:Readonly<OriginalTarget>;prepared:PreparedOriginalPort;submittedAt:number|null;dueAt:number|null;successor?:OriginalMessageContext;result?:OriginalResumeObservation;candidate?:OriginalResumeObservation;attempted:boolean;epoch?:string;flight?:Promise<import('./target-resume.mts').TargetResumeResult>}
export const pendingOriginalResumes=new Map<string,PendingOriginalResume>();
export const originalResumeKey=(deps:RunnerDeps,id:string):string=>canonical([deps.paths.dir,id]);
const selections=new Map<string,Promise<import('./target-resume.mts').TargetResumeResult>>();
export async function coalesceOriginalSelection(deps:RunnerDeps,id:string,body:()=>Promise<import('./target-resume.mts').TargetResumeResult>):Promise<import('./target-resume.mts').TargetResumeResult>{
 const key=originalResumeKey(deps,id),old=selections.get(key);if(old)return old;
 const flight=Promise.resolve().then(body);selections.set(key,flight);try{return await flight;}finally{if(selections.get(key)===flight)selections.delete(key);}
}
export function retireOriginalCache(deps:RunnerDeps,id:string,state:PendingOriginalResume):void {const key=originalResumeKey(deps,id);if(pendingOriginalResumes.get(key)!==state)throw Error('cache identity changed');pendingOriginalResumes.delete(key);}
