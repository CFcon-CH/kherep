import fs from 'node:fs';
import path from 'node:path';
import type test from 'node:test';
import { closedNode, closedSince, SESSION } from './closed-fixture.mts';
import { fakeCodexBin } from './codex-fixture.mts';
import { rememberMode } from './autonomy.mts';
import { loadPolicy } from './policy.mts';
import { buildMessageLaunch } from './target-delivery-launch.mts';
import type { ExecutionContext } from './target-delivery-operation.mts';

export function strictCodexNode(t: test.TestContext) {
  const node = closedNode(t, { runtimes: ['codex', 'claude'] }, { resumeTarget: true });
  const raw = JSON.parse(fs.readFileSync(node.paths.policy, 'utf8'));
  raw.wake = { enabled: true, sessions: ['*'], nativeQueue: true };
  fs.writeFileSync(node.paths.policy, JSON.stringify(raw));
  fs.writeFileSync(path.join(node.paths.dir, 'known-sessions.json'), JSON.stringify({ sessions: [] }));
  closedSince(node, { sessionId: SESSION, runtime: 'codex', state: 'idle', cwd: path.join(node.workspace, 'repo') });
  rememberMode(node.paths, SESSION, 'auto');
  const fake = fakeCodexBin(t);
  const queues: { context: ExecutionContext; input: import('./codex-queue-binding.mts').QueueBinding['expectedInput'] }[] = [];
  const deps = () => ({ ...node.deps(), policy: loadPolicy(node.paths.policy), codex: { home: node.root, findCodex: () => fake.file } });
  const port = {
    async prepare() {
      const current = deps(), cwd = fs.realpathSync.native(path.join(node.workspace, 'repo'));
      return { status: 'prepared' as const,
        queueLaunch: buildMessageLaunch(current, { runtime: 'codex', args: ['app-server', '--listen', 'stdio://'], cwd }),
        resumeLaunch: buildMessageLaunch(current, { runtime: 'codex', args: ['exec', 'resume', SESSION, '-'], cwd }),
        async queue(context: ExecutionContext, input: import('./codex-queue-binding.mts').QueueBinding['expectedInput'], beforeEffect: () => void) {
          beforeEffect(); queues.push({ context, input });
          return { status: 'submitted' as const, queueId: 'aaaa0000-0000-4000-8000-000000000001', submittedAt: node.deps().now!() };
        },
      };
    },
  };
  return { ...node, queues, port, deps: () => ({ ...deps(), targetResumePort: port }) };
}

// Same-process source adapter only; never a qualified native runtime.
export function successorNode(t:test.TestContext,runtime:'codex'|'claude-code'='codex',platform:NodeJS.Platform=process.platform) {
 const node=strictCodexNode(t),prepare=node.port.prepare.bind(node.port);
 if(runtime==='claude-code'){fs.writeFileSync(path.join(node.paths.dir,'known-sessions.json'),JSON.stringify({sessions:[]}));closedSince(node,{sessionId:SESSION,runtime,state:'idle',cwd:path.join(node.workspace,'repo')});}
 const control={held:false,active:true,completed:false,effects:0,inputs:[] as string[],result:undefined as import('./target-resume-port.mts').OriginalResumeObservation|undefined,context:undefined as import('./target-resume-port.mts').OriginalMessageContext|undefined,beforeInput:undefined as (()=>Promise<void>)|undefined};
 const port:import('./target-resume-port.mts').TargetResumePort={async prepare(target){const p=await prepare();const resumeLaunch=buildMessageLaunch({...node.deps(),platform,codex:{...node.deps().codex,platform}},{file:p.resumeLaunch.binding.executable,runtime,cwd:target.cwd,detached:true,args:runtime==='codex'?['exec','resume',SESSION,'-']:['--resume',SESSION,'--bg','-']});return {...p,resumeLaunch,
  async withRetiredPointerFence(expected,consume){if(control.held)return {status:'unknown'};control.held=true;try{return await consume({epoch:'aaaa0000-0000-4000-8000-000000000002',assertActive(){if(!control.held||!control.active)throw Error('synthetic lease lost');}});}finally{control.held=false;}},
  async resume(context,input,guards){guards.beforeOuterSpawn();control.effects++;if(control.beforeInput)await control.beforeInput();guards.beforePromptRelease();if(platform==='win32'){guards.beforeInnerSpawn();guards.beforeInnerInput();}control.inputs.push(input);control.context=context;
   const result={status:'observed' as const,runtime,sessionId:SESSION,cwd:context.launch!.binding.cwd,permissionMode:'auto',turnId:'original-turn',providerEpoch:'aaaa0000-0000-4000-8000-000000000002',background:true as const,originalChat:true as const,pid:123,pidStart:null};control.result=result;return result;},
  withCompletedOriginalTurnFence(expected,consume){return control.completed?consume(structuredClone(expected)):{status:'unavailable'};}
 };}};return {...node,control,deps:()=>({...node.deps(),targetResumePort:port})};
}
