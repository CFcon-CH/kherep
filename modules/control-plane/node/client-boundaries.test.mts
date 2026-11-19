import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope, type MessageType } from "../protocol.mts";
import type { McpIntentRegistration } from "../protocol-mcp.mts";
import { NodeClient, type ClientOptions } from "./client.mts";
import { generateIdentity } from "./identity.mts";
import { readNativeMcpAssignment } from "./mcp-assignment.mts";
import { DEFAULT_POLICY } from "./policy.mts";

const nodeId = "00000000-0000-4000-8000-0000000000aa";
const sessionId = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const raw = (type: MessageType, body: object, seq = 0) => JSON.stringify(makeEnvelope(type, body, seq, 0));
const decode = (frames: string[]): Envelope[] => frames.map(frame => {
  const parsed = parseEnvelope(frame);
  assert.ok(parsed.ok);
  return parsed.envelope;
});

function fixture(extra: Partial<ClientOptions> = {}): NodeClient {
  return new NodeClient({ nodeId, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({ ready: true }), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "synthetic.example.invalid", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => assert.fail("unexpected message delivery"), ...extra });
}

test("slot address lookups preserve pending requests at capacity and ignore expired or replayed results", async () => {
  let now = 1_000;
  const results: unknown[] = [];
  const client = fixture({ now: () => now, slotAddressResult: body => results.push(body) });
  const request = (n: number) => ({ requestId: id(n), slot: "kherep-lead" as const });
  const result = (n: number) => ({ ...request(n), kind: "slot-address", address: { nodeId, session: sessionId } });

  assert.deepEqual(client.slotAddressRequest(request(0)), []);
  await client.onFrame(raw("event", { name: "auth.ok" }));
  for (let n = 0; n < 128; n++) assert.equal(client.slotAddressRequest(request(n)).length, 1);
  assert.deepEqual(client.slotAddressRequest(request(128)), []);

  await client.onFrame(raw("directory", result(0)));
  await client.onFrame(raw("directory", result(0)));
  assert.deepEqual(results, [result(0)]);
  assert.equal(client.slotAddressRequest(request(128)).length, 1);

  now += 10_000;
  await client.onFrame(raw("directory", result(1)));
  assert.deepEqual(results, [result(0)]);
  const [next] = decode(client.slotAddressRequest(request(129)));
  assert.equal(next?.type, "directory.get");
  assert.deepEqual(next?.body, request(129));
  await client.onFrame(raw("directory", result(129)));
  assert.deepEqual(results, [result(0), result(129)]);
});

test("task-control callback failure is logged and a subsequent command still receives a result", async () => {
  const events: string[] = [];
  const client = fixture({ taskControlExecute: async () => { throw new Error("synthetic storage failure"); },
    log: line => events.push(line) });
  await client.onFrame(raw("event", { name: "auth.ok" }));
  assert.deepEqual(await client.onFrame(raw("event", { name: "task.control.execute", operationId: id(1), requestId: id(2),
    taskId: id(3), action: "status", ownerNodeId: id(4), targetNodeId: nodeId, runtime: "codex",
    origin: { kind: "source-request", sourceRequestId: id(5) }, grantVersion: 1 })), []);
  assert.deepEqual(events, [`kherep-node: could not execute task control ${id(1)}: synthetic storage failure`]);
  const frames = decode(await client.onFrame(raw("command", { commandId: id(6), command: "node.status" }, 1)));
  assert.deepEqual(frames.map(frame => frame.type), ["command.ack", "command.result"]);
  assert.deepEqual(frames[1]?.body, { commandId: id(6), ok: true, result: { ready: true } });
});

test("an MCP snapshot is withheld when publication is cancelled or the connection closes after discovery", async () => {
  const client = fixture({ policy: { ...DEFAULT_POLICY, remoteMcp: { enabled: true } }, deferInitialSessions: true });
  const auth = raw("event", { name: "auth.ok" });
  await client.onFrame(auth);
  assert.equal(await client.sessionsBeforeMcpIntents(async () => false), null);
  assert.equal(await client.sessionsBeforeMcpIntents(async () => { client.connectionClosed(); return true; }), null);
  await client.onFrame(auth);
  const frames = await client.sessionsBeforeMcpIntents(async () => true);
  assert.ok(frames);
  const [snapshot] = decode(frames);
  assert.equal(snapshot?.type, "sessions.snapshot");
  assert.deepEqual(snapshot?.body, { sessions: [] });
});

test("Lead registration never publishes when either native identity read fails", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-client-lead-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const turnId = id(3), dir = path.join(home, "sessions", "2026", "11", "08");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-synthetic-${sessionId}.jsonl`), [
    { type: "session_meta", payload: { id: sessionId, originator: "Codex Desktop", source: "vscode" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId, root_turn_id: turnId,
      turn_attribution: { turn_id: turnId, turn_trigger: "user" } } },
    { type: "response_item", metadata: { user_input_order: 1 }, payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: "Du bist ab sofort Kherep-Lead." }], internal_chat_message_metadata_passthrough: {
        turn_id: turnId, content_item_kinds: ["user.text"], content_item_metadata: [{ provenance: { type: "user" } }],
      } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify({ id: sessionId, thread_name: "Synthetic Lead",
    updated_at: "2026-11-08T00:00:00.000Z" })}\n`);
  let reads = 0, failAt = 1;
  const client = fixture({ policy: { ...DEFAULT_POLICY, remoteMcp: { enabled: true } },
    sessions: async () => [{ sessionId, runtime: "codex", state: "running" }],
    assignmentIdentity: async (id, context) => {
      if (++reads === failAt) throw new Error("synthetic native source unavailable");
      return readNativeMcpAssignment(home, id, context);
    } });
  await client.onFrame(raw("event", { name: "auth.ok" }));
  const intent: McpIntentRegistration = { requestId: id(1), runtime: "codex", sessionId, threadId: sessionId,
    callId: id(2), tool: "assign_self", argumentsDigest: "a".repeat(64), assignment: { slot: "kherep-lead", turnId } };

  assert.deepEqual(await client.registerMcpAssignment(intent), []);
  assert.equal(reads, 1);
  failAt = 3;
  assert.deepEqual(await client.registerMcpAssignment(intent), []);
  assert.equal(reads, 3);
  const [registered] = decode(await client.registerMcpAssignment(intent));
  assert.equal(registered?.type, "mcp.intent.register");
  assert.deepEqual((registered?.body as McpIntentRegistration).assignment?.native,
    { sessionId, chatName: "Synthetic Lead", platform: "darwin", originalMain: true, leadGuardVersion: 1 });
});
