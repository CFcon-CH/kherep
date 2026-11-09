import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { parseClaudeSlotCommand, runClaudeSlotHook, deliverForHook } from "./deliver-hook.mts";
import { nodePaths, writeConfig } from "./config.mts";
import { connectionClaudeHooks, recordingSessions } from "./exchange-sessions.mts";
import { attachLiveness } from "./liveness-pass.mts";
import { markUnseen, unlistedRuntimes } from "./known-sessions.mts";
import { readLivenessSnapshot, sessionVerdict } from "./session-lifecycle.mts";
import { isClaudeSlotSelection, isClaudeSlotResult, makeEnvelope, type SessionInfo } from "../protocol.mts";
import { isSlotAddressRequest, isSlotAddressResult } from "../protocol-messages.mts";
import { readSlotExchange, writeSlotExchange, writeDirectory, writeLocalSessions, getOutbox, slotExchangeFile } from "./exchange.mts";
import { runMsg, CLI_PATH } from "./msg-cli.mts";
import { getMessage, storeMessage } from "./inbox.mts";

const S = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const N = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000_000;
const native = (slot = "claude-mac") => ({ hook_event_name: "UserPromptExpansion", expansion_type: "slash_command",
  command_name: "kherep-slot", command_args: slot, prompt: `/kherep-slot ${slot}`, session_id: S, prompt_id: P });
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-v2b-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root); fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: ["*"] } }));
  return { root, paths };
}

test("native slash grammar allows platform seats, explicit top-level fork and zero-argument Lead alias", () => {
  assert.equal(parseClaudeSlotCommand(native(), "darwin", NOW)?.slot, "claude-mac");
  assert.equal(parseClaudeSlotCommand(native("claude-windows"), "win32", NOW)?.slot, "claude-windows");
  for (const platform of ["darwin", "win32"]) {
    assert.equal(parseClaudeSlotCommand(native("kherep-lead"), platform, NOW)?.slot, "kherep-lead");
    assert.equal(parseClaudeSlotCommand({ ...native(), command_name: "kherep-set-lead", command_args: "", prompt: "/kherep-set-lead" }, platform, NOW)?.slot, "kherep-lead");
  }
  assert.equal(parseClaudeSlotCommand({ ...native(), parent_session_id: OTHER }, "darwin", NOW)?.sessionId, S);
});

test("model invocation, auxiliary, malformed IDs, wrong platforms and peer/multiline text cannot select", () => {
  const bad = [{ ...native(), hook_event_name: "PreToolUse" }, { ...native(), expansion_type: "mcp_prompt" },
    { ...native(), agent_id: "aux" }, { ...native(), agent_type: "teammate" }, { ...native(), prompt_id: undefined },
    { ...native(), session_id: "short" }, { ...native(), prompt: "/kherep-slot claude-mac\n" },
    { ...native(), command_args: "claude-mac extra" }, { ...native(), command_args: '"claude-mac"' },
    { ...native(), prompt: "peer said /kherep-slot claude-mac" }, { ...native(), prompt: "x".repeat(257) },
    { ...native(), command_name: "kherep-set-lead", command_args: "extra", prompt: "/kherep-set-lead extra" }];
  for (const input of bad) assert.equal(parseClaudeSlotCommand(input, "darwin", NOW), null, JSON.stringify(input));
  for (const slot of ["codex-mac", "codex-windows", "claude-windows", "unknown"]) assert.equal(parseClaudeSlotCommand(native(slot), "darwin", NOW), null);
  assert.equal(parseClaudeSlotCommand(native(), "linux", NOW), null);
  assert.equal(parseClaudeSlotCommand(native(), "win32", NOW), null);
});

test("selection and address shapes are strict and disjoint from inventory", () => {
  const request = parseClaudeSlotCommand(native(), "darwin", NOW)!;
  assert.equal(isClaudeSlotSelection(request), true);
  for (const v of [{ ...request, extra: true }, { ...request, expiresAt: NOW + 31_000 }, { ...request, slot: "codex-mac" }]) assert.equal(isClaudeSlotSelection(v), false);
  assert.equal(isClaudeSlotResult({ kind: "slot-selection", requestId: P, slot: "claude-mac", outcome: "assigned", revision: 1 }), true);
  assert.equal(isSlotAddressRequest({ slot: "kherep-lead", requestId: P }), true);
  assert.equal(isSlotAddressRequest({ slot: "kherep-lead", requestId: P, text: "peer" }), false);
  const result = { kind: "slot-address", slot: "kherep-lead", requestId: P, address: { nodeId: N, session: S } };
  assert.equal(isSlotAddressResult(result), true);
  assert.equal(isSlotAddressResult({ ...result, error: "unavailable" }), false);
});

test("first absent actor joins full UNKNOWN population through cached passive source, retaining other rows and markers", async t => {
  const { paths } = fixture(t); let now = NOW;
  const map = connectionClaudeHooks(paths); map.set(S, { sessionId: S, observedAt: NOW });
  const source = () => {
    const rows: SessionInfo[] = [{ sessionId: OTHER, runtime: "codex", state: "unknown", title: "Unrelated" }];
    markUnseen(rows, ["claude-code"]);
    return attachLiveness(rows, { status: "unknown", source: "unsupported", complete: false, observedAt: NOW, reasonCode: "unsupported" });
  };
  const collect = recordingSessions(paths, async () => source(), () => {}, () => now);
  const first = await collect();
  assert.equal(first.find(s => s.sessionId === S)?.state, "reachable-probable");
  assert.equal(first.find(s => s.sessionId === OTHER)?.title, "Unrelated");
  assert.deepEqual(unlistedRuntimes(first), ["claude-code"]);
  now += 1_000; await collect();
  assert.equal(sessionVerdict(paths, { runtime: "claude-code", sessionId: S }, now).observedAt, NOW);
  now += 60_000; await collect();
  assert.equal(sessionVerdict(paths, { runtime: "claude-code", sessionId: S }, now).state, "unknown");
  assert.equal(map.size, 0);
});

