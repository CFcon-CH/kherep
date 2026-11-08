import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { registry, session } from "./helpers.mts";
import { MAX_HOLD_REFUSAL_REFS, type MessageStore } from "../src/message-store.mts";
import type { McpRegistry } from "../src/mcp-registry.mts";
import { CHAT_A, PEER_SESSION, claudeMeta, delivered, sessionsOf, startNativeNode, startPeer } from "./mcp-two-chat-fixture.mts";

// Baseline RED only: real trusted hook implementation, authenticated node WS,
// MCP SDK HTTP and real Durable Object SQL. All input/identities are synthetic.
// The existing workerd harness calls the real hook function; it does not spawn
// a native Desktop or an external Hook process and proves no native acceptance.
it("passes a strict slot destination through native MCP schema to protected admission", async () => {
  const node = await startNativeNode("slot-schema-baseline", sessionsOf(CHAT_A));
  const peer = await startPeer();
  try {
    const client = await node.mcp();
    const legacyInput = { to: { nodeId: peer.nodeId, session: PEER_SESSION }, text: "Synthetic legacy route control" };
    const legacyArgs = await node.hook(CHAT_A, "slot-schema-legacy", "send", legacyInput);
    const legacy = await client.callTool({ name: "send", arguments: legacyArgs, _meta: claudeMeta("slot-schema-legacy") });
    expect(legacy.isError, JSON.stringify(legacy)).not.toBe(true);
    expect((await delivered(peer.socket, 1))[0]?.from).toEqual({ nodeId: node.nodeId, session: CHAT_A });
    const before = await registry().listMessages(node.nodeId, 100);
    const deliveryCount = node.received.filter(frame => frame.type === "message.deliver").length;
    const input = { to: { slot: "codex-mac" }, text: "Synthetic slot route baseline" };
    const args = await node.hook(CHAT_A, "slot-schema-native", "send", input);
    expect(args).toEqual({ ...input, requestId: expect.any(String) });
    let outcome: unknown;
    try {
      outcome = await client.callTool({ name: "send", arguments: args, _meta: claudeMeta("slot-schema-native") });
    } catch (error) {
      outcome = { protocolError: error instanceof Error ? error.message : "non-Error MCP failure" };
    }
    // Invalid/vacant destination never adds a message or dispatch. The expected
    // baseline failure is strictly the old address-only schema, not this fence.
    expect(await registry().listMessages(node.nodeId, 100)).toEqual(before);
    expect(node.received.filter(frame => frame.type === "message.deliver")).toHaveLength(deliveryCount);
    expect(JSON.stringify(outcome), "strict slot destination must reach protected admission rather than node/session validation")
      .not.toMatch(/Invalid arguments for tool send|to\.nodeId|to\.session/);
  } finally {
    await node.close();
    peer.socket.ws.close(1000, "done");
  }
});

const ORIGINAL = "a1111111-1111-4111-8111-111111111111";
const originalInput = (sessionId: string, callId: string, tool: string, toolInput: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: callId, turn_id: "synthetic-native-turn",
  transcript_path: `/synthetic/rollout-2026-11-08T12-00-00-${sessionId}.jsonl`,
  tool_name: `mcp__kherep_messaging__${tool}`, tool_input: toolInput,
});
const codexMeta = (sessionId: string, callId: string) => ({ sessionId, threadId: sessionId, callId });
it("qualifies a first own inbox read on UNKNOWN only for the exact native original callback", async () => {
  const node = await startNativeNode("first-original-read", [{ sessionId: ORIGINAL, runtime: "codex", state: "unknown" }], [ORIGINAL]);
  try {
    const client = await node.mcp();
    const hook = await node.nativeHook(originalInput(ORIGINAL, "first-original-read", "inbox", {}), "codex");
    const args = hook?.hookSpecificOutput.updatedInput;
    expect(args, JSON.stringify(hook)).toEqual({ requestId: expect.any(String) });
    const response = await client.callTool({ name: "inbox", arguments: args!, _meta: codexMeta(ORIGINAL, "first-original-read") });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ ok: true, items: [] });
    const child = await node.nativeHook({ ...originalInput(ORIGINAL, "child-read", "inbox", {}), agent_id: "synthetic-child" }, "codex");
    expect(child?.hookSpecificOutput.updatedInput).toBeUndefined();
  } finally { await node.close(); }
});

const RECIPIENT = "b1111111-1111-4111-8111-111111111111";
async function nativeCall(node: Awaited<ReturnType<typeof startNativeNode>>, sessionId: string, callId: string, tool: string, args: Record<string, unknown>) {
  const hook = await node.nativeHook(originalInput(sessionId, callId, tool, args), "codex");
  expect(hook?.hookSpecificOutput.updatedInput, JSON.stringify(hook)).toBeDefined();
  return (await node.mcp()).callTool({name:tool,arguments:hook!.hookSpecificOutput.updatedInput!,_meta:codexMeta(sessionId,callId)});
}
it("queues a protected frozen pair while the verified assigned recipient is offline", async () => {
  const a = await startNativeNode("slot-original-A", [{sessionId:ORIGINAL,runtime:"codex",state:"running"}], [ORIGINAL]);
  const b = await startNativeNode("slot-original-B", [{sessionId:RECIPIENT,runtime:"codex",state:"running"}], [RECIPIENT]);
  try {
    await a.assign(ORIGINAL,"kherep-lead"); await b.assign(RECIPIENT,"codex-mac");
    await b.offline();
    const result = await nativeCall(a,ORIGINAL,"slot-send-offline","send",{to:{slot:"codex-mac"},text:"Synthetic fixed endpoint question?"});
    expect(result.isError,JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ok:true,messageId:expect.stringMatching(/^intercom-/),state:"queued"});
    expect(b.received.filter(f=>f.type === "message.resolve.request")).toHaveLength(0);
    const messages = await registry().listMessages(a.nodeId,100);
    expect(messages.find(m=>m.fromSession === ORIGINAL && m.toSession === RECIPIENT)?.state).toBe("queued");
  } finally { await a.close();await b.close(); }
});

