import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBindingStorage } from "../../node/inbox-storage.mts";
import { digestMcpArguments } from "../../protocol-mcp.mts";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, vi } from "vitest";

import { makeEnvelope, parseEnvelope, type Envelope, type SessionInfo } from "../../protocol.mts";
import type { McpCredentialBody, McpInboxItem, McpIntentReceiptBody, McpRuntime } from "../../protocol-mcp.mts";
import { MESSAGING_CAPABILITY, type MessageDeliverBody } from "../../protocol-messages.mts";
import { NodeClient } from "../../node/client.mts";
import { nodePaths, type NodePaths } from "../../node/config.mts";
import { exchangeOptions, recordingSessions } from "../../node/exchange.mts";
import { generateIdentity } from "../../node/identity.mts";
import { createAdmissionAuthority } from "../../node/session-authority.mts";
import { syntheticListing } from "../../node/session-authority-fixture.mts";
import { storeMessage } from "../../node/inbox.mts";
import { DEFAULT_POLICY, type NodePolicy } from "../../node/policy.mts";
import { handleMcp } from "../src/mcp-http.mts";
import type { Env } from "../src/env.mts";
import { BASE, FACTS, authenticate, enroll, newKey, registry, workerFetch, type TestSocket } from "./helpers.mts";

// Issue #192 source-level fixture: one enrolled node with two Claude Code
// chats, wired as the daemon wires it (node/daemon.mts), so a native call runs
// the real trusted PreToolUse hook, the node intent exchange, the Registry and
// the stateless MCP HTTP handler. All identifiers are synthetic.
const WAIT = { timeout: 5_000, interval: 25 };
const enabledEnv = { ...env, REMOTE_MCP_ENABLED: "true" } as Env;
export const CHAT_A = "synthetic-chat-a";
export const CHAT_B = "synthetic-chat-b";
export const PEER_SESSION = "synthetic-peer";

// The worker typecheck resolves node/ sources against the Workers types, under
// which Buffer#toString(encoding) in the hook and credential reader does not
// compile; the root typecheck covers both modules with Node types. vitest loads
// them unchanged at runtime under nodejs_compat. These are their signatures.
interface HookModule {
  processMcpIntentHook(input: Record<string, unknown>, root: string, now: number, runtime: McpRuntime):
    Promise<HookOutput | null>;
}
export interface HookOutput {
  hookSpecificOutput: { hookEventName: "PreToolUse"; updatedInput?: Record<string, unknown>;
    permissionDecision?: "allow" | "deny"; permissionDecisionReason?: string };
}
interface LocalModule {
  enqueueMcpIntent(paths: NodePaths, body: unknown): void;
  hasMcpCredential(paths: NodePaths): boolean;
  recordMcpCredential(paths: NodePaths, body: McpCredentialBody): void;
  recordMcpIntentReceipt(paths: NodePaths, inflight: Set<string>, body: McpIntentReceiptBody): void;
  disableMcp(paths: NodePaths, inflight: Set<string>): void;
  readMcpInbox(paths: NodePaths, sessionId: string, limit: number, messageId?: string, runtime?: string, original?: boolean): McpInboxItem[];
  offerMcpInbox(paths: NodePaths, messageIds: string[], now?: number, owner?: {sessionId:string;runtime:string}, original?: boolean): void;
  answerMcpInbox(paths: NodePaths, messageIds: string[], owner?: {sessionId:string;runtime:string}, original?: boolean): void;
  pollMcpIntents(client: NodeClient, paths: NodePaths, inflight: Set<string>, send: (frame: string) => boolean): Promise<void>;
}
const runtimeOnly = (name: string): Promise<unknown> =>
  import(/* @vite-ignore */ new URL(`../../node/${name}.mts`, import.meta.url).href);

const POLICY: NodePolicy ={ ...DEFAULT_POLICY, remoteMcp: { enabled: true, claudeCode: true },
  messaging: { accept: [{ session: "*", from: ["*"] }] } };

