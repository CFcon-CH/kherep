import {requireMessageEffect} from './message-admission.mts';
import type { NodePaths } from './config.mts';
import type { ExecutionContext } from './target-delivery-operation.mts';
import { digest } from './target-delivery-operation.mts';
import { canonical, keys, object } from './target-delivery-state.mts';
import { producerFile } from './target-delivery-producer.mts';
import { beginRouteInnerEffect, checkExecution } from './target-delivery-route.mts';

// No production cross-process Authority source is available yet. Injection is
// a seam for a future supported host binding, never a serialized grant.
export interface CurrentWindowAuthority {contextFor(handle:import('./target-delivery-reservation.mts').TargetHandle):ExecutionContext|undefined}
export const MAX_WINDOW_CONTROL=64*1024;
export function windowControl(context:ExecutionContext,paths:NodePaths|undefined,file:string,args:string[],wrapper:string,node=process.execPath):string {
  const local=context.kind==='message'?{kind:'message',handle:context.handle}:context;
  const envelope={version:2,context:local,paths:context.kind==='message'?paths:null,file,argsFingerprint:digest(args),outer:[producerFile(node),producerFile(wrapper)]};
  const line=JSON.stringify(envelope);if(Buffer.byteLength(line)>MAX_WINDOW_CONTROL)throw Error('window control exceeds bound');return line+'\n';
}
export function verifyWindowMessage(paths:NodePaths,context:ExecutionContext,file:string,args:string[],wrapper:string,node=process.execPath,input=false,env:NodeJS.ProcessEnv=process.env):void {
  const s=checkExecution(paths,context,['exec-resume','task-start'],undefined,{runtime:'codex'}),p=(s!.consumer??s!.group.operation).producer,l=p?.launch;
  if(!s||!(input?['executing','settled'].includes(s.phase)&&s.innerStarted:s.phase==='executing'&&!s.innerStarted)||p?.version!==2||!l||l.platform!=='win32'||!l.detached||l.inner.file!==file||l.inner.argsFingerprint!==digest(args)
    ||l.outer.file!==node||l.outer.argsFingerprint!==digest([wrapper,file,...args])||l.cwd!==process.cwd()
    ||[producerFile(node),producerFile(wrapper)].some(f=>!p.files.some(bound=>canonical(f)===canonical(bound)))
    ||!l.home||env.CODEX_HOME!==l.home
    ||p.files.some(f=>canonical(producerFile(f.path))!==canonical(f)))throw Error('window operation producer or home differs');
}
export function admitWindowControl(line:string,file:string,args:string[],wrapper:string,node=process.execPath,env:NodeJS.ProcessEnv=process.env,authority?:CurrentWindowAuthority):{context:ExecutionContext;paths?:NodePaths} {
  if(Buffer.byteLength(line)>MAX_WINDOW_CONTROL)throw Error('window control exceeds bound');
  const x:unknown=JSON.parse(line);
  if(!object(x)||!keys(x,['version','context','paths','file','argsFingerprint','outer'])||x.version!==2||x.file!==file||x.argsFingerprint!==digest(args)
    ||canonical(x.outer)!==canonical([producerFile(node),producerFile(wrapper)])||!object(x.context))throw Error('window control binding differs');
  const context=x.context as unknown as ExecutionContext;
  if(context.kind==='operator') {if(!keys(context,['kind'])||x.paths!==null)throw Error('operator window context differs');return {context};}
  if(context.kind!=='message'||!keys(context,['kind','handle'])||!object(x.paths))throw Error('window execution context missing');
  const paths=x.paths as unknown as NodePaths;
  verifyWindowMessage(paths,context,file,args,wrapper,node,false,env);
  const current=authority?.contextFor(context.handle);
  if(current?.kind!=='message'||canonical(current.handle)!==canonical(context.handle))throw Error('current window authority unavailable');
  beginRouteInnerEffect(paths,current);requireMessageEffect({paths},current,'inner-spawn');return {context:current,paths};
}