it.each(["send", "reply"])("refuses the offline queued pair when %s trips a hold, before release and original reconnect", async triggerTool => {
  const a = await startNativeNode("held-original-A", [{sessionId:ORIGINAL,runtime:"codex",state:"running"}], [ORIGINAL]);
  const b = await startNativeNode("held-original-B", [{sessionId:RECIPIENT,runtime:"codex",state:"running"}], [RECIPIENT]);
  const replacement = "d1111111-1111-4111-8111-111111111111";
  const c = await startNativeNode("held-replacement-C", [{sessionId:replacement,runtime:"codex",state:"running"}], [replacement]);
  try {
    await a.assign(ORIGINAL,"kherep-lead"); await b.assign(RECIPIENT,"codex-mac");
    let parent: string | undefined;
    if (triggerTool === "reply") {
      const root = await nativeCall(b,RECIPIENT,"held-reply-parent","send",{to:{slot:"kherep-lead"},text:"Synthetic new finding: preserve the offline hold lifecycle."});
      expect(root.isError,JSON.stringify(root)).not.toBe(true);
      parent = String((root.structuredContent as Record<string,unknown>).messageId);
      await vi.waitFor(async()=>expect((await registry().listMessages(b.nodeId,100)).find(m=>m.messageId===parent!.slice(-36))?.state).toBe("accepted"));
    }
    await b.offline();
    const queued: string[] = [];
    for (const [index,text] of ["ack","OK!"].entries()) {
      const sent = await nativeCall(a,ORIGINAL,`held-queue-${index}`,"send",{to:{slot:"codex-mac"},text});
      expect(sent.isError,JSON.stringify(sent)).not.toBe(true);
      queued.push(String((sent.structuredContent as Record<string,unknown>).messageId).slice(-36));
    }
    const rejected = await nativeCall(a,ORIGINAL,"held-trigger",triggerTool,{...(parent ? {inReplyTo:parent} : {to:{slot:"codex-mac"}}),text:"received"});
    expect(rejected.isError).toBe(true);
    const hold = (await registry().listMessageHolds(100)).find(h=>[h.fromNode,h.toNode].includes(a.nodeId) && [h.fromNode,h.toNode].includes(b.nodeId))!;
    expect(hold,JSON.stringify(rejected)).toBeDefined();
    const states = () => runInDurableObject(registry(),(_instance,state)=>state.storage.sql.exec(
      "SELECT id,state FROM messages WHERE id IN (?,?) UNION ALL SELECT id,state FROM message_tombstones WHERE id IN (?,?) ORDER BY id",
      ...queued,...queued).toArray());
    const beforeRelease = await states();
    const trigger = await runInDurableObject(registry(),(_instance,state)=>({
      messages:state.storage.sql.exec("SELECT id FROM messages WHERE id=?",String(hold.triggerMessageId)).toArray(),
      receipt:state.storage.sql.exec("SELECT binding,error FROM intercom_operations WHERE id=?",String(hold.triggerMessageId)).one(),
    }));
    await c.assign(replacement,"codex-mac");
    await registry().releaseMessageHold(String(hold.holdId),Number(hold.version),"synthetic operator");
    await b.restart();
    // The real connection's pending queue is drained before its registration reply.
    const stale = b.received.filter(f=>f.type === "message.deliver" && queued.includes((f.body as {messageId:string}).messageId));
    expect(stale,"releasing a hold must never revive its offline queued traffic").toEqual([]);
    expect(c.received.filter(f=>f.type === "message.deliver")).toEqual([]);
    expect(trigger.messages,"the rejected trigger must not insert a messages row").toEqual([]);
    expect(trigger.receipt).toEqual({binding:null,error:expect.stringMatching(/^loop-held:/)});
    expect(beforeRelease).toHaveLength(2);
    expect(beforeRelease.every(m=>m.state === "refused")).toBe(true);
    expect(await states()).toEqual(beforeRelease);
    await vi.waitFor(()=>expect(queued.every(id=>a.received.some(f=>f.type === "message.status" && (f.body as {messageId:string,state:string}).messageId===id && (f.body as {state:string}).state === "refused")),"queued refusals must route status effects to the sender").toBe(true));
  } finally {await a.close();await b.close();await c.close();}
});

