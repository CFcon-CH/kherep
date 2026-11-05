import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import type { ResolveResponse } from "../protocol-message-binding.mts";
import { NodeClient } from "./client.mts";
import { createConnectionSupervisor } from "./connection-supervisor.mts";
import { createConnectionWatchdog } from "./connection-watchdog.mts";
import { FakeClock, flush } from "./connection-test-fixture.mts";
import { nodePaths } from "./config.mts";
import { exchangeOptions } from "./exchange.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, messageIds, storeMessage } from "./inbox.mts";
import { MessageReferenceResolver } from "./message-reference.mts";
import { DEFAULT_POLICY } from "./policy.mts";

test("spurious reconnect replays lost acceptance with fresh consumed leases and one durable owner/record", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-pong-replay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root), clock = new FakeClock();
  const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", nodeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const messageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  writeLocalSessions(paths, [{ sessionId: owner, name: "synthetic", runtime: "codex", state: "unknown" }], Date.now(), 7);
  const selectedReferences = new MessageReferenceResolver(paths);
  const client = new NodeClient({ nodeId, identity: generateIdentity(), ...exchangeOptions(paths), selectedReferences,
    policy: { ...DEFAULT_POLICY, messaging: { accept: [{ session: "*", from: ["*"] }] } },
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "synthetic.example.invalid", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], bindingStorageReady: () => true,
    storeMessage: body => { storeMessage(paths.inbox, body); } });
  const frame = (type: Parameters<typeof makeEnvelope>[0], body: Record<string, unknown>): string => JSON.stringify(makeEnvelope(type, body, 0, 0));
  const authenticate = () => client.onFrame(frame("event", { name: "auth.ok" }));
  const resolve = async () => {
    const raw = (await client.onFrame(frame("message.resolve.request", { version: 1, requestId: crypto.randomUUID(), messageId,
      purpose: "admit", selections: [{ role: "to", ref: owner }], expiresAt: Date.now() + 5_000 })))[0];
    const parsed = parseEnvelope(raw); assert.ok(parsed.ok);
    const result = (parsed.envelope.body as ResolveResponse).results[0]; assert.equal(result.code, "BOUND");
    if (result.code !== "BOUND") throw new Error("expected bound lease");
    return { messageId, from: { nodeId, session: "source" }, toSession: owner, text: "synthetic replay",
      createdAt: new Date(0).toISOString(), binding: { version: 1, mode: "exact", from: { sessionId: "source", runtime: null, lifecycleGeneration: null },
        to: { ...result.owner, lifecycleGeneration: result.lifecycleGeneration }, leaseId: result.leaseId, localGeneration: result.localGeneration } };
  };
  let chain = Promise.resolve(), connects = 0;
  const supervisor = createConnectionSupervisor({ clock, connect: () => { connects++; }, delay: () => 500, log: () => {},
    reset: () => { chain = chain.then(() => client.connectionClosed()); }, disconnected: () => {}, finish: () => {} });
  const generation = supervisor.begin(() => watchdog.stop());
  const watchdog = createConnectionWatchdog({ clock, sendPing: () => {}, expire: () => generation.retireConnection({ code: 4000 }) });
  watchdog.open(); await authenticate();
  const first = await resolve(), delivery = frame("message.deliver", first);
  const lostAcceptance = await client.onFrame(delivery); assert.equal(lostAcceptance.length, 1); // dropped, never delivered upstream
  const durable = getMessage(paths.inbox, messageId); assert.ok(durable);
  assert.equal(durable.binding?.to.sessionId, owner);
  assert.deepEqual(await client.onFrame(delivery), [], "the first lease was consumed");
  clock.advance(80_500); await chain; await flush(); assert.equal(connects, 1); assert.equal(client.authenticated, false);
  supervisor.begin(() => {}); await authenticate();
  assert.deepEqual(await client.onFrame(delivery), [], "a retired lease cannot acknowledge replay");
  const replay = await resolve(); assert.notEqual(replay.binding.leaseId, first.binding.leaseId);
  const acceptance = await client.onFrame(frame("message.deliver", replay)); assert.equal(acceptance.length, 1);
  assert.deepEqual(getMessage(paths.inbox, messageId), durable, "replay preserves the exact stored owner and record");
  assert.deepEqual(messageIds(paths.inbox), [messageId], "there is no second inbox record");
  supervisor.stop(); assert.equal(clock.timers.size, 0);
});