test("duplicate, child, cap ambiguity and persisted terminal state veto current hook source", async t => {
  for (const fault of ["duplicate", "child", "cap", "terminal"]) {
    const { paths } = fixture(t);
    const hooks = connectionClaudeHooks(paths); hooks.set(S, { sessionId: S, observedAt: NOW });
    let rows: SessionInfo[] = [{ runtime: "claude-code", sessionId: S, state: "unknown", ...(fault === "child" ? { kind: "subagent" } : {}) }];
    if (fault === "duplicate") rows.push({ ...rows[0] });
    if (fault === "cap") markUnseen(rows, ["*"]);
    if (fault === "terminal") {
      fs.writeFileSync(path.join(paths.dir, "session-liveness.json"), JSON.stringify({ version: 1, generation: 1,
        sessions: [{ runtime: "claude-code", sessionId: S, state: "deleted", reasonCode: "observed", observedAt: NOW, lifecycleGeneration: 1 }],
        tombstones: [{ runtime: "claude-code", sessionId: S, state: "deleted", generation: 1, observedAt: NOW }] }));
    }
    rows = attachLiveness(rows, { status: "unknown", source: "unsupported", complete: false, observedAt: NOW, reasonCode: "unsupported" });
    await recordingSessions(paths, async () => rows, () => {}, () => NOW)();
    assert.notEqual(sessionVerdict(paths, { runtime: "claude-code", sessionId: S }, NOW).state, "reachable-probable", fault);
  }
});

test("actual staged stable hook accepts forged same-UID stdin and reports only correlated expansion context", async t => {
  if (!["darwin", "win32"].includes(process.platform)) return t.skip("platform seats are macOS/Windows only");
  const { root, paths } = fixture(t);
  const dir = path.join(root, "staged"); fs.mkdirSync(dir);
  const entry = path.join(dir, "claude-control-plane-hook.mts");
  const repo = path.resolve(import.meta.dirname, "../../..");
  fs.copyFileSync(path.join(repo, "claude/kherep/control-plane/claude-control-plane-hook.mts"), entry);
  fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify({ version: 1, root: repo, kind: "checkout", verified: true }));
  const child = spawn(process.execPath, [entry, "deliver"], { env: { ...process.env, KHEREP_CONFIG_DIR: root }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = ""; let error = ""; child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { error += d; });
  const done = new Promise<number | null>(resolve => child.on("exit", resolve));
  child.stdin.end(JSON.stringify(native(process.platform === "darwin" ? "claude-mac" : "claude-windows")));
  const requests: NonNullable<ReturnType<typeof parseClaudeSlotCommand>>[] = [];
  for (let i = 0; i < 100 && requests.length === 0; i++) {
    const dir = path.join(paths.dir, "slot-exchange");
    for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!/^selection-[0-9a-f-]{36}\.json$/.test(file)) continue;
      const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (isClaudeSlotSelection(value)) requests.push(value);
    }
    if (!requests.length) await new Promise(resolve => setTimeout(resolve, 20));
  }
  const request = requests[0];
  assert.ok(request, `actual stable hook must enqueue typed native command: ${error}`);
  writeSlotExchange(paths, "selection-result", request.requestId, { kind: "slot-selection", requestId: request.requestId, slot: request.slot, outcome: "assigned", revision: 7 });
  assert.equal(await done, 0, error);
  assert.deepEqual(JSON.parse(output), { hookSpecificOutput: { hookEventName: "UserPromptExpansion",
    additionalContext: `Kherep assigned ${request.slot} at revision 7.` } });
});

async function cli(t: TestContext, reply: (request: { slot: string; requestId: string }) => unknown, target = "kherep-lead") {
  const { paths } = fixture(t);
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: N, name: "synthetic", publicKey: "synthetic",
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(NOW).toISOString() });
  // A poisoned nickname cannot override a fixed slot lookup.
  writeDirectory(paths, { nodes: [{ nodeId: OTHER, name: "kherep-lead", status: "online" }], sessions: [], fetchedAt: new Date(NOW).toISOString() });
  const messages: string[] = []; let looked = 0;
  const code = await runMsg(["send", target, "--", "synthetic text"], { paths, env: { CLAUDE_CODE_SESSION_ID: S }, now: () => NOW,
    out: () => {}, err: s => messages.push(s), sleep: async () => {
      for (const file of fs.readdirSync(path.join(paths.dir, "slot-exchange"))) {
        if (!file.startsWith("address-")) continue;
        const request: unknown = JSON.parse(fs.readFileSync(path.join(paths.dir, "slot-exchange", file), "utf8"));
        if (!isSlotAddressRequest(request)) continue;
        looked++; writeSlotExchange(paths, "address-result", request.requestId, reply(request));
      }
    } });
  const outbox = fs.existsSync(paths.outbox) ? fs.readdirSync(paths.outbox).map(file => getOutbox(paths, file.slice(0, -5))) : [];
  return { code, looked, outbox, messages, paths };
}

test("CLI role alias writes one ordinary literal-address message, never a nickname or second alias", async t => {
  const result = await cli(t, request => ({ ...request, kind: "slot-address", address: { nodeId: N, session: OTHER } }));
  assert.equal(result.code, 0, result.messages.join("\n")); assert.equal(result.looked, 1); assert.equal(result.outbox.length, 1);
  assert.deepEqual(result.outbox[0]?.to, { nodeId: N, session: OTHER });
  assert.equal(result.outbox[0]?.text, "synthetic text");
  assert.equal(Object.hasOwn(result.outbox[0]!, "slot"), false);
});