it.each(["send", "reply"])("recovers only the unacked causal refusals after a partial %s hold push on the same native call", async triggerTool => {
  const a = await startNativeNode("partial-status-A", [{sessionId:ORIGINAL,runtime:"codex",state:"running"}], [ORIGINAL]);
  const b = await startNativeNode("partial-status-B", [{sessionId:RECIPIENT,runtime:"codex",state:"running"}], [RECIPIENT]);
  const replacement = "e1111111-1111-4111-8111-111111111111";
  const c = await startNativeNode("partial-replacement-C", [{sessionId:replacement,runtime:"codex",state:"running"}], [replacement]);
  let restore: (()=>void) | undefined;
  const gates=[0,1].map(()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release,entered:false};});
  const retries:Promise<unknown>[]=[];
  try {
    await a.assign(ORIGINAL,"kherep-lead"); await b.assign(RECIPIENT,"codex-mac");
    let parent: string | undefined;
    if (triggerTool === "reply") {
      const sent=await nativeCall(b,RECIPIENT,"partial-parent","send",{to:{slot:"kherep-lead"},text:"Synthetic fresh finding to anchor the original reply."});
      expect(sent.isError,JSON.stringify(sent)).not.toBe(true);
      parent=String((sent.structuredContent as Record<string,unknown>).messageId);
      await vi.waitFor(async()=>expect((await registry().listMessages(b.nodeId,100)).find(m=>m.messageId===parent!.slice(-36))?.state).toBe("accepted"));
    }
    await b.offline();
    const queued:string[]=[];
    for(const [index,text] of ["ack","OK!"].entries()) {
      const sent=await nativeCall(a,ORIGINAL,`partial-queued-${index}`,"send",{to:{slot:"codex-mac"},text});
      expect(sent.isError).not.toBe(true);queued.push(String((sent.structuredContent as Record<string,unknown>).messageId).slice(-36));
    }
    const attempted:string[]=[];
    await runInDurableObject(session(a.nodeId),instance=>{
      const prototype=Object.getPrototypeOf(instance),descriptor=Object.getOwnPropertyDescriptor(prototype,"pushFrame")!;
      const push=instance.pushFrame;restore=()=>{Object.defineProperty(prototype,"pushFrame",descriptor);};
      // RPC methods must remain inherited in the installed Cloudflare harness.
      Object.defineProperty(prototype,"pushFrame",{...descriptor,value:async function(this:typeof instance,...args:Parameters<typeof push>){
        if(this===instance && args[0]==="message.status" && args[1].state==="refused" && queued.includes(String(args[1].messageId))) {
          attempted.push(String(args[1].messageId));
          if(attempted.length===2) throw new Error("synthetic second refusal push fault");
          const gate=gates[attempted.length-3];
          if(gate){gate.entered=true;await gate.promise;}
        }
        return push.apply(this,args);
      }});
    });
    const expiredId=crypto.randomUUID();
    await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec(`INSERT INTO messages
      (id,from_node,from_session,to_node,to_session,text,state,created_at,updated_at,expires_at,deletable)
      VALUES (?,?,?,?,?,'Synthetic unrelated expiry','queued',?,?,?,1)`,expiredId,a.nodeId,"synthetic-expiry-source",b.nodeId,"synthetic-expiry-target",Date.now()-10000,Date.now()-10000,Date.now()-1));
    const input={...(parent?{inReplyTo:parent}:{to:{slot:"codex-mac"}}),text:"received"};
    const hook=await a.nativeHook(originalInput(ORIGINAL,"partial-trigger",triggerTool,input),"codex");
    const args=hook!.hookSpecificOutput.updatedInput!,id=String(args.requestId),client=await a.mcp();
    const call=()=>client.callTool({name:triggerTool,arguments:args,_meta:codexMeta(ORIGINAL,"partial-trigger")});
    const first=await call();
    expect(first.isError).toBe(true);expect(JSON.stringify(first)).toContain("uncertain");
    expect(attempted).toHaveLength(2);
    const firstId=attempted[0],missing=attempted[1];
    const refusedFrames=(messageId:string)=>a.received.filter(f=>f.type==="message.status" && (f.body as {messageId:string,state:string}).messageId===messageId && (f.body as {state:string}).state==="refused");
    await vi.waitFor(async()=>expect(await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("SELECT state FROM message_tombstones WHERE id=?",firstId).toArray())).toEqual([{state:"refused"}]));
    expect(refusedFrames(firstId)).toHaveLength(1);expect(refusedFrames(missing)).toEqual([]);
    const outstanding=await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("SELECT state,reason FROM messages WHERE id=?",missing).one());
    expect(outstanding).toEqual({state:"refused",reason:expect.stringMatching(/^loop-held:/)});
    const hold=(await registry().listMessageHolds(100)).find(h=>h.triggerMessageId===id)!;
    const stored=await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("SELECT hold_refusals_json,expires_at FROM mcp_intents WHERE node_id=? AND request_id=?",a.nodeId,id).one());
    expect(JSON.parse(String(stored.hold_refusals_json))).toEqual(queued.map(messageId=>({messageId,nodeId:a.nodeId})));
    const unrelated=crypto.randomUUID();
    await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec(`INSERT INTO messages
      (id,from_node,from_session,to_node,to_session,text,state,reason,created_at,updated_at,expires_at,deletable)
      VALUES (?,?,?,?,?,NULL,'refused',?,?,?,?,1)`,unrelated,a.nodeId,ORIGINAL,b.nodeId,RECIPIENT,String(outstanding.reason),Date.now(),Date.now(),Date.now()+60000));
    const emptyInput={to:{slot:"codex-mac"},text:"Synthetic unrelated request while this pair remains held."};
    const emptyHook=await a.nativeHook(originalInput(ORIGINAL,"empty-held-trigger","send",emptyInput),"codex");
    const emptyArgs=emptyHook!.hookSpecificOutput.updatedInput!;
    const emptyCall=()=>client.callTool({name:"send",arguments:emptyArgs,_meta:codexMeta(ORIGINAL,"empty-held-trigger")});
    expect((await emptyCall()).isError).toBe(true);expect((await emptyCall()).isError).toBe(true);
    await runInDurableObject(registry(),(_i,state)=>expect(state.storage.sql.exec("SELECT hold_refusals_json FROM mcp_intents WHERE request_id=?",String(emptyArgs.requestId)).one()).toEqual({hold_refusals_json:null}));
    expect(attempted).toHaveLength(2);expect(refusedFrames(unrelated)).toEqual([]);
    for(const bad of [
      {arguments:{...args,text:"Synthetic altered digest"},_meta:codexMeta(ORIGINAL,"partial-trigger")},
      {arguments:args,_meta:codexMeta(ORIGINAL,"different-native-call")},
      {arguments:args,_meta:codexMeta(RECIPIENT,"partial-trigger")},
    ]) expect((await client.callTool({name:triggerTool,...bad})).isError).toBe(true);
    expect((await (await c.mcp()).callTool({name:triggerTool,arguments:args,_meta:codexMeta(replacement,"partial-trigger")})).isError).toBe(true);
    await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("UPDATE mcp_intents SET expires_at=?,hold_refusals_json='{' WHERE request_id=?",Date.now()-1,id));
    const expired=await call();expect(expired.isError).toBe(true);
    expect(JSON.stringify(expired)).not.toContain("invalid hold refusal recovery metadata");
    await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("UPDATE mcp_intents SET expires_at=?,hold_refusals_json=? WHERE request_id=?",stored.expires_at,String(stored.hold_refusals_json),id));
    // Pre-fix NULL rows keep denial/auth-time replay without inferred membership.
    await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("UPDATE mcp_intents SET hold_refusals_json=NULL WHERE request_id=?",id));
    expect((await call()).isError).toBe(true);expect(attempted).toHaveLength(2);
    await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("UPDATE mcp_intents SET hold_refusals_json=? WHERE request_id=?",String(stored.hold_refusals_json),id));
    await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("UPDATE mcp_intents SET hold_refusals_json='{' WHERE request_id=?",id));
    const malformed=await call();expect(malformed.isError).toBe(true);
    expect(JSON.stringify(malformed)).toContain("invalid hold refusal recovery metadata");
    expect(attempted).toHaveLength(2);
    await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("UPDATE mcp_intents SET hold_refusals_json=? WHERE request_id=?",String(stored.hold_refusals_json),id));
    await c.assign(replacement,"codex-mac");
    await registry().releaseMessageHold(String(hold.holdId),Number(hold.version),"synthetic operator");
    const {writeOutbox,recordSent,getSent}=await import("../../node/exchange.mts");
    writeOutbox(a.paths,{messageId:missing,fromSession:ORIGINAL,to:{nodeId:b.nodeId,session:RECIPIENT},text:"Synthetic local sent fixture",createdAt:new Date().toISOString()});
    recordSent(a.paths,missing,"queued");
    // Both retries reconstruct before the first recovered offer can be ACKed.
    const retry=call();retries.push(retry);await vi.waitFor(()=>expect(gates[0].entered).toBe(true));
    const overlap=call();retries.push(overlap);await vi.waitFor(()=>expect(gates[1].entered).toBe(true));
    gates[0].release();expect((await retry).isError).toBe(true);
    await vi.waitFor(()=>expect(refusedFrames(missing)).toHaveLength(1));
    await vi.waitFor(async()=>expect(await runInDurableObject(registry(),(_i,state)=>state.storage.sql.exec("SELECT state FROM message_tombstones WHERE id=?",missing).toArray())).toEqual([{state:"refused"}]));
    const localTerminal=getSent(a.paths,missing);expect(localTerminal?.state).toBe("refused");
    gates[1].release();expect((await overlap).isError).toBe(true);
    await vi.waitFor(()=>expect(refusedFrames(missing)).toHaveLength(2));
    expect(getSent(a.paths,missing)).toEqual(localTerminal);
    expect(attempted,"same native retries must only recover the outstanding causal UUID").toEqual([firstId,missing,missing,missing]);
    expect(refusedFrames(unrelated)).toEqual([]);
    await registry().ackMessageStatus(a.nodeId,{name:"message.status.ack",messageId:missing,state:"refused"});
    await call();expect(attempted).toEqual([firstId,missing,missing,missing]);
    await b.restart();
    expect(b.received.filter(f=>f.type==="message.deliver")).toEqual([]);expect(c.received.filter(f=>f.type==="message.deliver")).toEqual([]);
    await runInDurableObject(registry(),(_i,state)=>{
      expect(state.storage.sql.exec("SELECT id FROM messages WHERE id=? UNION ALL SELECT id FROM message_tombstones WHERE id=?",id,id).toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT binding,error FROM intercom_operations WHERE id=?",id).one()).toEqual({binding:null,error:expect.stringMatching(/^loop-held:/)});
      expect(state.storage.sql.exec("SELECT state FROM message_tombstones WHERE id=?",missing).toArray()).toEqual([{state:"refused"}]);
    });
    expect(a.received.filter(f=>f.type==="message.status" && (f.body as {messageId:string,state:string}).messageId===expiredId && (f.body as {state:string}).state==="expired")).toHaveLength(1);
  } finally {for(const gate of gates)gate.release();await Promise.allSettled(retries);await runInDurableObject(session(a.nodeId),()=>restore?.());await a.close();await b.close();await c.close();}
});

