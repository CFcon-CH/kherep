import {bindMessageAdmission} from './message-admission.mts';
import {fixtureEvidence,publishSynthetic} from './session-authority-fixture.mts';
import {busyPolicyFingerprint} from './codex-busy-policy.mts';
import {recordCodexSession,markStopEnded} from './codex-sessions.mts';
import {claimForkAttempt} from './codex-fork-attempts.mts';
import {readPolicy} from './policy.mts';
import type {ExecutionContext} from './target-delivery-operation.mts';
import path from "node:path";
import { buildMessageLaunch } from "./target-delivery-launch.mts";
import { queueProducerIdentity } from "./codex-queue-context.mts";
import { claimRouteContext as claimRoute } from "./target-delivery-route.mts";
import { storeMessage } from "./inbox.mts";
import { digest, type RouteProducer } from "./target-delivery-operation.mts";
import fs from "node:fs";
import type test from "node:test";

import { fakeAppServer, FORK_OWNER, type ForkScenario } from "./codex-fork-fixture.mts";
import { FORK_FEATURE_KEYS, runForkAttempt, type ForkRunInput } from "./codex-fork-process.mts";
import type { CodexDeps } from "./codex-process.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";
import type { InboxRecord } from "./inbox.mts";
import { withServiceAdmission } from "./service-drain.mts";
import { taskNode, testServiceOwner, T0 } from "./task-fixture.mts";

// Issue #408, PR 3: one runForkAttempt against the fake app-server, with short
// step timeouts and an active service admission of this test process.

export const PRODUCER: QueueProducerIdentity = { codexExecutable: "/synthetic/bin/codex", launchFile: "/synthetic/bin/codex", launchPrefix: [],
  approvedFiles: [{ path: "/synthetic/bin/codex", realpath: "/synthetic/bin/codex", sha256: "b".repeat(64) }],
  resolvedCodexHome: "/synthetic/codex-home", route: "local" };
export const MESSAGE = "40800001-0000-4000-8000-000000000001";
export const RECORD: InboxRecord = { messageId: MESSAGE, from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" },
  toSession: FORK_OWNER, text: "Is the build green?", inReplyTo: "40800000-0000-4000-8000-000000000009",
  createdAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), state: "accepted" };
export const FAST = { initializeMs: 200, requestMs: 200, forkMs: 200, turnMs: 300, interruptMs: 100, graceMs: 30 };

export async function runFork(t: test.TestContext, scenario: Partial<ForkScenario> = {}, extra: Partial<ForkRunInput> = {},
  codex: CodexDeps = {}, configure?:(value:{paths:ReturnType<typeof taskNode>['paths'];authority:ReturnType<typeof taskNode>['livenessAuthority'];context:ExecutionContext;app:ReturnType<typeof fakeAppServer>;setClock:(v:number)=>void})=>void) {
  const node = taskNode(t);
  const cwd = fs.realpathSync.native(node.workspace);
  let clock=T0;
  const rawPolicy=JSON.parse(fs.readFileSync(node.paths.policy,'utf8'));
  rawPolicy.wake={enabled:true,sessions:[FORK_OWNER],codexFork:{enabled:true,sessions:[FORK_OWNER]}};
  rawPolicy.sessions.runtimes=['codex'];fs.writeFileSync(node.paths.policy,JSON.stringify(rawPolicy));
  recordCodexSession(node.paths,FORK_OWNER,cwd,T0-600000,'default','Stop');markStopEnded(node.paths,FORK_OWNER);
  publishSynthetic(node.paths,[{...fixtureEvidence({runtime:'codex',sessionId:FORK_OWNER},'idle-loaded',T0),
    lifecycle:{status:'value',value:{state:'restored',generation:7},source:'native-lifecycle',observedAt:T0,complete:true,reasonCode:'observed'}}],T0,
    [{runtime:'codex',sessionId:FORK_OWNER,state:'idle-loaded'}],node.livenessAuthority);
  const policy=readPolicy(node.paths.policy,true)!;

  const app = fakeAppServer({ cwd, ...scenario });
  const running: string[][] = [], logs: string[] = [];
  let unconfirmed = 0;
  const {binding:_binding,...unbound}=RECORD;
  const record=storeMessage(node.paths.inbox,{...unbound,senderOrigin:{nodeId:RECORD.from.nodeId,sentAt:new Date(T0).toISOString()}},T0);
  const file=path.join(node.root,'synthetic-codex');fs.writeFileSync(file,'public synthetic command');
  const home=path.join(node.root,'synthetic-home');fs.mkdirSync(home);
  const launch=buildMessageLaunch({codex:{findCodex:()=>file,home,platform:'darwin'}},{runtime:'codex',file,args:['app-server','--listen','stdio://'],cwd,detached:true});
  const producer=queueProducerIdentity(file,['app-server','--listen','stdio://'],{codex:{home,platform:'darwin'}});
  const granted=claimRoute(node.paths,[record],{version:1,kind:"fork",producer:launch.producer,budgetOwner:FORK_OWNER,execution:{runtime:"codex",sessionId:FORK_OWNER,taskId:null}},
    {policyFingerprint:busyPolicyFingerprint(policy),lifecycleGeneration:7},T0,{perHour:1,perDay:1,spacingMs:0})!;
  const claim=claimForkAttempt(node.paths,{owner:FORK_OWNER,messageId:record.messageId,attemptedAt:T0,policyFingerprint:busyPolicyFingerprint(policy),producer:{...producer},targetAttempt:granted.kind==='message'?granted.handle:undefined})!;
  const context=bindMessageAdmission({...node.deps(),platform:'darwin',now:()=>clock,codex:{home,postToolHook:()=>true},workerCapabilities:()=>['messaging.proxy.v1']},
    granted.kind==='message'?{...granted,launch}:granted,{route:'fork-reply',grant:'fork',attemptId:claim.attemptId,permissionMode:'default'});
  configure?.({paths:node.paths,authority:node.livenessAuthority,context,app,setClock:v=>{clock=v;}});
  const invoke = () => withServiceAdmission(node.paths, (admission) => runForkAttempt({ codex: { spawn: app.spawn as never,
    killGroup: app.killGroup, platform: "darwin", onUnconfirmedShutdown: () => { unconfirmed++; }, ...codex } }, {
    context, paths:node.paths, owner: FORK_OWNER, cwd, producer, features: new Set(FORK_FEATURE_KEYS), mcpNames: ["synthetic_probe"], record,
    maxAnswerBytes: 4096, admission, continueAllowed:()=>true, stillAccepted: () => true,
    log: (line) => { logs.push(line); }, timeouts: FAST, ...extra, running:(lastTurnId,forkId,proof)=>{running.push([lastTurnId,forkId,proof]);extra.running?.(lastTurnId,forkId,proof);} }), testServiceOwner);
  const outcome=await invoke();
  const run = app.runs[0]!;
  const methods = (): string[] => run.requests.filter((r) => r.method).map((r) => r.method!);
  return { outcome, app, run, methods, running, logs, unconfirmed: () => unconfirmed, paths: node.paths, cwd,home,producer,replay:invoke };
}