test("vacant lookup enqueues zero messages and --new fixed slot refuses before directory lookup", async t => {
  const result = await cli(t, request => ({ ...request, kind: "slot-address", error: "unavailable" }));
  assert.equal(result.code, 1); assert.equal(result.outbox.length, 0);
  const { paths } = fixture(t); const errors: string[] = [];
  assert.equal(await runMsg(["send", "kherep-lead", "--new", "claude", "--directive", "synthetic", "--", "text"], {
    paths, env: {}, out: () => {}, err: s => errors.push(s) }), 1);
  assert.match(errors.join(""), /cannot target a fixed slot/);
  assert.equal(fs.existsSync(paths.outbox), false);
});


import { NodeClient, type ClientOptions } from "./client.mts";
import { startDaemon } from "./daemon.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { EXCHANGE_INTERVAL_MS, pollExchange } from "./exchange.mts";
import { DEFAULT_POLICY } from "./policy.mts";

function clientOptions(extra: Partial<ClientOptions> = {}): ClientOptions {
  return { nodeId: N, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "synthetic.example", os: "darwin", arch: "arm64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...extra };
}

test("client accepts only current matching directory lookup, never caches slot-address or leaks stale replies", async () => {
  const got: unknown[] = []; let caches = 0;
  const client = new NodeClient(clientOptions({ slotAddressResult: b => got.push(b), storeDirectory: () => { caches++; } }));
  client.authenticated = true;
  client.slotAddressRequest({ slot: "kherep-lead", requestId: P });
  const result = { kind: "slot-address", slot: "kherep-lead", requestId: P, address: { nodeId: N, session: S } };
  for (const bad of [{ ...result, nodes: [], sessions: [], fetchedAt: new Date(NOW).toISOString() }, { ...result, requestId: OTHER }, { ...result, slot: "codex-mac" }, { ...result, error: "unavailable" }]) {
    await client.onFrame(JSON.stringify(makeEnvelope("directory", bad, 1, 0)));
  }
  assert.equal(got.length, 0); assert.equal(caches, 0);
  await client.onFrame(JSON.stringify(makeEnvelope("directory", result, 1, 0)));
  assert.deepEqual(got, [result]); assert.equal(caches, 0);
  client.slotAddressRequest({ slot: "kherep-lead", requestId: OTHER }); client.connectionClosed(); client.authenticated = true;
  await client.onFrame(JSON.stringify(makeEnvelope("directory", { ...result, requestId: OTHER }, 1, 0)));
  assert.equal(got.length, 1);
});

test("normal daemon factory publishes the first absent actor without injected liveness, and socket loss cancels a delayed source", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("synthetic runtime absent", { status: 404 }));
  const { root, paths } = fixture(t); const identity = generateIdentity(); writePrivateKey(paths.privateKey, identity);
  const config = { version: 1 as const, controlUrl: "https://control.example.invalid", nodeId: N, name: "synthetic", publicKey: identity.publicKey,
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() }; writeConfig(paths.config, config);
  // A source-only fixture, no user runtime or liveness adapter. The daemon
  // constructs its ordinary unsupported passive source and records the hook.
  const originals = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval };
  const listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
  const timers = new Map<number, () => void>(); const frames: Record<string, unknown>[] = [];
  class SyntheticSocket {
    static OPEN = 1; readyState = 1;
    addEventListener(name: string, cb: (event: { data?: string; code?: number }) => void) { listeners.set(name, cb); }
    send(raw: string) { const value: unknown = JSON.parse(raw); if (value && typeof value === "object") frames.push(value as Record<string, unknown>); }
    close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: SyntheticSocket });
  globalThis.setInterval = ((cb: () => void, ms: number) => { timers.set(ms, cb); return { interval: ms }; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let release: (() => void) | undefined; let delay = false; let calls = 0;
  const handle = startDaemon(config, paths, () => {}, async () => {
    calls++; if (delay) await new Promise<void>(resolve => { release = resolve; });
    return [{ sessionId: OTHER, runtime: "codex", state: "unknown", title: "Untouched" }];
  }, async () => ({ ok: true }));
  t.after(async () => {
    release?.(); handle.stop(); await handle.done;
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originals.socket });
    globalThis.setInterval = originals.interval; globalThis.clearInterval = originals.clear;
  });
  const waitFor = async (test: () => boolean) => {
    for (let i = 0; i < 500 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(test(), "normal daemon milestone reached");
  };
  listeners.get("open")?.({});
  listeners.get("message")?.({ data: JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)) });
  await waitFor(() => frames.some(f => f.type === "sessions.snapshot"));
  frames.length = 0;
  const request = parseClaudeSlotCommand(native(), "darwin", Date.now())!;
  writeSlotExchange(paths, "selection", request.requestId, request);
  timers.get(EXCHANGE_INTERVAL_MS)!();
  await waitFor(() => frames.some(f => (f.body as { slotSelection?: unknown })?.slotSelection));
  const body = frames.find(f => (f.body as { slotSelection?: unknown })?.slotSelection)!.body as { sessions: SessionInfo[]; identitySnapshot: { generation: number } };
  assert.equal(body.sessions.find(r => r.sessionId === S)?.state, "reachable-probable");
  assert.equal(body.sessions.find(r => r.sessionId === OTHER)?.title, "Untouched");
  assert.ok(body.identitySnapshot.generation > 0); assert.ok(calls >= 2);
  frames.length = 0; delay = true;
  const second = { ...request, requestId: crypto.randomUUID(), promptId: crypto.randomUUID() };
  writeSlotExchange(paths, "selection", second.requestId, second);
  timers.get(EXCHANGE_INTERVAL_MS)!(); await waitFor(() => release !== undefined);
  handle.stop(); release?.(); await handle.done;
  assert.equal(frames.some(f => (f.body as { slotSelection?: unknown })?.slotSelection), false);
});