export interface NativeNode {
  nodeId: string;
  root: string;
  paths: NodePaths;
  // Every frame the Worker sent to this node, in arrival order.
  received: Envelope[];
  // Every session the local MCP inbox reader was asked for.
  inboxReads: string[];
  hook(sessionId: string, toolUseId: string, tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  // The trusted hook's complete output for a raw native PreToolUse input.
  nativeHook(input: Record<string, unknown>, runtime?: McpRuntime): Promise<HookOutput | null>;
  externalNativeHook(input: Record<string, unknown>, runtime?: McpRuntime): Promise<HookOutput | null>;
  // Publishes the current session listing, as periodic publication does.
  publishSessions(): Promise<void>;
  // Replaces the daemon connection: a fresh client and in-memory state over the same node files.
  restart(): Promise<void>;
  offline(): Promise<void>;
  assign(sessionId: string, slot: "codex-mac" | "kherep-lead"): Promise<void>;
  mcp(): Promise<Client>;
  close(): Promise<void>;
}

// One shared test-only shim supports multiple synthetic nodes without nesting a spy on itself.
const ownedRoots = new Set<string>();
let restoreRename: (() => void) | undefined;
function trackSyntheticRoot(root: string): () => void {
  if (ownedRoots.size === 0) {
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if ([...ownedRoots].some((r) => String(to).startsWith(r + path.sep))) fs.utimesSync(to, new Date(), new Date());
    });
    restoreRename = () => spy.mockRestore();
  }
  ownedRoots.add(root);
  return () => { ownedRoots.delete(root); if (ownedRoots.size === 0) { restoreRename?.(); restoreRename = undefined; } };
}

