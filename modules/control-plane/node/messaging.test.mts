import { MESSAGING_LOOP_BRAKE_CAPABILITY } from "../protocol-loop-brake.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope } from "../protocol.mts";
import { MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY, MESSAGING_PROGRESS_V2_CAPABILITY, type MessageDeliverBody } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { acceptsMessage, advertisedCapabilities, DEFAULT_POLICY, loadPolicy, messagingEnabled, type NodePolicy } from "./policy.mts";

const PEER = "00000000-0000-4000-8000-0000000000cc";
const OTHER = "00000000-0000-4000-8000-0000000000dd";
const MESSAGE_ID = "00000000-0000-4000-8000-00000000000b";

function policyFile(t: test.TestContext, value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-msg-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

const withMessaging = (messaging: unknown) => ({ version: 1, allowedCommands: ["node.status"], messaging });
// A parsed policy whose file has no messaging section. DEFAULT_POLICY, the file
// onboarding writes, carries an explicit accept rule for every sender (issue #390).
const NO_MESSAGING: NodePolicy = { version: 1, allowedCommands: [...DEFAULT_POLICY.allowedCommands] };

test("messaging is disabled without a section, without rules or with a malformed section", (t) => {
  assert.equal(messagingEnabled(DEFAULT_POLICY), true);
  assert.equal(messagingEnabled(loadPolicy(policyFile(t, { version: 1, allowedCommands: [] }))), false);
  assert.equal(messagingEnabled(loadPolicy(policyFile(t, withMessaging({ accept: [] })))), false);
  const malformed = [
    "yes", { accept: "all" }, { accept: [{ session: "s1" }] }, { accept: [{ session: "s1", from: [] }] },
    { accept: [{ session: "", from: ["*"] }] }, { accept: [{ session: "s1", from: ["some-host"] }] },
    // One bad rule disables the whole section, not just that rule.
    { accept: [{ session: "s1", from: ["*"] }, { session: "s2", from: [7] }] },
  ];
  for (const messaging of malformed) {
    const policy = loadPolicy(policyFile(t, withMessaging(messaging)));
    assert.equal(messagingEnabled(policy), false, JSON.stringify(messaging));
    assert.deepEqual(policy.allowedCommands, ["node.status"]); // the command allowlist is unaffected
  }
});

test("accept rules match the session exactly or by wildcard, and the sender by id, operator or wildcard", (t) => {
  const policy = loadPolicy(policyFile(t, withMessaging({ accept: [
    { session: "review", from: [PEER, "operator"] },
    { session: "*", from: [OTHER] },
    { session: "open", from: ["*"] },
  ] })));
  assert.equal(messagingEnabled(policy), true);
  assert.equal(acceptsMessage(policy, "review", PEER), true);
  assert.equal(acceptsMessage(policy, "review", "operator"), true);
  assert.equal(acceptsMessage(policy, "Review", PEER), false);
  assert.equal(acceptsMessage(policy, "build", PEER), false);
  assert.equal(acceptsMessage(policy, "anything", OTHER), true);
  assert.equal(acceptsMessage(policy, "open", PEER), true);
  assert.equal(acceptsMessage(NO_MESSAGING, "open", PEER), false);
});

test("messaging.v1 is advertised only when an accept rule exists", async () => {
  assert.deepEqual(advertisedCapabilities(NO_MESSAGING), [...DEFAULT_POLICY.allowedCommands, MESSAGING_ACK_CAPABILITY,
    MESSAGING_PROGRESS_V2_CAPABILITY, MESSAGING_LOOP_BRAKE_CAPABILITY]);
  const policy: NodePolicy = { ...DEFAULT_POLICY, messaging: { accept: [{ session: "*", from: ["operator"] }] } };
  assert.deepEqual(advertisedCapabilities(policy), [...DEFAULT_POLICY.allowedCommands, MESSAGING_CAPABILITY, MESSAGING_ACK_CAPABILITY,
    MESSAGING_PROGRESS_V2_CAPABILITY, MESSAGING_LOOP_BRAKE_CAPABILITY]);
  const { frames } = await authed(policy);
  const [register] = frames;
  assert.deepEqual((register.body as { capabilities: string[] }).capabilities, advertisedCapabilities(policy));
});

async function authed(policy: NodePolicy, store: (body: MessageDeliverBody) => void = () => {}) {
  const log: string[] = [];
  const node = new NodeClient({
    nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(), policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: store, log: (line) => log.push(line),
  });
  const frames = decode(await node.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))));
  return { client: node, frames, log };
}

const decode = (frames: string[]): Envelope[] => frames.map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return p.envelope; });

const deliverFrame = (from: string, toSession = "review") => JSON.stringify(makeEnvelope("message.deliver", {
  messageId: MESSAGE_ID, from: { nodeId: from, session: "s-a" }, toSession, text: "hi", createdAt: new Date(0).toISOString(),
}, 0, 0));

const REVIEW_POLICY: NodePolicy = { ...DEFAULT_POLICY, messaging: { accept: [{ session: "review", from: [PEER] }] } };

test("refuses a message the policy does not accept and stores nothing", async () => {
  const stored: string[] = [];
  const { client } = await authed(REVIEW_POLICY, (body) => stored.push(body.messageId));
  for (const frame of [deliverFrame(OTHER), deliverFrame(PEER, "build")]) {
    assert.deepEqual(decode(await client.onFrame(frame)).map((e) => [e.type, e.body]),
      [["message.status", { messageId: MESSAGE_ID, state: "refused", reason: "not accepted by node policy" }]]);
  }
  assert.deepEqual(stored, []);
  // An invalid body is dropped without an answer.
  assert.deepEqual(await client.onFrame(JSON.stringify(makeEnvelope("message.deliver", { messageId: MESSAGE_ID }, 0, 0))), []);
});

test("stores an accepted message in the inbox and reports accepted, also on redelivery", async (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-msg-inbox-")), "inbox");
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const { client } = await authed(REVIEW_POLICY, (body) => { storeMessage(dir, body); });
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(decode(await client.onFrame(deliverFrame(PEER))).map((e) => [e.type, e.body]),
      [["message.status", { messageId: MESSAGE_ID, state: "accepted" }]]);
  }
  assert.equal(getMessage(dir, MESSAGE_ID)?.state, "accepted");
});

test("a store failure sends no status, so the Worker delivers again later", async () => {
  const { client, log } = await authed(REVIEW_POLICY, () => { throw new Error("ENOSPC"); });
  assert.deepEqual(await client.onFrame(deliverFrame(PEER)), []);
  assert.match(log.join("\n"), new RegExp(`could not store message ${MESSAGE_ID}: ENOSPC`));
});