it("bounds and validates causal metadata and reads only matching live unsettled refusals", async()=>{
  const a=await startNativeNode("bounded-refusals-A",[{sessionId:ORIGINAL,runtime:"codex",state:"running"}],[ORIGINAL]);
  const b=await startNativeNode("bounded-refusals-B",[{sessionId:RECIPIENT,runtime:"codex",state:"running"}],[RECIPIENT]);
  try {
    const input={to:{slot:"codex-mac"},text:"Synthetic validation intent, not a message admission."};
    const hook=await a.nativeHook(originalInput(ORIGINAL,"bounded-refs","send",input),"codex"),id=String(hook!.hookSpecificOutput.updatedInput!.requestId);
    await runInDurableObject(registry(),(instance,state)=>{
      const {mcp,messages}=instance as unknown as {mcp:McpRegistry,messages:MessageStore},sql=state.storage.sql;
      const row=sql.exec("SELECT * FROM mcp_intents WHERE request_id=?",id).one();
      const refs=Array.from({length:MAX_HOLD_REFUSAL_REFS},(_,i)=>({messageId:crypto.randomUUID(),nodeId:i%2===0?a.nodeId:b.nodeId}));
      const reason=`loop-held: ack-or-repeat; hold=${crypto.randomUUID()}; operator release required`;
      expect(mcp.holdRefusals(a.nodeId,id)).toEqual([]);
      expect(()=>mcp.saveHoldRefusals(a.nodeId,id,[refs[0]])).toThrow("invalid hold refusal recovery metadata");
      const claim={nodeId:a.nodeId,credentialVersion:Number(row.credential_version),requestId:id,tool:"send" as const,runtime:"codex" as const,
        sessionId:ORIGINAL,threadId:ORIGINAL,callId:"bounded-refs",argumentsDigest:String(row.arguments_digest)};
      expect(mcp.originalClaim(claim).ok).toBe(true);expect(mcp.claim(claim,Date.now()).ok).toBe(true);
      const invalid=[[],[...refs,{messageId:crypto.randomUUID(),nodeId:a.nodeId}],[refs[0],refs[0]],
        [{...refs[0],text:"synthetic forbidden payload"}],[{messageId:"invalid",nodeId:a.nodeId}],[{messageId:refs[0].messageId,nodeId:"operator"}]];
      for(const value of invalid) expect(()=>mcp.saveHoldRefusals(a.nodeId,id,value)).toThrow("invalid hold refusal recovery metadata");
      expect(()=>mcp.saveHoldRefusals(b.nodeId,id,[refs[0]])).toThrow("invalid hold refusal recovery metadata");
      sql.exec("UPDATE mcp_intents SET tool_name='inbox' WHERE request_id=?",id);
      expect(()=>mcp.saveHoldRefusals(a.nodeId,id,[refs[0]])).toThrow("invalid hold refusal recovery metadata");
      sql.exec("UPDATE mcp_intents SET tool_name='send' WHERE request_id=?",id);
      expect(()=>state.storage.transactionSync(()=>{
        sql.exec("UPDATE mcp_intents SET outcome='synthetic rollback marker' WHERE request_id=?",id);
        mcp.saveHoldRefusals(a.nodeId,id,[...refs,{messageId:crypto.randomUUID(),nodeId:a.nodeId}]);
      })).toThrow("invalid hold refusal recovery metadata");
      expect(sql.exec("SELECT outcome,hold_refusals_json FROM mcp_intents WHERE request_id=?",id).one()).toEqual({outcome:"claimed",hold_refusals_json:null});
      mcp.saveHoldRefusals(a.nodeId,id,refs);expect(mcp.holdRefusals(a.nodeId,id)).toEqual(refs);
      expect(()=>mcp.saveHoldRefusals(a.nodeId,id,refs)).toThrow("invalid hold refusal recovery metadata");
      const encoded=String(sql.exec("SELECT hold_refusals_json FROM mcp_intents WHERE request_id=?",id).one().hold_refusals_json);
      mcp.recordOutcome(a.nodeId,id,"uncertain");expect(mcp.holdRefusals(a.nodeId,id)).toEqual(refs);
      expect(()=>mcp.holdRefusals(b.nodeId,id)).toThrow("invalid hold refusal recovery metadata");
      for(const value of ["{","null",...invalid.map(v=>JSON.stringify(v))," ".repeat(MAX_HOLD_REFUSAL_REFS*128+1)]){
        sql.exec("UPDATE mcp_intents SET hold_refusals_json=? WHERE request_id=?",value,id);
        expect(()=>mcp.holdRefusals(a.nodeId,id)).toThrow("invalid hold refusal recovery metadata");
      }
      sql.exec("UPDATE mcp_intents SET hold_refusals_json=? WHERE request_id=?",encoded,id);
      for(const ref of refs)sql.exec(`INSERT INTO messages
        (id,from_node,from_session,to_node,to_session,text,state,reason,created_at,updated_at,expires_at,deletable)
        VALUES (?,?,?,?,?,NULL,'refused',?,?,?,?,1)`,ref.messageId,ref.nodeId,ORIGINAL,a.nodeId,RECIPIENT,reason,Date.now(),Date.now(),Date.now()+60000);
      // Two hundred exact IDs exercise more than three bound primary-key batches.
      expect(messages.outstandingHoldRefusals(reason,refs)).toEqual({deliveries:[],statuses:refs.map(ref=>({nodeId:ref.nodeId,body:{messageId:ref.messageId,state:"refused",reason}}))});
      sql.exec("DELETE FROM messages WHERE id=?",refs[0].messageId);
      sql.exec("UPDATE messages SET deletable=0 WHERE id=?",refs[2].messageId);
      messages.retention.ack(a.nodeId,{name:"message.status.ack",messageId:refs[2].messageId,state:"refused"},Date.now());
      expect(sql.exec("SELECT state,settled_state FROM messages WHERE id=?",refs[2].messageId).one()).toEqual({state:"refused",settled_state:"refused"});
      sql.exec("UPDATE messages SET reason='different refusal' WHERE id=?",refs[4].messageId);
      sql.exec("UPDATE messages SET from_node=? WHERE id=?",b.nodeId,refs[6].messageId);
      sql.exec("UPDATE nodes SET revoked_at=? WHERE id=?",Date.now(),b.nodeId);
      const before=sql.exec("SELECT * FROM messages WHERE reason=? ORDER BY id",reason).toArray();
      const remaining=refs.filter((_,i)=>i%2===0 && ![0,2,4,6].includes(i));
      expect(messages.outstandingHoldRefusals(reason,mcp.holdRefusals(a.nodeId,id))).toEqual({deliveries:[],statuses:remaining.map(ref=>({nodeId:ref.nodeId,body:{messageId:ref.messageId,state:"refused",reason}}))});
      expect(sql.exec("SELECT * FROM messages WHERE reason=? ORDER BY id",reason).toArray()).toEqual(before);
      expect(messages.outstandingHoldRefusals(reason,[])).toEqual({deliveries:[],statuses:[]});
      expect(()=>messages.outstandingHoldRefusals("peer supplied reason",refs)).toThrow("invalid hold refusal recovery metadata");
      expect(()=>messages.outstandingHoldRefusals(reason,[...refs,refs[0]])).toThrow("invalid hold refusal recovery metadata");
      sql.exec("UPDATE nodes SET revoked_at=NULL WHERE id=?",b.nodeId);
    });
  } finally {await a.close();await b.close();}
});

