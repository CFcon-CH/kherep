import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import { digestMcpArguments, type McpIntentRegistration } from "../protocol-mcp.mts";
import { BINDING_TTL_MS, isMessageBinding, isResolveRequest, stableBinding, type DeliveryBinding, type MessageBinding, type ResolveRequest } from "../protocol-message-binding.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { messageOwnerMatches } from "./message-owner.mts";
import { MessageReferenceResolver } from "./message-reference.mts";
import { pollMcpIntents, readMcpInbox, recordMcpIntentReceipt } from "./mcp-local.mts";
import { DEFAULT_POLICY } from "./policy.mts";
import { runMsg } from "./msg-cli.mts";
import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { admitForkReply, recheckForkReply, relayMessageEligible } from "./codex-fork-admission.mts";
import { FORK_OWNER } from "./codex-fork-fixture.mts";
import { relayNode } from "./codex-fork-relay-fixture.mts";
import { publishSynthetic } from "./session-authority-fixture.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { scheduleNativeQueue, nativeQueueIdle } from "./codex-queue-producer.mts";
import { nativeQueueNode } from "./codex-queue-producer-fixture.mts";
import { closedNode, deliver, SESSION } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { T0 } from "./task-fixture.mts";
import { readPolicy } from "./policy.mts";

// Node 24.1 may emit exactly this warning/hint pair for .mts. Do not mask
// another warning, diagnostics, duplicate warnings or peer content.
const HOOK_STDERR = /^(?:\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/;
const A = "a1111111-1111-4111-8111-111111111111";
const B = "b1111111-1111-4111-8111-111111111111";
const NODE_A = "a2222222-2222-4222-8222-222222222222";
const NODE_B = "b2222222-2222-4222-8222-222222222222";
function temporary(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-slot-node-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, {recursive: true});
  fs.writeFileSync(paths.policy, JSON.stringify({...DEFAULT_POLICY, remoteMcp:{enabled:true}}));
  return paths;
}
function binding(id: string, owner = A, now = Date.now()): MessageBinding {
  return {version:1, mode:"slot-exact", from:{sessionId:B,runtime:"codex",lifecycleGeneration:null},
    to:{sessionId:owner,runtime:"codex",lifecycleGeneration:null}, slot:{fromNode:NODE_B,toNode:NODE_A,
      fromSlot:"codex-mac",toSlot:"kherep-lead",fromRevision:1,toRevision:2,operationId:id,argumentsDigest:"a".repeat(43),issuedAt:now}};
}
function protectedRecord(paths: NodePaths, owner = A, now = Date.now()): string {
  const id = crypto.randomUUID();
  storeMessage(paths.inbox,{messageId:id,from:{nodeId:NODE_B,session:B},toSession:owner,text:"Synthetic protected content",
    createdAt:new Date(now).toISOString(),binding:{...binding(id,owner,now),leaseId:crypto.randomUUID(),localGeneration:null}},now);
  return id;
}

test("slot binding survives durable storage and generic readers cannot offer its content", t => {
  const paths=temporary(t), id=protectedRecord(paths);
  const record=getMessage(paths.inbox,id)!;
  assert.equal(record.binding?.mode,"slot-exact");
  assert.deepEqual(record.binding,binding(id,A,record.binding!.slot!.issuedAt));
  assert.equal(messageOwnerMatches(record,{sessionId:A,runtime:"codex"},[A]),false);
  assert.deepEqual(readMcpInbox(paths,A,10),[]);
  assert.equal(readMcpInbox(paths,A,10,undefined,"codex",true)[0]?.reference,`intercom-${record.binding!.slot!.issuedAt}-${id}`);
  assert.deepEqual(readMcpInbox(paths,B,10,undefined,"codex",true),[]);
  assert.equal(isMessageBinding({...record.binding,slot:undefined}),false);
  assert.equal(isMessageBinding({...record.binding,from:{...record.binding!.from,sessionId:"alias"}}),false);
});

