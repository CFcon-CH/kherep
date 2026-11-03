import path from 'node:path';
import { codexCommand, findCodex } from './codex-binary.mts';
import { findClaude, claudeCall } from './sessions.mts';
import { queueProducerIdentity } from './codex-queue-context.mts';
import { intercomMcpOverrides } from './codex-mcp.mts';
import { producerFile } from './target-delivery-producer.mts';
import { digest, parseRouteProducer, type RouteProducer, type ExecutionContext, type RouteReservation } from './target-delivery-operation.mts';
import { canonical } from './target-delivery-state.mts';
import { checkExecution } from './target-delivery-route.mts';
import type { RunnerDeps } from './session-runner.mts';
import type { NodePaths } from './config.mts';

export interface LaunchBinding {
  version:1; runtime:'codex'|'claude-code'; executable:string; platform:NodeJS.Platform;
  inner:{file:string;argsFingerprint:string}; outer:{file:string;argsFingerprint:string};
  cwd:string; detached:boolean; windowsVerbatimArguments:boolean; home:string|null;
}
export interface PreparedMessageLaunch {
  rawArgs:string[]; binding:LaunchBinding; inner:{file:string;args:string[]}; outer:{file:string;args:string[]}; producer:RouteProducer;
}
export interface LaunchRequest {
  runtime:'codex'|'claude-code'; args:string[]; cwd:string; file?:string; detached?:boolean; intercom?:boolean;
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;
}
export function buildMessageLaunch(deps:Pick<RunnerDeps,'codex'|'findClaude'|'platform'|'comSpec'>,request:LaunchRequest):PreparedMessageLaunch {
  const runtime=request.runtime,platform=runtime==='codex'?(deps.codex?.platform??process.platform):(deps.platform??process.platform);
  const executable=request.file??(runtime==='codex'?(deps.codex?.findCodex??findCodex)():(deps.findClaude??findClaude)());
  if(!executable||!path.isAbsolute(executable)||!path.isAbsolute(request.cwd))throw Error('launch producer unknown');
  const detached=request.detached??(runtime==='codex'&&!(platform==='win32'&&request.intercom));
  let inner:{file:string;args:string[]},home:string|null=null,files:RouteProducer['files'],prefix:string[],windowsVerbatimArguments=false;
  if(runtime==='codex') {
    const p=queueProducerIdentity(executable,request.args,deps);
    if(p.route!=='local')throw Error('launch route unknown');
    inner=codexCommand(executable,request.args,platform);home=p.resolvedCodexHome;files=p.approvedFiles;prefix=p.launchPrefix;
  }else{
    const p=claudeCall(executable,request.args,60000,platform,deps.comSpec);inner={file:p.file,args:p.args};
    prefix=p.args.slice(0,p.args.length-request.args.length);windowsVerbatimArguments=p.options.windowsVerbatimArguments===true;
    files=[...new Set([executable,p.file,...prefix.filter(x=>path.isAbsolute(x))])].map(producerFile);
  }
  const wrapper=path.join(import.meta.dirname,'codex-windowless.mts');
  const outer=runtime==='codex'&&platform==='win32'&&detached?{file:process.execPath,args:[wrapper,inner.file,...inner.args]}:inner;
  if(outer!==inner)for(const file of [process.execPath,wrapper])if(!files.some(f=>f.path===file))files.push(producerFile(file));
  const binding:LaunchBinding={version:1,runtime,executable:path.resolve(executable),platform,inner:{file:inner.file,argsFingerprint:digest(inner.args)},
    outer:{file:outer.file,argsFingerprint:digest(outer.args)},cwd:request.cwd,detached,windowsVerbatimArguments,home};
  const producer=parseRouteProducer({version:2,kind:'command',runtime,launchFile:inner.file,launchPrefix:prefix,files,home,route:'local',argsFingerprint:digest(request.args),consumer:null,launch:binding});
  return freeze({rawArgs:[...request.args],binding,inner:{file:inner.file,args:[...inner.args]},outer:{file:outer.file,args:[...outer.args]},producer});
}
export async function prepareMessageLaunch(deps:Pick<RunnerDeps,'codex'|'findClaude'|'platform'|'comSpec'>,request:LaunchRequest):Promise<PreparedMessageLaunch> {
  const file=request.file??(request.runtime==='codex'?(deps.codex?.findCodex??findCodex)():(deps.findClaude??findClaude)());
  if(!file)throw Error('launch producer unknown');
  let args=request.args;
  if(request.runtime==='codex'&&request.intercom) {
    const result=await intercomMcpOverrides({...deps.codex,findCodex:()=>file});
    if('reason' in result)throw Error('MCP producer facts unknown');
    args=[...result.args,...args];
  }
  return buildMessageLaunch(deps,{...request,file,args});
}
export interface ExecutionExpectation {runtime:'codex'|'claude-code';taskId?:string|null;sessionId?:string|null;phase?:'ready'|'executing'|'settled'|'uncertain';}
export function verifyPreparedLaunch(paths:NodePaths,context:ExecutionContext,launch:PreparedMessageLaunch,kinds:string[],expected:ExecutionExpectation):void {
  if(context.kind!=='message')throw Error('message launch context missing');
  const saved=checkExecution(paths,context,kinds,undefined,expected)!;
  verifyPreparedLaunchAgainstReservation(saved,launch);
}
export function verifyPreparedLaunchAgainstReservation(saved:RouteReservation,launch:PreparedMessageLaunch):void {
  const p=(saved.consumer??saved.group.operation).producer;
  if(!p||p.version!==2||canonical(p)!==canonical(launch.producer)||canonical(p.launch)!==canonical(launch.binding)
    ||digest(launch.rawArgs)!==p.argsFingerprint||launch.binding.inner.file!==launch.inner.file||launch.binding.inner.argsFingerprint!==digest(launch.inner.args)
    ||launch.binding.outer.file!==launch.outer.file||launch.binding.outer.argsFingerprint!==digest(launch.outer.args)
    ||p.files.some(f=>canonical(producerFile(f.path))!==canonical(f)))throw Error('prepared launch binding differs');
}