it("keeps replacement out of queued traffic and permits only the frozen original reply after parent cleanup", async () => {
  const a = await startNativeNode("frozen-A", [{sessionId:ORIGINAL,runtime:"codex",state:"running"}], [ORIGINAL]);
  const bRows = [{sessionId:RECIPIENT,runtime:"codex",state:"running"}];
  const b = await startNativeNode("frozen-B", bRows, [RECIPIENT]);
  const replacement = "c1111111-1111-4111-8111-111111111111";
  const c = await startNativeNode("replacement-C", [{sessionId:replacement,runtime:"codex",state:"running"}], [replacement]);
  try {
    await a.assign(ORIGINAL,"kherep-lead");await b.assign(RECIPIENT,"codex-mac");await b.offline();
    const args = {to:{slot:"codex-mac"},text:"Synthetic confidential fixture question with a new constraint?"};
    const sent = await nativeCall(a,ORIGINAL,"frozen-send","send",args);
    expect(sent.isError,JSON.stringify(sent)).not.toBe(true);
    const reference = String((sent.structuredContent as Record<string,unknown> | undefined)?.messageId), id = reference.slice(-36);
    await c.assign(replacement,"codex-mac");
    const retry=await (await a.mcp()).callTool({name:"send",arguments:{...args,requestId:id},_meta:codexMeta(ORIGINAL,"frozen-send")});
    expect(retry.isError,JSON.stringify(retry)).not.toBe(true);
    expect((retry.structuredContent as Record<string,unknown>)?.messageId).toBe(reference);
    expect((await registry().listMessages(a.nodeId,100)).filter(m=>m.toSession===RECIPIENT)).toHaveLength(1);
    bRows[0].state = "unknown";
    await b.restart();
    await vi.waitFor(async()=>expect((await registry().listMessages(a.nodeId,100)).find(m=>m.toSession===RECIPIENT)?.state).toBe("accepted"));
    const own = await nativeCall(b,RECIPIENT,"frozen-own-read","inbox",{});
    expect(JSON.stringify(own.structuredContent)).toContain(args.text);
    expect(JSON.stringify(own.structuredContent)).toContain(reference);
    const stranger = await nativeCall(c,replacement,"replacement-read","inbox",{});
    expect(JSON.stringify(stranger)).not.toContain(args.text);
    const rejected = await nativeCall(c,replacement,"replacement-reply","reply",{inReplyTo:reference,text:"Synthetic wrong original"});
    expect(rejected.isError).toBe(true);
    const bare = await nativeCall(b,RECIPIENT,"bare-uuid-reply","reply",{inReplyTo:id,text:"Synthetic bare UUID attempt"});
    expect(bare.isError).toBe(true);
    const liveReply=await nativeCall(b,RECIPIENT,"frozen-live-reply","reply",{inReplyTo:reference,text:"Synthetic first finding: the fixed owner has a distinct, verified routing constraint."});
    expect(liveReply.isError,JSON.stringify(liveReply)).not.toBe(true);
    await registry().ackMessageStatus(a.nodeId,{name:"message.status.ack",messageId:id,state:"replied"});
    await runInDurableObject(registry(),(_instance,state)=>expect(state.storage.sql.exec("SELECT id FROM messages WHERE id=?",id).toArray()).toEqual([]));
    const reply = await nativeCall(b,RECIPIENT,"frozen-retained-reply","reply",{inReplyTo:reference,text:"Synthetic answer: use the distinct original endpoint and preserve this new decision."});
    expect(reply.isError,JSON.stringify(reply)).not.toBe(true);
    expect((reply.structuredContent as Record<string,unknown> | undefined)?.messageId).toMatch(/^intercom-/);
    const status=await nativeCall(a,ORIGINAL,"frozen-parent-status","status",{messageId:reference});
    expect((status.structuredContent as Record<string,unknown>)?.replyMessageId).toMatch(/^intercom-/);
    const deliveredReply = await nativeCall(a,ORIGINAL,"frozen-reply-read","inbox",{});
    expect(JSON.stringify(deliveredReply)).toContain("preserve this new decision");
    expect(c.received.filter(f=>f.type === "message.deliver")).toHaveLength(0);
    expect(b.received.filter(f=>f.type === "message.resolve.request").every(f=>(f.body as {purpose:string}).purpose === "slot-storage")).toBe(true);
  } finally {await a.close();await b.close();await c.close();}
});

