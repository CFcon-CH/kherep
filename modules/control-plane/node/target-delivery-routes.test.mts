import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { nativeQueueNode } from './codex-queue-producer-fixture.mts';
import { scheduleNativeQueue, nativeQueueIdle } from './codex-queue-producer.mts';
import { deliverForCodex } from './deliver-codex.mts';
import { deliverForHook } from './deliver-hook.mts';
import { pollCodexInbound } from './codex-wake.mts';
import { claimRouteContext as claimRoute, checkExecution } from './target-delivery-route.mts';
import { commandProducer } from './target-delivery-producer.mts';
import { parseRouteReservation, type RouteProducer, type OperationKind } from './target-delivery-operation.mts';
import { targetFixture, TARGET_OWNER, TARGET_T, TARGET_LIMITS, targetId } from './target-delivery-fixture.mts';
import { getMessage, storeMessage, writeJsonAtomic } from './inbox.mts';
import { livenessFile } from './session-lifecycle.mts';
import {syntheticHookFacts} from './target-delivery-test-support.mts';
import { writeTask } from './task-records.mts';

const hook=(runtime:'codex'|'claude-code',file:string):RouteProducer=>({version:1,kind:'hook',runtime,launchFile:file,launchPrefix:[],files:[{path:file,realpath:file,sha256:'a'.repeat(64)}],home:null,route:'local',argsFingerprint:'b'.repeat(64),consumer:{source:'native-hook',identity:'c'.repeat(64),epoch:targetId(991)}});
function lifecycle(paths:ReturnType<typeof targetFixture>['paths'],runtime='codex') {
  writeJsonAtomic(livenessFile(paths),{version:1,generation:91,sessions:[{runtime,sessionId:TARGET_OWNER,state:'running',observedAt:TARGET_T,reasonCode:'observed',lifecycleGeneration:7}],tombstones:[]});
}
function command(t:test.TestContext) {
  const f=targetFixture(t);const file=path.join(f.root,'synthetic-command');fs.writeFileSync(file,'public');
  const producer=commandProducer({codex:{findCodex:()=>file,home:f.root}},'codex',['exec'])!;
  return {...f,producer};
}
const operation=(kind:OperationKind,producer:RouteProducer,sessionId=TARGET_OWNER)=>({version:1 as const,kind,producer:kind==='hook-continue'?{...producer,kind:'hook' as const,consumer:{source:'native-hook' as const,identity:'c'.repeat(64),epoch:targetId(991)}}:producer,budgetOwner:TARGET_OWNER,execution:{runtime:'codex' as const,sessionId,taskId:kind==='task-start'?targetId(900):null}});

test('different message groups of every consuming operation share the actual owner namespace and one debit', async t=>{
  for(const kind of ['queue','exec-resume','task-start','fork','hook-continue'] as const)await t.test(kind,sub=>{
    const f=command(sub);const facts={policyFingerprint:'d'.repeat(64),lifecycleGeneration:7,originalId:TARGET_OWNER};
    const first=claimRoute(f.paths,[f.rows[0]],operation('queue',f.producer),facts,TARGET_T,TARGET_LIMITS);
    assert.ok(first);
    assert.equal(claimRoute(f.paths,[f.rows[1]],operation(kind,f.producer),facts,TARGET_T,TARGET_LIMITS),null);
    const budget=JSON.parse(fs.readFileSync(f.budget,'utf8'));assert.equal(budget.turns.length,1);assert.equal(budget.groupDebits.length,1);
  });
});

test('actual scheduler persists the shared queue attempt before injected spawn and blocks both Stop producers',async t=>{
  const n=nativeQueueNode(t);const id=n.add();let effects=0;
  const deps=n.deps();deps.codex!.spawn=(()=>{
    effects++;
    const raw=JSON.parse(fs.readFileSync(path.join(n.paths.dir,'codex-native-pending',`${n.owner}.json`),'utf8'));
    const s=parseRouteReservation(raw);assert.equal(s.phase,'executing');assert.ok(s.budget);
    const child=Object.assign(new EventEmitter(),{pid:4242,stdout:new PassThrough(),stderr:new PassThrough()});
    queueMicrotask(()=>{child.stdout.write(`Queued message ${targetId(990)} for thread ${n.owner}.\n`);child.emit('exit',0,null);child.emit('close',0,null);});
    return child;
  }) as never;
  const logs:string[]=[];
  scheduleNativeQueue(deps,n.owner,[id],undefined,x=>logs.push(x));await nativeQueueIdle();
  const ownerFile=path.join(n.paths.dir,'codex-native-pending',`${n.owner}.json`);
  assert.equal(effects,1,JSON.stringify({logs,phase:fs.existsSync(ownerFile)?JSON.parse(fs.readFileSync(ownerFile,'utf8')).phase:'absent'}));
  n.add('different message');
  const live=JSON.parse(fs.readFileSync(livenessFile(n.paths),'utf8'));
  live.sessions.push({runtime:'claude-code',sessionId:n.owner,state:'running',observedAt:deps.now!(),reasonCode:'observed',lifecycleGeneration:7});writeJsonAtomic(livenessFile(n.paths),live);
  for(const runtime of ['codex','claude-code'] as const) {
    const input={hook_event_name:'Stop',session_id:n.owner,permission_mode:'default'};
    const h={paths:n.paths,now:deps.now,messageProducer:hook(runtime,n.fake.file)};
    assert.equal(runtime==='codex'?deliverForCodex(input,h):deliverForHook(input,h),'');
  }
});

test('actual Codex Stop claims before block output and loses to a different-message owner',t=>{
  const f=targetFixture(t);lifecycle(f.paths);
  fs.writeFileSync(f.paths.policy,JSON.stringify({version:1,allowedCommands:[],wake:{enabled:true,sessions:[TARGET_OWNER]}}));
  const output=deliverForCodex({hook_event_name:'Stop',session_id:TARGET_OWNER,permission_mode:'default'},
    {paths:f.paths,now:()=>TARGET_T,...syntheticHookFacts(f.paths,TARGET_OWNER,'codex',TARGET_T)});
  assert.equal(JSON.parse(output).decision,'block');
  const s=parseRouteReservation(JSON.parse(fs.readFileSync(f.reservation,'utf8')));assert.equal(s.outcome?.kind,'hook');assert.equal(s.group.binding.members.length,2);
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
});

test('missing current Authority denies actual Codex Stop with generated producer/lifecycle and no debit',t=>{
  const f=targetFixture(t);fs.writeFileSync(f.paths.policy,JSON.stringify({version:1,allowedCommands:[],wake:{enabled:true,sessions:[TARGET_OWNER]}}));
  const facts=syntheticHookFacts(f.paths,TARGET_OWNER,'codex',TARGET_T);
  assert.equal(deliverForCodex({hook_event_name:'Stop',session_id:TARGET_OWNER,permission_mode:'default'},
    {paths:f.paths,now:()=>TARGET_T,messageProducer:facts.messageProducer}),'');
  assert.equal(fs.existsSync(f.budget),false);
});

test('missing lifecycle denies actual Codex Stop without debit even with a complete producer',t=>{
  const f=targetFixture(t);fs.writeFileSync(f.paths.policy,JSON.stringify({version:1,allowedCommands:[]}));
  assert.equal(deliverForCodex({hook_event_name:'Stop',session_id:TARGET_OWNER,permission_mode:'default'},
    {paths:f.paths,now:()=>TARGET_T,messageProducer:hook('codex',path.join(f.root,'hook'))}), '');
  assert.equal(fs.existsSync(f.budget),false);
});