test("wrong/stale correlated CLI reply times out visibly with zero ordinary message enqueue", async t => {
  let clock = NOW; t.mock.method(Date, "now", () => clock += 2_000);
  const result = await cli(t, request => ({ ...request, kind: "slot-address", requestId: OTHER, address: { nodeId: N, session: S } }));
  assert.equal(result.code, 1); assert.equal(result.outbox.length, 0);
  assert.match(result.messages.join(""), /lookup unconfirmed/);
});


test("current hook never mutates the cached passive observation or survives connection source removal", async t => {
  const { paths } = fixture(t); const hooks = connectionClaudeHooks(paths); hooks.set(S, { sessionId: S, observedAt: NOW });
  const passive = { runtime: "claude-code", sessionId: S, app: { status: "unknown" as const, source: "unsupported" as const,
    complete: false as const, observedAt: NOW, reasonCode: "unsupported" as const } };
  const collect = recordingSessions(paths, async () => attachLiveness([{ sessionId: S, runtime: "claude-code", state: "unknown" }], {
    status: "value", source: "native-app", complete: true, reasonCode: "observed", observedAt: NOW, value: [passive] }), () => {}, () => NOW);
  assert.equal((await collect())[0]?.state, "reachable-probable");
  assert.equal(Object.hasOwn(passive, "hook"), false, "cached passive source is immutable");
  hooks.clear(); assert.equal((await collect())[0]?.state, "unknown");
});