it("refuses retained slot records in bare UUID shell reply and status while preserving legacy controls", async () => {
  const node = await startNativeNode("local-privacy",[{sessionId:ORIGINAL,runtime:"codex",state:"running"}],[ORIGINAL]);
  try {
    const inbox = await import("../../node/inbox.mts");
    const {runMsgArgs} = await import(/* @vite-ignore */ new URL("../../node/msg-cli.mts",import.meta.url).href) as {runMsgArgs:(args:unknown,io:unknown)=>Promise<number>};
    const id = crypto.randomUUID(), legacyId=crypto.randomUUID();
    const binding = {version:1 as const,mode:"slot-exact" as const,from:{sessionId:RECIPIENT,runtime:"codex",lifecycleGeneration:null},to:{sessionId:ORIGINAL,runtime:"codex",lifecycleGeneration:null},
      slot:{fromNode:node.nodeId,toNode:node.nodeId,fromSlot:"codex-mac",toSlot:"kherep-lead",fromRevision:1,toRevision:1,operationId:id,argumentsDigest:"a".repeat(43),issuedAt:Date.now()}};
    inbox.storeMessage(node.paths.inbox,{messageId:id,from:{nodeId:node.nodeId,session:RECIPIENT},toSession:ORIGINAL,text:"Synthetic protected local history",createdAt:new Date().toISOString(),binding:{...binding,leaseId:crypto.randomUUID(),localGeneration:null}});
    inbox.storeMessage(node.paths.inbox,{messageId:legacyId,from:{nodeId:node.nodeId,session:RECIPIENT},toSession:ORIGINAL,text:"Synthetic ordinary history",createdAt:new Date().toISOString()});
    const out:string[]=[],err:string[]=[];
    const io={paths:node.paths,env:{CODEX_THREAD_ID:ORIGINAL},now:Date.now,processTable:()=>null,out:(s:string)=>out.push(s),err:(s:string)=>err.push(s)};
    expect(await runMsgArgs({positionals:["send","Synthetic shell answer"],values:{"reply-to":id}},io)).toBe(1);
    expect(err.join("\n")).toContain("protected native route required");
    expect(out).toEqual([]);
    expect(await runMsgArgs({positionals:["status",id],values:{}},io)).toBe(1);
    expect(out).toEqual([]);
    expect(await runMsgArgs({positionals:["status",legacyId],values:{}},io)).toBe(0);
    expect(out.join("\n")).toContain(legacyId);
    out.length=0;
    await runMsgArgs({positionals:["inbox"],values:{all:true,from:ORIGINAL}},io);
    expect(out.join("\n")).not.toContain("Synthetic protected local history");
  } finally {await node.close();}
});