test("literal storage leases need no population lookup, bind the complete route and expire once", t => {
  const paths=temporary(t), id=crypto.randomUUID();let now=1000;
  const resolver=new MessageReferenceResolver(paths,()=>now), route=binding(id,A,now);
  const request:ResolveRequest={version:1,requestId:crypto.randomUUID(),messageId:id,purpose:"slot-storage",binding:route,
    selections:[{role:"to",ref:A,expected:{sessionId:A,runtime:"codex"}}],expiresAt:now+BINDING_TTL_MS};
  assert.equal(isResolveRequest(request),true);
  const answer=resolver.resolve(request,"synthetic policy").results[0];
  assert.equal(answer.code,"BOUND");if(answer.code !== "BOUND") return;
  const delivery:DeliveryBinding={...route,leaseId:answer.leaseId,localGeneration:null};
  assert.deepEqual(stableBinding(delivery),route);
  assert.equal(resolver.validate(id,delivery,"synthetic policy"),true);
  assert.equal(resolver.validate(id,delivery,"synthetic policy"),false);
  const second=resolver.resolve({...request,requestId:crypto.randomUUID()},"synthetic policy").results[0];
  assert.equal(second.code,"BOUND");if(second.code !== "BOUND")return;
  now=request.expiresAt;
  assert.equal(resolver.validate(id,{...delivery,leaseId:second.leaseId},"synthetic policy"),false);
  assert.equal(isResolveRequest({...request,binding:undefined}),false);
});

test("actual Hook subprocess registers one qualified outer invocation and first own-read on UNKNOWN", async t => {
  const paths=temporary(t), inflight=new Set<string>(), registrations:McpIntentRegistration[]=[];
  const policy={...DEFAULT_POLICY,remoteMcp:{enabled:true as const}};
  protectedRecord(paths);
  const client=new NodeClient({nodeId:NODE_A,identity:generateIdentity(),policy,
    handlers:{"node.status":async()=>({}),"runtime.list":async()=>[],"session.list":async()=>[]},
    facts:()=>({hostname:"synthetic.example.invalid",os:"darwin",arch:"arm64",cpus:1,memoryBytes:1}),runtimes:async()=>[],
    sessions:async()=>[{sessionId:A,runtime:"codex",state:"unknown"}],storeMessage:()=>{},mcpCredentialPresent:()=>true,
    assignmentIdentity:async sessionId=>sessionId===A?{sessionId,chatName:"Synthetic original",platform:"darwin",originalMain:true}:null,
    mcpIntentReceipt:body=>recordMcpIntentReceipt(paths,inflight,body),
    readMcpInbox:(sessionId,limit,id,runtime,original)=>readMcpInbox(paths,sessionId,limit,id,runtime,original)});
  await client.onFrame(JSON.stringify(makeEnvelope("event",{name:"auth.ok"},0,0)));
  const input={hook_event_name:"PreToolUse",session_id:A,turn_id:"synthetic-turn",tool_use_id:"synthetic-call",
    transcript_path:`/synthetic/rollout-2026-11-08T12-00-00-${A}.jsonl`,tool_name:"mcp__kherep_messaging__inbox",tool_input:{}};
  const hook=fileURLToPath(new URL("./mcp-intent-hook.mts",import.meta.url));
  const child=spawn(process.execPath,[hook,"--config-root",path.dirname(paths.dir)],{stdio:["pipe","pipe","pipe"],env:{...process.env}});
  t.after(()=>child.kill());let stdout="",stderr="";
  child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
  const ended=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  child.stdin.end(JSON.stringify(input));
  let lane=Promise.resolve();
  const timer=setInterval(()=>{lane=lane.then(()=>pollMcpIntents(client,paths,inflight,frame=>{
    const parsed=parseEnvelope(frame);assert.equal(parsed.ok,true);if(!parsed.ok)return false;
    if(parsed.envelope.type === "mcp.intent.register") {
      const intent=parsed.envelope.body as McpIntentRegistration;registrations.push(intent);
      queueMicrotask(()=>{void client.onFrame(JSON.stringify(makeEnvelope("mcp.intent.receipt",{requestId:intent.requestId,ok:true,version:1,expiresAt:Date.now()+60_000},0,0)));});
    }
    return true;
  }));},10);
  try {assert.equal(await ended,0);} finally {clearInterval(timer);await lane;}
  assert.match(stderr,HOOK_STDERR);
  const warning="(node:123) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n";
  assert.ok(HOOK_STDERR.test(warning));
  for (const unsafe of [warning+warning,"unknown warning\n",warning+"SYNTHETIC_RAW_SENTINEL", "SYNTHETIC_RAW_SENTINEL"+warning]) assert.ok(!HOOK_STDERR.test(unsafe));
  const output=JSON.parse(stdout);assert.ok(output.hookSpecificOutput.updatedInput.requestId);
  assert.equal(registrations.length,1);const intent=registrations[0];
  assert.deepEqual(intent.originalRoot,{version:1,threadId:A,turnId:"synthetic-turn",verified:true});
  assert.equal(intent.argumentsDigest,await digestMcpArguments({}));
  const request={requestId:crypto.randomUUID(),sessionId:A,runtime:"codex",limit:10,
    original:{requestId:intent.requestId,callId:intent.callId,argumentsDigest:intent.argumentsDigest,credentialVersion:1}};
  const frames=await client.onFrame(JSON.stringify(makeEnvelope("mcp.inbox.request",request,0,0)));
  assert.ok(frames[0].includes("Synthetic protected content"));
  assert.ok(!(await client.onFrame(JSON.stringify(makeEnvelope("mcp.inbox.request",{...request,requestId:crypto.randomUUID()},0,0))))[0].includes("Synthetic protected content"));
  client.connectionClosed();
  assert.deepEqual(await client.registerMcpOriginal(intent),[]);
});

