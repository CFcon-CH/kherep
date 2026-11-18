import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type MessageType } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { exchangeOptions, getOutbox, getSent, pollExchange, writeOutbox } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { DEFAULT_POLICY } from "./policy.mts";
import { OUTBOX_GATE_MS } from "./send-schedule.mts";

// Issue #961: after (re)authentication the outbox waits for the Worker's first
// directory answer on this connection, at most OUTBOX_GATE_MS. Synthetic only.
const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const ID = "00000000-0000-4000-8000-0000000000a1";
const T0 = 1_000_000;

const incoming = (type: MessageType, body: Record<string, unknown>): string => JSON.stringify(makeEnvelope(type, body, 0, 0));
const directory = (extra: Record<string, unknown> = {}): string =>
  incoming("directory", { nodes: [], sessions: [], fetchedAt: new Date(0).toISOString(), ...extra });

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-outbox-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths: NodePaths = nodePaths(root);
  const clock = { now: T0 };
  const client = new NodeClient({
    nodeId: SELF, identity: generateIdentity(), policy: DEFAULT_POLICY, now: () => clock.now,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(paths, () => clock.now),
  });
  await client.onFrame(incoming("event", { name: "auth.ok" }));
  writeOutbox(paths, { messageId: ID, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello",
    createdAt: new Date(0).toISOString() });
  let inflight = new Map<string, number>();
  const poll = (gate = true): string[] => {
    const sent: string[] = [];
    pollExchange(client, paths, inflight, (frame) => { sent.push(frame); return true; }, clock.now, () => 0, undefined,
      gate ? { outboxGate: true } : {});
    return sent.map((frame) => { const parsed = parseEnvelope(frame); assert.ok(parsed.ok); return parsed.envelope.type; })
      .filter((type) => type === "message.send");
  };
  const reconnect = async (): Promise<void> => {
    client.connectionClosed(); inflight = new Map();
    await client.onFrame(incoming("event", { name: "auth.ok" }));
  };
  return { paths, clock, client, poll, reconnect };
}

test("the gate holds the outbox before the directory answer and opens on it, sending each record once", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.poll(), [], "held before the Worker answered");
  f.clock.now += 2_000;
  assert.deepEqual(f.poll(), [], "still held");
  assert.ok(getOutbox(f.paths, ID), "the held record stays in the outbox");
  assert.equal(getSent(f.paths, ID), null, "no state change while held");
  await f.client.onFrame(directory({ worker: { capabilities: ["messaging.selected-binding.v1"] } }));
  assert.deepEqual(f.poll(), ["message.send"], "opens on the directory answer");
  assert.deepEqual(f.poll(), [], "not sent twice");
});

test("an old Worker's directory without capabilities opens the gate", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.poll(), []);
  await f.client.onFrame(directory());
  assert.deepEqual(f.client.workerCapabilities, []);
  assert.deepEqual(f.poll(), ["message.send"]);
});

test("without a valid directory the gate opens after OUTBOX_GATE_MS", async (t) => {
  const f = await fixture(t);
  await f.client.onFrame(directory({ nodes: "all" }));
  f.clock.now = T0 + OUTBOX_GATE_MS - 1;
  assert.deepEqual(f.poll(), [], "a malformed directory does not open the gate");
  f.clock.now = T0 + OUTBOX_GATE_MS;
  assert.deepEqual(f.poll(), ["message.send"], "the bound falls back to today's behaviour");
  assert.deepEqual(f.poll(), []);
});

test("a reconnect closes the gate again until the new connection's directory answer", async (t) => {
  const f = await fixture(t);
  await f.client.onFrame(directory());
  assert.deepEqual(f.poll(), ["message.send"]);
  f.clock.now += 60_000;
  await f.reconnect();
  assert.equal(f.client.workerCapabilities, null);
  assert.deepEqual(f.poll(), [], "held on the new connection");
  await f.client.onFrame(directory());
  assert.deepEqual(f.poll(), ["message.send"], "resent once on the new connection");
  assert.deepEqual(f.poll(), []);
});

test("without the gate source the exchange sends at once, as before", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.poll(false), ["message.send"]);
});