it("rejects an A to B to A revision race with zero new messages or delivery effects", async()=>{
  const a=await startNativeNode("race-A",[{sessionId:ORIGINAL,runtime:"codex",state:"running"}],[ORIGINAL]);
  const b=await startNativeNode("race-B",[{sessionId:RECIPIENT,runtime:"codex",state:"running"}],[RECIPIENT]);
  try {
    await a.assign(ORIGINAL,"kherep-lead");await b.assign(RECIPIENT,"codex-mac");
    const before=await registry().listMessages(a.nodeId,100);
    await runInDurableObject(registry(),(instance,state)=>{
      const store=(instance as unknown as {messages:{prepare:(...args:unknown[])=>Promise<unknown>}}).messages;
      const prepare=store.prepare.bind(store);
      store.prepare=async(...args)=>{
        const prepared=await prepare(...args);store.prepare=prepare;
        // Interleave after the real asynchronous canonical-pair/signature work.
        const old=state.storage.sql.exec("SELECT * FROM intercom_slots WHERE slot='codex-mac'").one();
        state.storage.sql.exec("UPDATE intercom_slots SET session_id=?,revision=revision+1 WHERE slot='codex-mac'",ORIGINAL);
        state.storage.sql.exec("UPDATE intercom_slots SET session_id=?,revision=revision+1 WHERE slot='codex-mac'",old.session_id);
        return prepared;
      };
    });
    const response=await nativeCall(a,ORIGINAL,"race-send","send",{to:{slot:"codex-mac"},text:"Synthetic ABA race question?"});
    expect(response.isError).toBe(true);
    expect(await registry().listMessages(a.nodeId,100)).toEqual(before);
    expect(b.received.filter(f=>f.type === "message.deliver")).toHaveLength(0);
  } finally {await a.close();await b.close();}
});

it("rejects foreign hook thread, malformed canonical path and derived original markers",async()=>{
  const node=await startNativeNode("root-controls",[{sessionId:ORIGINAL,runtime:"codex",state:"unknown"}],[ORIGINAL]);
  try {
    for (const [i,extra] of [{thread_id:RECIPIENT},{agent_role:"reviewer"},{transcript_path:`/synthetic/rollout-2026-99-99T99-99-99-${ORIGINAL}.jsonl`}].entries()) {
      const response=await node.nativeHook({...originalInput(ORIGINAL,`root-negative-${i}`,"inbox",{}),...extra},"codex");
      expect(response?.hookSpecificOutput.updatedInput,JSON.stringify(extra)).toBeUndefined();
    }
  } finally {await node.close();}
});