test("actual parsed CLI refuses protected bare UUID reply/status and keeps legacy reply/status", async t => {
  const paths=temporary(t), id=protectedRecord(paths), legacy=crypto.randomUUID();
  storeMessage(paths.inbox,{messageId:legacy,from:{nodeId:NODE_B,session:B},toSession:A,text:"Synthetic legacy content",createdAt:new Date().toISOString()});
  const out:string[]=[],err:string[]=[];
  const context={paths,env:{CODEX_THREAD_ID:A},processTable:()=>null,out:(s:string)=>out.push(s),err:(s:string)=>err.push(s)};
  assert.equal(await runMsg(["send","--reply-to",id,"--","Synthetic reply"],context),1);
  assert.match(err.join("\n"),/protected native route required/);
  assert.equal(await runMsg(["status",id],context),1);assert.deepEqual(out,[]);
  assert.equal(await runMsg(["status",legacy],context),0);
  assert.equal(await runMsg(["send","--reply-to",legacy,"--","Synthetic legacy reply"],context),0);
  out.length=0;await runMsg(["inbox","--all","--from",A],context);
  assert.ok(!out.join("\n").includes("Synthetic protected content"));
});

test("old enabled Fork admission, recheck, relay and send gate exclude marked records", async t => {
  const node=relayNode(t), id=protectedRecord(node.paths,FORK_OWNER,T0);
  const fingerprint=busyPolicyFingerprint(readPolicy(node.paths.policy)!);
  const deps={paths:node.paths,now:()=>T0,platform:"darwin",postToolHook:()=>true};
  assert.deepEqual(admitForkReply(deps,FORK_OWNER,id,fingerprint),{ok:false,reason:"message-not-eligible"});
  assert.deepEqual(recheckForkReply(deps,FORK_OWNER,id,fingerprint),{ok:false,reason:"message-not-eligible"});
  assert.equal(relayMessageEligible(node.paths,FORK_OWNER,id),false);
  node.seed(id);await node.sweep();assert.deepEqual(await node.exchange(),[]);
  assert.equal(node.app.runs.length,0);
  const legacy=node.add();assert.equal(relayMessageEligible(node.paths,FORK_OWNER,legacy),true);
});