// `sessions` is read on every listing, so a caller may change it in place.
export async function startNativeNode(name: string, sessions: SessionInfo[], originals: string[] = []): Promise<NativeNode> {
  const { processMcpIntentHook } = await runtimeOnly("mcp-intent-hook") as HookModule;
  const { enqueueMcpIntent, offerMcpInbox, answerMcpInbox, disableMcp, hasMcpCredential, pollMcpIntents, readMcpInbox, recordMcpCredential, recordMcpIntentReceipt } =
    await runtimeOnly("mcp-local") as LocalModule;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-two-chat-"));
  // The workerd test file system reports mtimeMs 0 for every file. The intent
  // exchange reads mtime as publication time, so 0 makes a fresh intent look
  // expired and lets one hook prune another's pending file. Stamp the current
  // time on each atomic publication under this root, as a real file system does.
  const releaseRename = trackSyntheticRoot(root);
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify(POLICY));
  const identity = generateIdentity();
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, name);
  const received: Envelope[] = [];
  const inboxReads: string[] = [];
  const authority = createAdmissionAuthority(paths);
  const list = recordingSessions(paths, async () => {
    const now = Date.now();
    const rows = [...sessions];
    return syntheticListing(authority, rows, rows.filter(row => row.state !== "unknown").map(({ runtime, sessionId }) => ({ runtime, sessionId,
      holder: { status: "value", value: { present: true, creationIdentity: "synthetic-holder" }, source: "native-holder", observedAt: now, complete: true, reasonCode: "observed" },
      turn: { status: "value", value: "running", source: "native-turn", observedAt: now, complete: true, reasonCode: "observed" },
    })), now);
  }, () => {}, undefined, undefined, undefined, authority);
  let inflight = new Set<string>();
  let syntheticAssignment: string | undefined;
  const storage = createBindingStorage(paths.inbox);
  let client: NodeClient;
  let ws: WebSocket;
  // One ordered lane for received frames and intent rounds, as in the daemon.
  let chain = Promise.resolve();
  const send = (frame: string): boolean => { ws.send(frame); return true; };
  const connect = async (): Promise<void> => {
    const current = new Set<string>();
    inflight = current;
    const connected = new NodeClient({
      nodeId, identity, policy: POLICY,
      handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": list },
      assignmentIdentity: async sessionId => originals.includes(sessionId)
        ? { sessionId, chatName: "Synthetic same title", platform: "darwin", originalMain: true } : null,
      facts: () => ({ ...FACTS, ...(originals.length ? { os: "darwin" } : {}) }), runtimes: async () => [{ name: "claude-code", kind: "cli" }], sessions: list,
      storeMessage: (body) => { storeMessage(paths.inbox, body); },
      mcpCredentialPresent: () => hasMcpCredential(paths),
      mcpCredential: (body) => recordMcpCredential(paths, body),
      mcpIntentReceipt: (body) => recordMcpIntentReceipt(paths, current, body),
      mcpDisabled: () => disableMcp(paths, current),
      readMcpInbox: (sessionId, limit, messageId, runtime, original) => { inboxReads.push(sessionId); return readMcpInbox(paths, sessionId, limit, messageId, runtime, original); },
      offerMcpInbox: (messageIds, sessionId, runtime, original) => { if (originals.length) offerMcpInbox(paths,messageIds,Date.now(),{sessionId,runtime},original); },
      answerMcpInbox: (messageIds, sessionId, runtime, original) => answerMcpInbox(paths, messageIds, {sessionId,runtime}, original),
      ...exchangeOptions(paths), bindingStorageReady: storage.snapshot, bindingStorageFault: storage.fault,
    });
    client = connected;
    const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
    const socket = response.webSocket!;
    ws = socket;
    socket.addEventListener("message", (event) => {
      const parsed = parseEnvelope(event.data as string);
      if (parsed.ok) received.push(parsed.envelope);
      if (parsed.ok && parsed.envelope.type === "mcp.lead.confirm.request" && (parsed.envelope.body as {requestId?:string}).requestId === syntheticAssignment) {
        // Synthetic native provider only: emulate a current exact nonce result.
        socket.send(JSON.stringify(makeEnvelope("mcp.lead.confirm.response", { nonce: (parsed.envelope.body as {nonce:string}).nonce, allowed: true }, 0, 0))); return;
      }
      chain = chain.then(async () => {
        for (const frame of await connected.onFrame(event.data as string)) socket.send(frame);
      });
    });
    socket.accept();
    try { await vi.waitFor(() => expect(connected.authenticated && hasMcpCredential(paths)).toBe(true), WAIT); }
    catch (cause) { throw new Error(`synthetic connection failed: authenticated=${connected.authenticated}; frameTypes=${received.map((f) => f.type).join(",")}`, { cause }); }
  };
  await connect();
  const token = (): string => (JSON.parse(fs.readFileSync(paths.mcpCredential, "utf8")) as { token: string }).token;

  const pump = (): void => { chain = chain.then(() => pollMcpIntents(client, paths, inflight, send)); };
  const nativeHook = async (input: Record<string, unknown>, runtime: McpRuntime = "claude-code") => {
    const timer = setInterval(pump, 25);
    try {
      return await processMcpIntentHook(input, root, Date.now(), runtime);
    } finally {
      clearInterval(timer);
    }
  };
  const clients: Client[] = [];
  return {
    nodeId, root, paths, received, inboxReads, nativeHook,
    async externalNativeHook(input, runtime = "codex") {
      const host = "http://127.0.0.1:47861";
      const started = await fetch(host+"/start",{method:"POST",body:JSON.stringify({input,runtime})});
      const {id} = await started.json() as {id:string};
      let published: string | null = null;
      try {
        const deadline = Date.now()+12_000;
        while (Date.now()<deadline) {
          const polled = await (await fetch(`${host}/poll?id=${id}`)).json() as {intent:{requestId:string}|null};
          if (polled.intent && published === null) {enqueueMcpIntent(paths,polled.intent);published=polled.intent.requestId;}
          pump();await chain;
          if (published) {
            const receiptFile=path.join(paths.mcpReceipts,published+".json");
            if (fs.existsSync(receiptFile)) {
              const receipt=JSON.parse(fs.readFileSync(receiptFile,"utf8"));fs.rmSync(receiptFile);
              await fetch(`${host}/receipt?id=${id}`,{method:"POST",body:JSON.stringify({receipt})});
            }
          }
          const result = await (await fetch(`${host}/result?id=${id}`)).json() as {done:boolean;code:number|null;output:HookOutput|null;error:string|null};
          if (result.done) {expect(result.code,result.error ?? "external hook exit").toBe(0);expect(result.error).toBeNull();return result.output;}
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error("external synthetic hook timed out");
      } finally {await fetch(`${host}/close?id=${id}`);}
    },
    async hook(sessionId, toolUseId, tool, input) {
      const output = await nativeHook({ hook_event_name: "PreToolUse", tool_name: `mcp__kherep_messaging__${tool}`,
        session_id: sessionId, tool_use_id: toolUseId, tool_input: input });
      const updated = output?.hookSpecificOutput.updatedInput;
      if (!updated) throw new Error(`hook denied: ${JSON.stringify(output)}`);
      return updated;
    },
    async publishSessions() {
      chain = chain.then(async () => { for (const frame of await client.sessionsSnapshot()) send(frame); });
      await chain;
    },
    async offline() { await chain; client.connectionClosed(); ws.close(1000, "synthetic offline"); },
    async assign(sessionId, slot) {
      // Real assignment Registry CAS and MCP callback; native evidence here is
      // deliberately synthetic, never a deployment or Director appointment.
      const requestId = crypto.randomUUID(), callId = crypto.randomUUID();
      const argumentsDigest = await digestMcpArguments({slot});
      const registration = { requestId, runtime: "codex" as const, sessionId, threadId: sessionId, callId, tool: "assign_self" as const, argumentsDigest,
        assignment: { slot, turnId: "synthetic-turn", native: {sessionId,chatName:"Synthetic same title",platform:"darwin" as const,originalMain:true as const,
          ...(slot === "kherep-lead" ? {leadGuardVersion:1 as const} : {})} } };
      expect((await registry().registerMcpIntent(nodeId, registration)).ok).toBe(true);
      syntheticAssignment = requestId;
      try {
        const instance = await (this as NativeNode).mcp();
        const response = await instance.callTool({name:"assign_self",arguments:{requestId,slot},_meta:{sessionId,threadId:sessionId,callId}});
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
      } finally { syntheticAssignment = undefined; }
    },
    async restart() {
      await chain;
      ws.close(1000, "restart");
      await connect();
    },
    async mcp() {
      const bearer = token();
      const instance = new Client({ name: "synthetic-claude-chat", version: "1.0.0" });
      await instance.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        authProvider: { token: async () => bearer }, fetch: (input, init) => handleMcp(new Request(input, init), enabledEnv),
      }));
      clients.push(instance);
      return instance;
    },
    async close() {
      for (const instance of clients) await instance.close();
      await chain;
      const closed = ws.readyState === 3 ? Promise.resolve() : new Promise<void>(resolve => ws.addEventListener("close", () => resolve(), { once: true }));
      ws.close(1000, "done");
      await closed;
      await chain;
      releaseRename();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// A raw authenticated peer node that accepts messages for one session.
export async function startPeer(): Promise<{ nodeId: string; socket: TestSocket }> {
  const key = await newKey();
  const nodeId = await enroll(key, "synthetic-peer");
  await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], [MESSAGING_CAPABILITY]);
  await registry().replaceSessions(nodeId, [{ sessionId: PEER_SESSION, runtime: "codex", state: "running" }]);
  return { nodeId, socket: await authenticate(nodeId, key) };
}

export function peerSend(socket: TestSocket, to: { nodeId: string; session: string }, text: string): string {
  const messageId = crypto.randomUUID();
  socket.send(makeEnvelope("message.send", { messageId, fromSession: PEER_SESSION, to, text }, 0, 0));
  return messageId;
}

// Collects message.deliver frames until `count` arrived, skipping other frames.
export async function delivered(socket: TestSocket, count: number): Promise<MessageDeliverBody[]> {
  const bodies: MessageDeliverBody[] = [];
  for (let frames = 0; bodies.length < count && frames < 32; frames++) {
    const envelope = await socket.next(WAIT.timeout);
    if (envelope.type === "message.deliver") bodies.push(envelope.body as MessageDeliverBody);
  }
  return bodies;
}

export function claudeMeta(toolUseId: string): Record<string, unknown> {
  return { "claudecode/toolUseId": toolUseId };
}

export function sessionsOf(...ids: string[]): SessionInfo[] {
  return ids.map((sessionId) => ({ sessionId, runtime: "claude-code", state: "busy", name: `${sessionId}-name` }));
}

export { WAIT };