// Lead-directed scope: native once-per-prompt/resume behavior is UNKNOWN.
// These tests distinguish exact stored transport bytes from same-UID fabrication.
{
const S = "77777777-7777-4777-8777-777777777777";
const A = "88888888-8888-4888-8888-888888888888";
const B = "99999999-9999-4999-8999-999999999999";
const C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T0 = 1_800_000_000_000;
const { FakeClock } = await import("./connection-test-fixture.mts");
const { readPrivateKey } = await import("./identity.mts");
const { defaultServiceOwnerProbe } = await import("./service-owner-probe.mts");
const { SESSIONS_INTERVAL_MS } = await import("./daemon.mts");
const flush = async () => { for (let i=0;i<40;i++) await new Promise<void>(resolve=>setImmediate(resolve)); };
type Selection = NonNullable<ReturnType<typeof parseClaudeSlotCommand>>;
type Frame = { type: string; body: { sessions?: SessionInfo[]; slotSelection?: Selection } };
async function lifetimeDaemon(t:TestContext, options:{root?:string;keep?:boolean;persistHistory?:boolean;auditEnabled?:boolean}={}) {
 const root=options.root??fs.mkdtempSync(path.join(os.tmpdir(),"kherep-lifetime-"));const paths=nodePaths(root);fs.mkdirSync(paths.dir,{recursive:true});
 const exists=fs.existsSync(paths.privateKey);const identity=exists?readPrivateKey(paths.privateKey):generateIdentity();if(!exists)writePrivateKey(paths.privateKey,identity);
 const config={version:1 as const,controlUrl:"https://control.example.invalid",nodeId:N,name:"synthetic",publicKey:identity.publicKey,privateKeyFile:paths.privateKey,policyFile:paths.policy,enrolledAt:new Date(0).toISOString()};
 writeConfig(paths.config,config);fs.writeFileSync(paths.policy,JSON.stringify({version:1,allowedCommands:[],wake:{enabled:true,sessions:["*"]}}));
 let now=T0;t.mock.method(Date,"now",()=>now);t.mock.method(os,"homedir",()=>root);t.mock.method(os,"hostname",()=>"synthetic.example.invalid");t.mock.method(globalThis,"fetch",async()=>{throw new Error("synthetic endpoint unavailable");});
 t.mock.method(defaultServiceOwnerProbe,"current",()=>({version:1 as const,pid:process.pid,startedAt:"2026-01-01T00:00:00.000Z",owner:"synthetic-owner"}));
 const historyFile=path.join(root,"synthetic-history.json");
 const history=new Map<string,{slot:string;revision:number}>(options.persistHistory&&fs.existsSync(historyFile)?JSON.parse(fs.readFileSync(historyFile,"utf8")):[]);
 let auditEnabled=options.auditEnabled??true;
 const intervals=new Map<number,(()=>void)[]>(),sockets:Socket[]=[];const clock=new FakeClock();
 const original={socket:globalThis.WebSocket,interval:globalThis.setInterval,clear:globalThis.clearInterval,frame:NodeClient.prototype.onFrame};let client:NodeClient|undefined;
 t.mock.method(NodeClient.prototype,"onFrame",function(this:NodeClient,...args:Parameters<typeof original.frame>){client=this;return original.frame.apply(this,args);});
 class Socket {
  static OPEN=1;readyState=0;sent:Frame[]=[];listeners=new Map<string,(event:{data?:string;code?:number})=>void>();
  constructor(){sockets.push(this);}
  addEventListener(name:string,fn:(event:{data?:string;code?:number})=>void){this.listeners.set(name,fn);}
  open(){this.readyState=1;this.listeners.get("open")?.({});}
  receive(body:Record<string,unknown>){this.listeners.get("message")?.({data:JSON.stringify(makeEnvelope("event",body,0,0))});}
  send(raw:string){const parsed=JSON.parse(raw) as Frame;if(!parsed.type)return;this.sent.push(parsed);const request=parsed.body?.slotSelection;
   if(parsed.type==="sessions.snapshot"&&request&&auditEnabled){const key=JSON.stringify([request.sessionId,request.promptId]);const prior=history.get(key);if(!prior){history.set(key,{slot:request.slot,revision:1});if(options.persistHistory)fs.writeFileSync(historyFile,JSON.stringify([...history]));}
    queueMicrotask(()=>this.receive({kind:"slot-selection",requestId:request.requestId,slot:request.slot,outcome:prior&&prior.slot!==request.slot?"denied":"assigned",revision:prior&&prior.slot!==request.slot?null:1}));}
  }
  close(code=1000){this.readyState=3;this.listeners.get("close")?.({code});}
 }
 Object.defineProperty(globalThis,"WebSocket",{configurable:true,writable:true,value:Socket});
 globalThis.setInterval=((fn:()=>void,ms:number)=>{intervals.set(ms,[...(intervals.get(ms)??[]),fn]);return {unref(){}};}) as unknown as typeof setInterval;
 globalThis.clearInterval=(()=>{}) as typeof clearInterval;
 const handle=startDaemon(config,paths,()=>{},async()=>[{sessionId:OTHER,runtime:"codex",state:"unknown",title:"Unrelated"}],async()=>({ok:true}),undefined,{}, {fallbackMs:2_000_000},undefined,clock);
 t.after(async()=>{handle.stop();await handle.done;Object.defineProperty(globalThis,"WebSocket",{configurable:true,writable:true,value:original.socket});globalThis.setInterval=original.interval;globalThis.clearInterval=original.clear;if(!options.keep)fs.rmSync(root,{recursive:true,force:true});});
 const auth=async()=>{const next=sockets.at(-1)!;next.open();next.receive({name:"auth.ok"});await flush();return next;};let socket=await auth();
 const parse=(promptId:string,at:number,slot="claude-mac")=>parseClaudeSlotCommand({hook_event_name:"UserPromptExpansion",expansion_type:"slash_command",command_name:"kherep-slot",command_args:slot,prompt:`/kherep-slot ${slot}`,session_id:S,prompt_id:promptId},"darwin",T0+at)!;
 const bytes=(selection:Selection)=>JSON.stringify(selection);
 const submit=async(written:string,at:number)=>{now=T0+at;const request=JSON.parse(written) as Selection;const before=socket.sent.length;
  fs.mkdirSync(path.join(paths.dir,"slot-exchange"),{recursive:true});fs.writeFileSync(slotExchangeFile(paths,"selection",request.requestId),written);fs.rmSync(slotExchangeFile(paths,"selection-result",request.requestId),{force:true});
  for(const tick of intervals.get(EXCHANGE_INTERVAL_MS)??[])tick();await flush();return socket.sent.slice(before).filter(f=>f.type==="sessions.snapshot"&&f.body.slotSelection);
 };
 const ordinary=async(at:number)=>{now=T0+at;const before=socket.sent.length;for(const tick of intervals.get(SESSIONS_INTERVAL_MS)??[])tick();await flush();const frame=socket.sent.slice(before).filter(f=>f.type==="sessions.snapshot"&&!f.body.slotSelection).at(-1);assert.ok(frame,"normal full snapshot published");assert.equal(frame.body.sessions?.find(r=>r.sessionId===OTHER)?.title,"Unrelated");return {actor:frame.body.sessions?.find(r=>r.sessionId===S),verdict:sessionVerdict(paths,{runtime:"claude-code",sessionId:S},now)};};
 const reconnect=async()=>{socket.close(1006);await flush();clock.advance(10_000);await flush();assert.equal(sockets.length,2);socket=await auth();};
 return {root,paths,parse,bytes,submit,ordinary,reconnect,history,setAuditEnabled:(enabled:boolean)=>{auditEnabled=enabled;},setTime:(at:number)=>{now=T0+at;},record:(request:Selection)=>{assert.ok(client);return (client as unknown as {options:ClientOptions}).options.recordClaudeHook!(request);}};
}
test("immutable written A retries at20s retain ingress time, transport expires30s and source expires60s",async t=>{
 const f=await lifetimeDaemon(t);const written=f.bytes(f.parse(A,0));assert.equal((await f.submit(written,0)).length,1);assert.equal((await f.submit(written,20_000)).length,1);
 assert.equal((await f.ordinary(20_001)).verdict.observedAt,T0);assert.equal((await f.submit(written,30_001)).length,0);
 const final=await f.ordinary(60_001);assert.equal(final.actor?.state,"unknown");assert.equal(final.verdict.state,"unknown");
});
test("expired first unaudited gesture refuses refreshed same-prompt observation",async t=>{
 const f=await lifetimeDaemon(t,{auditEnabled:false});const first=f.parse(A,0);
 assert.equal((await f.submit(f.bytes(first),0)).length,1);assert.equal(f.history.size,0,"first publication has no Worker receipt");
 f.setAuditEnabled(true);const retry=f.parse(A,31_000);
 assert.equal((await f.submit(f.bytes(retry),31_000)).length,0,"refreshed observation must not revive the expired first gesture");
 assert.equal(f.history.size,0,"expired gesture cannot create a later assignment");
 assert.equal((await f.ordinary(60_001)).verdict.state,"unknown");
});
test("first unaudited expiry cannot be extended while retaining original observation",async t=>{
 const f=await lifetimeDaemon(t,{auditEnabled:false});const first={...f.parse(A,0),expiresAt:T0+10_000};
 assert.equal((await f.submit(f.bytes(first),0)).length,1);assert.equal(f.history.size,0);
 f.setAuditEnabled(true);const retry={...first,requestId:f.parse(A,0).requestId,expiresAt:T0+30_000};
 assert.equal((await f.submit(f.bytes(retry),20_000)).length,0,"extended expiry must not reopen the first validity window");
 assert.equal(f.history.size,0,"extension cannot create a later assignment");
});
test("unchanged unaudited retry remains valid only inside its original window",async t=>{
 const f=await lifetimeDaemon(t,{auditEnabled:false});const first={...f.parse(A,0),expiresAt:T0+10_000};const written=f.bytes(first);
 assert.equal((await f.submit(written,0)).length,1);assert.equal(f.history.size,0);
 f.setAuditEnabled(true);assert.equal((await f.submit(written,9_999)).length,1);assert.equal(f.history.size,1);
 assert.equal((await f.ordinary(9_999)).verdict.observedAt,T0);assert.equal((await f.submit(written,10_000)).length,0);assert.equal(f.history.size,1);
});
test("immutable A0 B10s A20s preserves original B time and genuinely new C works",async t=>{
 const f=await lifetimeDaemon(t);const written=f.bytes(f.parse(A,0));await f.submit(written,0);await f.submit(f.bytes(f.parse(B,10_000)),10_000);await f.submit(written,20_000);
 assert.equal((await f.ordinary(20_001)).verdict.observedAt,T0+10_000);assert.equal((await f.ordinary(70_001)).verdict.state,"unknown");
 await f.submit(f.bytes(f.parse(C,71_000)),71_000);assert.equal((await f.ordinary(71_001)).verdict.observedAt,T0+71_000);
});
test("same-daemon reconnect never reinserts cleared source from original valid bytes",async t=>{
 const f=await lifetimeDaemon(t);const written=f.bytes(f.parse(A,0));await f.submit(written,0);await f.reconnect();assert.equal((await f.submit(written,20_000)).length,0);
 const final=await f.ordinary(20_001);assert.equal(final.actor?.state,"unknown");assert.equal(final.verdict.state,"unknown");
});
test("same-runtime newly fabricated timestamp cannot renew copied prompt; changed args refuse before publication",async t=>{
 const f=await lifetimeDaemon(t);await f.submit(f.bytes(f.parse(A,0)),0);
 await f.submit(f.bytes(f.parse(A,20_000)),20_000);assert.equal((await f.ordinary(20_001)).verdict.observedAt,T0);
 assert.equal((await f.submit(f.bytes(f.parse(A,21_000,"kherep-lead")),21_000)).length,0);assert.equal((await f.ordinary(60_001)).verdict.state,"unknown");
});
test("daemon lifetime cap denies unseen gestures without eviction while duplicates keep their original time",async t=>{
 const f=await lifetimeDaemon(t);for(let i=0;i<4096;i++)assert.equal(f.record(f.parse(`00000000-0000-4000-8000-${i.toString(16).padStart(12,"0")}`,0)),true);
 assert.equal(f.record(f.parse(A,0)),false);f.setTime(20_000);assert.equal(f.record(f.parse("00000000-0000-4000-8000-000000000000",0)),true);
 assert.equal((await f.ordinary(20_001)).verdict.observedAt,T0);
});
test("minimal lifetime restart child",async t=>{
 const phase=process.env.KHEREP_MINIMAL_PHASE;if(!phase)return t.skip("subprocess fixture only");const mode=process.env.KHEREP_MINIMAL_MODE!,root=process.env.KHEREP_MINIMAL_ROOT!;
 const f=await lifetimeDaemon(t,{root,keep:true,persistHistory:true});const file=path.join(root,"original-event.json");
 if(phase==="first"){const written=f.bytes(f.parse(A,0));fs.writeFileSync(file,written);await f.submit(written,0);assert.equal(f.history.size,1);return;}
 const original=fs.readFileSync(file,"utf8");
 if(mode==="original20"){assert.equal((await f.submit(original,20_000)).length,1);assert.equal((await f.ordinary(20_001)).verdict.observedAt,T0);assert.equal((await f.ordinary(60_001)).verdict.state,"unknown");}
 else if(mode==="expired31"){assert.equal((await f.submit(original,31_000)).length,0);assert.equal((await f.ordinary(60_001)).verdict.state,"unknown");}
 else {assert.equal((await f.submit(f.bytes(f.parse(A,59_000)),59_000)).length,1);assert.equal((await f.ordinary(61_001)).verdict.observedAt,T0+59_000);assert.equal(f.history.size,1,"fixture retained stable event prevents another synthetic role mutation");}
});
test("actual process restart accepts original time or rejects expired original bytes; forged fresh same-UID input remains allowed",t=>{
 for(const mode of ["original20","expired31","forged59"]){const root=fs.mkdtempSync(path.join(os.tmpdir(),"kherep-minimal-restart-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const phase of ["first","second"]){const env={...process.env};delete env.NODE_TEST_CONTEXT;const child=spawnSync(process.execPath,["--test","--test-name-pattern=^minimal lifetime restart child$",import.meta.filename],{encoding:"utf8",env:{...env,KHEREP_MINIMAL_PHASE:phase,KHEREP_MINIMAL_MODE:mode,KHEREP_MINIMAL_ROOT:root},timeout:15_000});assert.equal(child.status,0,`${mode}/${phase}: ${child.stdout} ${child.stderr}`);assert.match(child.stdout,/pass 1(?:\r?\n|$)/);}
 }
});
}


// All exchanges are isolated. The clock advances only through the hook's real waits.
async function slotOutcome(t: TestContext, options: {
  result?: (request: NonNullable<ReturnType<typeof parseClaudeSlotCommand>>) => unknown;
  fault?: "setup" | "write" | "read" | "cleanup" | "dependencies";
  input?: unknown;
} = {}) {
  const { root, paths } = fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  let clock = NOW;
  let selections = 0;
  const cleanup: string[] = [];
  const original = { rename: fs.renameSync, read: fs.readFileSync, write: fs.writeFileSync, mkdir: fs.mkdirSync, rm: fs.rmSync };
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms = 0) => {
    clock += ms; queueMicrotask(callback); return {};
  }) as unknown as typeof setTimeout);
  t.mock.method(fs, "renameSync", (...args: unknown[]) => {
    Reflect.apply(original.rename, fs, args);
    const destination = String(args[1]);
    if (/[/\\]selection-[a-f0-9-]{36}\.json$/.test(destination)) {
      selections++;
      const request = JSON.parse(original.read(destination, "utf8")) as NonNullable<ReturnType<typeof parseClaudeSlotCommand>>;
      if (options.result) writeSlotExchange(paths, "selection-result", request.requestId, options.result(request));
    }
  });
  t.mock.method(fs, "mkdirSync", (...args: unknown[]) => {
    if (options.fault === "setup" && String(args[0]).endsWith("slot-exchange")) throw new Error("SYNTHETIC_PRIVATE_SETUP");
    return Reflect.apply(original.mkdir, fs, args);
  });
  t.mock.method(fs, "writeFileSync", (...args: unknown[]) => {
    if (options.fault === "write" && String(args[0]).includes("slot-exchange")) throw new Error("SYNTHETIC_PRIVATE_WRITE");
    return Reflect.apply(original.write, fs, args);
  });
  t.mock.method(fs, "readFileSync", (...args: unknown[]) => {
    if (options.fault === "read" && String(args[0]).includes("selection-result-")) throw new Error("SYNTHETIC_PRIVATE_READ");
    return Reflect.apply(original.read, fs, args);
  });
  t.mock.method(fs, "rmSync", (...args: unknown[]) => {
    if (/[/\\]selection(?:-result)?-[a-f0-9-]{36}\.json$/.test(String(args[0]))) {
      cleanup.push(path.basename(String(args[0])));
      if (options.fault === "cleanup") throw new Error("SYNTHETIC_PRIVATE_CLEANUP");
    }
    return Reflect.apply(original.rm, fs, args);
  });
  try {
    const deps = options.fault === "dependencies" ? { get paths(): typeof paths { throw new Error("SYNTHETIC_PRIVATE_DEPENDENCIES"); } } : { paths };
    const output = await runClaudeSlotHook(options.input ?? native("kherep-lead"), deps);
    assert.doesNotMatch(output, /SYNTHETIC_PRIVATE|requestId|promptId|sessionId|decision|reason/);
    return { root, paths, output, selections, cleanup, elapsed: clock - NOW };
  } finally {
    t.mock.reset();
    Object.defineProperty(process, "platform", platform);
  }
}