test("old enabled native Queue and Closed fallback leave protected records waiting in mixed storage", async t => {
  const queue=nativeQueueNode(t), id=protectedRecord(queue.paths,queue.owner,T0);
  await queue.poll();assert.equal(queue.fake.runs().length,0);
  scheduleNativeQueue(queue.deps(),queue.owner,[id],undefined,()=>{});
  await nativeQueueIdle();assert.equal(queue.fake.runs().length,0);
  // A fresh process reads the persisted marker with the old Queue opt-in still
  // enabled, using a fresh synthetic holder authority rather than a stale PID.
  const context=path.join(queue.root,"synthetic-slot-restart.json");
  fs.writeFileSync(context,JSON.stringify({paths:queue.paths,policy:queue.deps().policy,owner:queue.owner,id,
    now:T0,file:queue.fake.file,home:queue.home}));
  const source=`import fs from "node:fs";
    import { scheduleNativeQueue,nativeQueueIdle } from ${JSON.stringify(new URL("./codex-queue-producer.mts",import.meta.url).href)};
    import { publishSynthetic } from ${JSON.stringify(new URL("./session-authority-fixture.mts",import.meta.url).href)};
    import { writeLocalSessions } from ${JSON.stringify(new URL("./exchange-sessions.mts",import.meta.url).href)};
    import { testServiceOwner } from ${JSON.stringify(new URL("./task-fixture.mts",import.meta.url).href)};
    const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const rows=[{runtime:"codex",sessionId:c.owner,state:"running"}];
    const livenessAuthority=publishSynthetic(c.paths,[{runtime:"codex",sessionId:c.owner,
      holder:{status:"value",value:{present:true,creationIdentity:"synthetic-restart"},source:"native-holder",observedAt:c.now,complete:true,reasonCode:"observed"},
      turn:{status:"value",value:"running",source:"native-turn",observedAt:c.now,complete:true,reasonCode:"observed"}}],c.now,rows);
    writeLocalSessions(c.paths,rows,c.now);
    scheduleNativeQueue({...c,now:()=>c.now,serviceOwner:testServiceOwner,livenessAuthority,
      codex:{findCodex:()=>c.file,home:c.home}},c.owner,[c.id],undefined,()=>{});
    await nativeQueueIdle();`;
  const restarted=spawnSync(process.execPath,["--input-type=module","-e",source,context],{encoding:"utf8",timeout:10_000,env:{...process.env,CODEX_HOME:queue.home}});
  assert.equal(restarted.status,0,restarted.stderr);assert.match(restarted.stderr,HOOK_STDERR);assert.equal(queue.fake.runs().length,0);
  assert.equal(getMessage(queue.paths.inbox,id)?.state,"accepted");
  const ordinary=queue.add();
  const rows=[{runtime:"codex",sessionId:queue.owner,state:"running"}];
  const livenessAuthority=publishSynthetic(queue.paths,[{runtime:"codex",sessionId:queue.owner,
    holder:{status:"value",value:{present:true,creationIdentity:"synthetic-mixed"},source:"native-holder",observedAt:T0,complete:true,reasonCode:"observed"},
    turn:{status:"value",value:"running",source:"native-turn",observedAt:T0,complete:true,reasonCode:"observed"}}],T0,rows);
  writeLocalSessions(queue.paths,rows,T0);
  scheduleNativeQueue({...queue.deps(),livenessAuthority},queue.owner,[id,ordinary],undefined,()=>{});
  await nativeQueueIdle();assert.equal(queue.fake.runs().length,1);
  const closed=closedNode(t), protectedId=protectedRecord(closed.paths,SESSION,T0-5000);
  const legacy=deliver(closed);
  await deliverToClosed(closed.deps());
  assert.equal(getMessage(closed.paths.inbox,protectedId)?.state,"accepted");
  assert.equal(getMessage(closed.paths.inbox,protectedId)?.closedAttempt,undefined);
  assert.equal(getMessage(closed.paths.inbox,legacy)?.state,"offered");
  assert.ok(closed.calls.filter(c=>c.args[0]!=="agents").every(c=>!JSON.stringify(c.args).includes("Synthetic protected content")));
});
