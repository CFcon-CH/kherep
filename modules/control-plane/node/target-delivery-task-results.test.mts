import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {codexNode,THREAD,waitFor} from './codex-fixture.mts';
import {startTask} from './session-runner.mts';
import {startArgs,T0,TASK} from './task-fixture.mts';
import {codexFiles} from './codex-process.mts';
import {readExit} from './codex-output.mts';
import {pollCodexInbound} from './codex-wake.mts';
import {watchTasks} from './task-watch.mts';
import {fixtureEvidence,publishSynthetic} from './session-authority-fixture.mts';
import {getMessage,storeMessage} from './inbox.mts';
import {offerMcpInbox,answerMcpInbox} from './mcp-local.mts';
import {targetId} from './target-delivery-fixture.mts';
import {withRoute,routeMembersCurrent} from './target-delivery-route.mts';
import {closedNode,deliver,PEER} from './closed-fixture.mts';
import {deliverToClosed} from './closed-delivery.mts';
import {writeTask,readTask} from './task-records.mts';

test('actual Codex failed-turn watch preserves a journaled reply and retries only its still-offered group member',async t=>{
  const n=codexNode(t,{}, {}, {wake:{enabled:true,sessions:[THREAD]}});
  await startTask(startArgs(TASK,{runtime:'codex'}),n.deps());
  await waitFor(()=>readExit(codexFiles(n.paths,TASK))!==null,'initial owned run');await watchTasks(n.deps());
  const common={status:'value' as const,value:{state:'restored' as const,generation:7},source:'native-lifecycle' as const,observedAt:T0,complete:true,reasonCode:'observed' as const};
  publishSynthetic(n.paths,[{...fixtureEvidence({runtime:'codex',sessionId:THREAD},'idle-loaded',T0),lifecycle:common}],T0,[{runtime:'codex',sessionId:THREAD,state:'idle-loaded'}],n.livenessAuthority);
  const ids=[targetId(1301),targetId(1302)];
  for(const id of ids)storeMessage(n.paths.inbox,{messageId:id,from:PEER,toSession:THREAD,text:'public failure fixture [fail]',createdAt:new Date(T0).toISOString(),senderOrigin:{nodeId:PEER.nodeId,sentAt:new Date(T0).toISOString()}},T0);
  await pollCodexInbound(n.deps());await waitFor(()=>n.runs().length===2&&readExit(codexFiles(n.paths,TASK))!==null,'failed owned message run');
  answerMcpInbox(n.paths,[ids[0]]);await watchTasks(n.deps());
  assert.equal(getMessage(n.paths.inbox,ids[0])!.state,'delivered');assert.equal(getMessage(n.paths.inbox,ids[0])!.retry,undefined);
  assert.equal(getMessage(n.paths.inbox,ids[1])!.state,'offered');assert.equal(getMessage(n.paths.inbox,ids[1])!.retry,true);
  withRoute(n.paths,getMessage(n.paths.inbox,ids[0])!.targetAttempt!,s=>assert.equal(routeMembersCurrent(n.paths,s),true));
});

test('actual Claude failed-progress watch refuses only waiting task-owned rows and preserves a prior reply',async t=>{
  const n=closedNode(t),session=targetId(1310);
  writeTask(n.paths,{taskId:TASK,name:'task-3f2a1b0c',shortId:'test0001',runtime:'claude',sessionId:session,local:'intercom',
    requestedBy:`${PEER.nodeId}/${PEER.session}`,cwd:n.workspace,permissionMode:'default',state:'running',startedAt:new Date(T0).toISOString(),
    updatedAt:new Date(T0).toISOString(),deadline:new Date(T0+60000).toISOString()},T0);
  const ids=[deliver(n),deliver(n)];await deliverToClosed(n.deps());offerMcpInbox(n.paths,ids,T0);answerMcpInbox(n.paths,[ids[0]]);
  writeTask(n.paths,{...readTask(n.paths,TASK)!,awaitingProgressSince:new Date(T0).toISOString()},T0);
  n.rows.push({id:'test0001',sessionId:session,state:'failed',kind:'background'});await watchTasks(n.deps());
  assert.equal(getMessage(n.paths.inbox,ids[0])!.state,'delivered');assert.equal(getMessage(n.paths.inbox,ids[1])!.state,'refused');
  withRoute(n.paths,getMessage(n.paths.inbox,ids[0])!.targetAttempt!,s=>{assert.equal(routeMembersCurrent(n.paths,s),true);assert.equal(s.budget,null);});
});