function expansion(sentence: string) {
  return { hookSpecificOutput: { hookEventName: "UserPromptExpansion", additionalContext: sentence } };
}
const selected = (request: NonNullable<ReturnType<typeof parseClaudeSlotCommand>>) =>
  ({ kind: "slot-selection", requestId: request.requestId, slot: request.slot, outcome: "assigned", revision: 7 });

test("slot outcomes use only correlated protocol dispositions and trustworthy revisions", async t => {
  const cases = [
    ["assigned", 7, "Kherep assigned kherep-lead at revision 7."],
    ["assigned", 0, "Kherep assigned kherep-lead at revision 0."],
    ["conflict", 8, "Kherep could not assign kherep-lead because its revision changed to 8."],
    ["denied", 9, "Kherep denied the kherep-lead selection (revision 9)."],
    ["denied", null, "Kherep denied the kherep-lead selection (revision unconfirmed)."],
    ["assigned", null, "Kherep could not confirm the kherep-lead selection."],
    ["conflict", null, "Kherep could not confirm the kherep-lead selection."],
  ] as const;
  for (const [outcome, revision, sentence] of cases) await t.test(`${outcome}/${revision}`, async t => {
    const run = await slotOutcome(t, { result: request => ({ ...selected(request), outcome, revision }) });
    assert.deepEqual(JSON.parse(run.output), expansion(sentence));
    assert.equal(run.selections, 1);
    assert.equal(run.cleanup.length, 2);
  });
});