// This case is executed by the recorded manual host-fixture command. Ordinary
// workerd-only CI reports it skipped, never as native Desktop acceptance.
it("uses the actual staged external Hook process before protected SDK send and own read",async context=>{
  const available=await fetch("http://127.0.0.1:47861/health",{signal:AbortSignal.timeout(500)}).then(r=>r.ok).catch(()=>false);
  if (!available) {context.skip("manual staged Hook subprocess fixture is not active");return;}
  const a=await startNativeNode("external-hook-A",[{sessionId:ORIGINAL,runtime:"codex",state:"running"}],[ORIGINAL]);
  const b=await startNativeNode("external-hook-B",[{sessionId:RECIPIENT,runtime:"codex",state:"running"}],[RECIPIENT]);
  try {
    await a.assign(ORIGINAL,"kherep-lead");await b.assign(RECIPIENT,"codex-mac");
    const input={to:{slot:"codex-mac"},text:"Synthetic external Hook process question?"};
    const hook=await a.externalNativeHook(originalInput(ORIGINAL,"external-send","send",input));
    const args=hook?.hookSpecificOutput.updatedInput;
    expect(args,JSON.stringify(hook)).toEqual({...input,requestId:expect.any(String)});
    const sent=await (await a.mcp()).callTool({name:"send",arguments:args!,_meta:codexMeta(ORIGINAL,"external-send")});
    expect(sent.isError,JSON.stringify(sent)).not.toBe(true);
    const readHook=await b.externalNativeHook(originalInput(RECIPIENT,"external-read","inbox",{}));
    const read=await (await b.mcp()).callTool({name:"inbox",arguments:readHook!.hookSpecificOutput.updatedInput!,_meta:codexMeta(RECIPIENT,"external-read")});
    expect(JSON.stringify(read)).toContain(input.text);
    expect(JSON.stringify(read)).toContain("intercom-");
  } finally {await a.close();await b.close();}
});

it("refuses unproven occupancy and an interleaved caller credential revocation before message INSERT",async()=>{
  const a=await startNativeNode("credential-race-A",[{sessionId:ORIGINAL,runtime:"codex",state:"running"}],[ORIGINAL]);
  const b=await startNativeNode("credential-race-B",[{sessionId:RECIPIENT,runtime:"codex",state:"running"}],[RECIPIENT]);
  try {
    await a.assign(ORIGINAL,"kherep-lead");await b.assign(RECIPIENT,"codex-mac");
    const before=await registry().listMessages(a.nodeId,100);
    await runInDurableObject(registry(),(instance)=>{
      const store=(instance as unknown as {messages:{prepare:(...args:unknown[])=>Promise<unknown>}}).messages;
      const prepare=store.prepare.bind(store);
      store.prepare=async(...args)=>{const prepared=await prepare(...args);store.prepare=prepare;await instance.rotateMcpCredential(a.nodeId);return prepared;};
    });
    const response=await nativeCall(a,ORIGINAL,"credential-race-send","send",{to:{slot:"codex-mac"},text:"Synthetic credential race?"});
    expect(response.isError).toBe(true);
    expect(await registry().listMessages(a.nodeId,100)).toEqual(before);
    expect(b.received.filter(f=>f.type === "message.deliver")).toHaveLength(0);
  } finally {await a.close();await b.close();}
  const source=await startNativeNode("unproven-source",[{sessionId:ORIGINAL,runtime:"codex",state:"running"}],[ORIGINAL]);
  const target=await startNativeNode("unproven-target",[{sessionId:RECIPIENT,runtime:"codex",state:"running"}],[RECIPIENT]);
  try {
    await source.assign(ORIGINAL,"kherep-lead");await target.assign(RECIPIENT,"codex-mac");
    await runInDurableObject(registry(),(_instance,state)=>{state.storage.sql.exec("DELETE FROM intercom_assignment_proofs WHERE slot='codex-mac'");});
    const before=await registry().listMessages(source.nodeId,100);
    const response=await nativeCall(source,ORIGINAL,"unproven-send","send",{to:{slot:"codex-mac"},text:"Synthetic unproven occupied slot?"});
    expect(response.isError).toBe(true);expect(await registry().listMessages(source.nodeId,100)).toEqual(before);
    expect(target.received.filter(f=>f.type === "message.resolve.request" || f.type === "message.deliver")).toHaveLength(0);
  } finally {await source.close();await target.close();}
});

it("does not restamp an old socket native invocation into a newer accepted registration",async()=>{
  const node=await startNativeNode("socket-epoch-source",[{sessionId:ORIGINAL,runtime:"codex",state:"running"}],[ORIGINAL]);
  try {
    const capabilities=await runInDurableObject(registry(),(_instance,state)=>JSON.parse(String(state.storage.sql.exec("SELECT capabilities FROM nodes WHERE id=?",node.nodeId).one().capabilities)) as string[]);
    const token=crypto.randomUUID();
    await registry().beginMessageConnection(node.nodeId,token);
    await registry().updateRegistration(node.nodeId,{hostname:"synthetic.example.invalid",os:"darwin",arch:"arm64",cpus:1,memoryBytes:1},[],capabilities,token);
    const hook=await node.nativeHook(originalInput(ORIGINAL,"old-socket-call","inbox",{}),"codex");
    expect(hook?.hookSpecificOutput.updatedInput).toBeUndefined();
  } finally {await node.close();}
});