test("unusable slot results and deadline never invent a confirmed selection", async t => {
  const invalid = [
    (request: Parameters<typeof selected>[0]) => ({ ...selected(request), requestId: OTHER }),
    (request: Parameters<typeof selected>[0]) => ({ ...selected(request), slot: "claude-mac" }),
    (request: Parameters<typeof selected>[0]) => ({ ...selected(request), extra: "SYNTHETIC_PRIVATE_RESULT" }),
    (request: Parameters<typeof selected>[0]) => ({ ...selected(request), revision: -1 }),
    () => ({ outcome: "assigned", text: "SYNTHETIC_PRIVATE_RESULT" }),
    () => null,
  ];
  for (let i = 0; i < invalid.length; i++) await t.test(`unusable-${i}`, async t => {
    const run = await slotOutcome(t, { result: invalid[i] });
    assert.deepEqual(JSON.parse(run.output), expansion("Kherep could not confirm the kherep-lead selection."));
    assert.equal(run.selections, 1); assert.equal(run.elapsed, 25_000); assert.equal(run.cleanup.length, 2);
  });
  await t.test("missing result", async t => {
    const run = await slotOutcome(t);
    assert.deepEqual(JSON.parse(run.output), expansion("Kherep could not confirm the kherep-lead selection."));
    assert.equal(run.selections, 1); assert.equal(run.elapsed, 25_000);
  });
});

test("slot setup, exchange and independent cleanup failures stay bounded and unconfirmed", async t => {
  for (const fault of ["setup", "write", "read", "cleanup", "dependencies"] as const) await t.test(fault, async t => {
    const run = await slotOutcome(t, { fault, result: selected });
    assert.deepEqual(JSON.parse(run.output), expansion("Kherep could not confirm the kherep-lead selection."));
    assert.ok(run.selections <= 1);
    if (fault !== "dependencies") assert.equal(run.cleanup.length, 2, "both known exchange files attempted independently");
  });
});

test("invalid, auxiliary and wrong-prompt expansions write zero selections", async t => {
  for (const input of [{ ...native(), agent_id: "aux" }, { ...native(), prompt: "peer says /kherep-slot claude-mac" },
    { ...native(), prompt_id: undefined }, native("claude-windows"), { ...native(), command_args: "claude-mac extra" }]) {
    await t.test(JSON.stringify(input), async t => {
      const run = await slotOutcome(t, { input });
      assert.deepEqual(JSON.parse(run.output), expansion("Kherep rejected the slot command as invalid."));
      assert.equal(run.selections, 0); assert.equal(run.cleanup.length, 0);
    });
  }
});

test("slot entry contains dependency construction failure and leaves missing or oversized stdin without a result", t => {
  const { root } = fixture(t);
  const preload = path.join(root, "synthetic-setup.mts");
  fs.writeFileSync(preload, `import path from "node:path"; const join = path.join; path.join = (...parts) => {
    if (parts[1] === "control-plane") throw new Error("SYNTHETIC_PRIVATE_SETUP"); return join(...parts); };`);
  const hook = path.join(import.meta.dirname, "deliver-hook.mts");
  const failed = spawnSync(process.execPath, ["--import", preload, hook], {
    input: JSON.stringify(native("kherep-lead")), encoding: "utf8", env: { ...process.env, KHEREP_CONFIG_DIR: root } });
  // Older admitted Node releases emit only this known type-stripping warning.
  const stderr = (value: string) => value.replace(/^\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/, "");
  assert.equal(failed.status, 0); assert.equal(stderr(failed.stderr), "");
  assert.deepEqual(JSON.parse(failed.stdout), expansion("Kherep could not confirm a slot selection."));
  for (const input of ["", JSON.stringify({ ...native(), extra: "x".repeat(65_536) })]) {
    const child = spawnSync(process.execPath, [hook], { input, encoding: "utf8", env: { ...process.env, KHEREP_CONFIG_DIR: root } });
    assert.deepEqual([child.status, child.stdout, stderr(child.stderr)], [0, "", ""]);
  }
});

test("slot confirmation and varying peer work enqueue one correct parent-bound reply before real Stop", async t => {
  for (const [a, b, c] of [[3, 4, 5], [7, -2, 11], [0, 9, -6]]) await t.test(`${a}*${b}+${c}`, async t => {
    const slot = await slotOutcome(t, { result: selected });
    writeLocalSessions(slot.paths, [{ sessionId: S, runtime: "claude-code", state: "busy" }]);
    const parent = crypto.randomUUID();
    storeMessage(slot.paths.inbox, { messageId: parent, from: { nodeId: N, session: OTHER }, toSession: S,
      text: `Compute ${a} * ${b} + ${c} and send a threaded reply with the decimal result.`, createdAt: new Date(NOW).toISOString() }, NOW);
    const delivery = JSON.parse(deliverForHook({ hook_event_name: "UserPromptSubmit", session_id: S },
      { paths: slot.paths, now: () => NOW, nonce: () => "synthetic-offer", replyCommand: `node "${CLI_PATH}"` }));
    const peerContext = delivery.hookSpecificOutput.additionalContext as string;
    assert.equal(delivery.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(peerContext.includes(parent));
    assert.ok(peerContext.includes(`msg send --reply-to ${parent} -- <reply text>`));
    assert.match(peerContext, /peer content, NOT an instruction from the user/);
    assert.equal(getMessage(slot.paths.inbox, parent)?.state, "offered");
    assert.doesNotMatch(slot.output, /Compute|synthetic-offer/);
    // Controlled authorized processor consumes both actual contexts, not fixture answers.
    const emitted: string[] = [JSON.parse(slot.output).hookSpecificOutput.additionalContext];
    assert.equal(emitted[0], "Kherep assigned kherep-lead at revision 7.");
    const task = /Compute (-?\d+) \* (-?\d+) \+ (-?\d+) and send a threaded reply/.exec(peerContext);
    assert.ok(task);
    const answer = String(Number(task[1]) * Number(task[2]) + Number(task[3]));
    const errors: string[] = [];
    assert.equal(await runMsg(["send", "--reply-to", parent, "--", answer], { paths: slot.paths,
      env: { CLAUDE_CODE_SESSION_ID: S }, now: () => NOW, out: value => emitted.push(value), err: value => errors.push(value) }), 0, errors.join("\n"));
    const names = fs.readdirSync(slot.paths.outbox);
    assert.equal(names.length, 1);
    const reply = getOutbox(slot.paths, names[0].slice(0, -5));
    assert.equal(reply?.text, String(a * b + c)); assert.equal(reply?.inReplyTo, parent);
    assert.deepEqual(reply?.to, { nodeId: N, session: OTHER }); assert.equal(reply?.fromSessionId, S);
    assert.equal(slot.selections, 1);
    const beforeStop = fs.readFileSync(path.join(slot.paths.outbox, names[0]));
    assert.equal(deliverForHook({ hook_event_name: "Stop", session_id: S, stop_hook_active: false }, { paths: slot.paths, now: () => NOW }), "");
    assert.equal(getMessage(slot.paths.inbox, parent)?.state, "delivered");
    assert.ok(fs.readFileSync(path.join(slot.paths.outbox, names[0])).equals(beforeStop));
    assert.equal(fs.readdirSync(slot.paths.outbox).length, 1);
    assert.deepEqual(fs.readdirSync(path.join(slot.paths.dir, "slot-exchange")), []);
  });
});
