import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope, type MessageType } from "../protocol.mts";
import type { DirectoryBody, MessageProgress } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import {
  exchangeOptions, getSent, pollExchange, readDirectory, readLocalSessions, recordSent, recordingSessions, requestDirectory, SEND_RETRY_MS,
  writeOutbox, type OutboxRecord,
} from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, getReceipt, markDelivered, markOffered, markRefused, setMessageProgress, storeMessage, UNDELIVERABLE_AFTER_MS, writeJsonAtomic } from "./inbox.mts";
import { DEFAULT_POLICY } from "./policy.mts";
import { createAdmissionAuthority } from "./session-authority.mts";
import { fixtureEvidence, syntheticListing } from "./session-authority-fixture.mts";

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const ID_A = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b2";

function tempPaths(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-exchange-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

const decode = (frames: string[]): Envelope[] => frames.map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return p.envelope; });
const incoming = (type: MessageType, body: Record<string, unknown>) => JSON.stringify(makeEnvelope(type, body, 0, 0));

async function connected(paths: NodePaths, now: () => number = Date.now) {
  const client = new NodeClient({
    nodeId: SELF, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(paths, now),
  });
  const onAuth = decode(await client.onFrame(incoming("event", { name: "auth.ok" })));
  return { client, onAuth };
}

function outbox(paths: NodePaths, messageId = ID_A): OutboxRecord {
  // fromSessionId stays local (issue #253): the message.send frame below must not carry it, sent/ keeps it.
  const record: OutboxRecord = { messageId, fromSession: "review", fromSessionId: "s-review", to: { nodeId: PEER, session: "build" },
    text: "hello", createdAt: new Date(0).toISOString() };
  writeOutbox(paths, record);
  return record;
}

function poll(client: NodeClient, paths: NodePaths, inflight = new Map<string, number>(), open = true, now?: number): Envelope[] {
  const sent: string[] = [];
  pollExchange(client, paths, inflight, (frame) => { if (open) sent.push(frame); return open; }, now);
  return decode(sent);
}

test("asks for the directory after auth and writes the directory frame to directory.json", async (t) => {
  const paths = tempPaths(t);
  const { client, onAuth } = await connected(paths);
  assert.deepEqual(onAuth.map((e) => e.type), ["register", "sessions.snapshot", "directory.get"]);
  assert.deepEqual(onAuth[2].body, {});
  const directory: DirectoryBody = { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }],
    sessions: [{ nodeId: PEER, sessionId: "s-1", name: "build", state: "idle", runtime: "claude-code" }], fetchedAt: new Date(0).toISOString() };
  assert.deepEqual(await client.onFrame(incoming("directory", { ...directory })), []);
  assert.deepEqual(readDirectory(paths), directory);
  // An invalid directory frame changes nothing.
  await client.onFrame(incoming("directory", { nodes: "all" }));
  assert.deepEqual(readDirectory(paths), directory);
  // directory.request asks for a refresh once.
  requestDirectory(paths);
  assert.deepEqual(poll(client, paths).map((e) => e.type), ["directory.get"]);
  assert.deepEqual(poll(client, paths), []);
});

test("sends each outbox record once per connection and moves it to sent/ with the Worker's states", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  const record = outbox(paths);
  const inflight = new Map<string, number>();
  const [frame] = poll(client, paths, inflight);
  assert.equal(frame.type, "message.send");
  assert.deepEqual(frame.body, { messageId: ID_A, fromSession: "review", to: { nodeId: PEER, session: "build" }, text: "hello" });
  assert.deepEqual(poll(client, paths, inflight), []); // not again on this connection
  assert.equal(poll(client, paths).length, 1); // a new connection sends it again; the Worker deduplicates

  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "queued" }));
  assert.equal(fs.existsSync(path.join(paths.outbox, `${ID_A}.json`)), false);
  assert.deepEqual({ ...getSent(paths, ID_A), updatedAt: "" }, { ...record, state: "queued", updatedAt: "" });
  // Forwarded statuses of the target update the same file.
  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "refused", reason: "not accepted by node policy" }));
  assert.deepEqual(getSent(paths, ID_A), { ...record, state: "refused", reason: "not accepted by node policy", updatedAt: getSent(paths, ID_A)?.updatedAt });
  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "accepted" }));
  assert.equal(getSent(paths, ID_A)?.state, "refused", "a delayed lower state cannot regress a terminal state");
  writeOutbox(paths, record);
  assert.equal(fs.existsSync(path.join(paths.outbox, ID_A + ".json")), true, "simulated crash left the outbox copy");
  recordSent(paths, ID_A, "accepted");
  assert.equal(getSent(paths, ID_A)?.state, "refused");
  assert.equal(fs.existsSync(path.join(paths.outbox, ID_A + ".json")), false, "duplicate recovery removes the stale outbox copy");
  await client.onFrame(incoming("message.status", { messageId: ID_B, state: "accepted" }));
  assert.equal(getSent(paths, ID_B), null); // not a message of this node
});

test("same-state accepted progress is monotonic locally and final states clear it", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  outbox(paths);
  poll(client, paths);
  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "accepted" }));
  const first: MessageProgress = { phase: "waking", code: "wake-pending", observedAt: "2026-09-29T12:00:00.000Z" };
  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "accepted", progress: first }));
  assert.deepEqual(getSent(paths, ID_A)?.progress, first);
  const stale: MessageProgress = { phase: "waiting", code: "wake-unconfirmed", observedAt: "2026-09-29T11:59:00.000Z" };
  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "accepted", progress: stale }));
  assert.deepEqual(getSent(paths, ID_A)?.progress, first);
  await client.onFrame(incoming("message.status", { messageId: ID_A, state: "delivered" }));
  assert.equal(getSent(paths, ID_A)?.progress, undefined);
});

test("accepted progress retries until its exact Worker receipt and backs off for an older Worker", async (t) => {
  const paths = tempPaths(t);
  const now = Date.UTC(2026, 8, 29, 12);
  const { client } = await connected(paths, () => now);
  const record = storeMessage(paths.inbox, { messageId: ID_A, from: { nodeId: PEER, session: "s-a" }, toSession: "review",
    text: "private", createdAt: new Date(0).toISOString() }, now);
  const first: MessageProgress = { phase: "waking", code: "wake-pending", observedAt: new Date(now).toISOString() };
  setMessageProgress(paths.inbox, ID_A, first.phase, first.code, now);

  assert.deepEqual(poll(client, paths, new Map(), true, now).map((e) => e.body), [{ messageId: ID_A, state: "accepted", progress: first }]);
  assert.deepEqual(poll(client, paths, new Map(), true, now).map((e) => e.body), [{ messageId: ID_A, state: "accepted", progress: first }],
    "socket enqueue is not persistence");
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "accepted", storedState: "accepted", storedProgressAt: first.observedAt }));
  assert.deepEqual(poll(client, paths, new Map(), true, now), []);

  const second: MessageProgress = { phase: "waiting", code: "target-busy", observedAt: new Date(now + 1).toISOString() };
  setMessageProgress(paths.inbox, ID_A, second.phase, second.code, now + 1);
  assert.equal(poll(client, paths, new Map(), true, now + 1).length, 1);
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "accepted", storedState: "accepted", storedProgressAt: first.observedAt }));
  assert.equal(poll(client, paths, new Map(), true, now + 1).length, 1, "an old receipt leaves newer progress pending");

  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "accepted", storedState: "accepted" }));
  assert.deepEqual(poll(client, paths, new Map(), true, now + 1), [], "an old Worker receipt applies retry backoff");
  assert.equal(getReceipt(paths.inbox, ID_A)?.reportedProgressAt, first.observedAt,
    "an older acknowledged observation remains recorded without acknowledging the newer one");
  assert.equal(poll(client, paths, new Map(), true, now + 60_001).length, 1, "progress retries after the bounded backoff");
});

test("a malformed progress sidecar never crosses the WebSocket", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  storeMessage(paths.inbox, { messageId: ID_A, from: { nodeId: PEER, session: "s-a" }, toSession: "review",
    text: "private", createdAt: new Date(0).toISOString() });
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "accepted", storedState: "accepted" }));
  const progressDir = path.join(paths.inbox, "progress");
  fs.mkdirSync(progressDir, { recursive: true });
  fs.writeFileSync(path.join(progressDir, `${ID_A}.json`), JSON.stringify({ phase: "waiting", code: "wake-unconfirmed",
    observedAt: new Date(0).toISOString(), text: "private sidecar content" }));
  assert.deepEqual(poll(client, paths), []);
});
test("an error frame naming an outbox message, and a malformed outbox record, end in state error", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  outbox(paths);
  poll(client, paths);
  await client.onFrame(incoming("error", { error: "messageId belongs to another node", messageId: ID_A }));
  assert.deepEqual([getSent(paths, ID_A)?.state, getSent(paths, ID_A)?.reason], ["error", "messageId belongs to another node"]);

  fs.writeFileSync(path.join(paths.outbox, `${ID_B}.json`), "{not json");
  assert.deepEqual(poll(client, paths), []);
  assert.deepEqual([getSent(paths, ID_B)?.state, getSent(paths, ID_B)?.reason], ["error", "invalid outbox record"]);
  assert.deepEqual(fs.readdirSync(paths.outbox), []);
});

test("nothing counts as sent while the socket is closed or the client not authenticated", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  outbox(paths);
  const inflight = new Map<string, number>();
  assert.deepEqual(poll(client, paths, inflight, false), []);
  assert.equal(inflight.size, 0);
  client.connectionClosed();
  assert.deepEqual(poll(client, paths, inflight), []);
  assert.equal(inflight.size, 0);
});

test("retries terminal inbox states until the Worker receipt confirms persistence", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  for (const id of [ID_A, ID_B]) {
    storeMessage(paths.inbox, { messageId: id, from: { nodeId: PEER, session: "s-a" }, toSession: "review", text: "hi", createdAt: new Date(0).toISOString() });
  }
  const live = new Map<string, number>();
  const t0 = Date.now();
  assert.deepEqual(poll(client, paths, live, true, t0).map((e) => e.body), [
    { messageId: ID_A, state: "accepted" }, { messageId: ID_B, state: "accepted" },
  ]);
  assert.deepEqual(poll(client, paths, live, true, t0 + 2_000), [], "the next round waits for the receipt (issue #308)");
  assert.deepEqual(poll(client, paths, live, true, t0 + SEND_RETRY_MS).map((e) => e.body), [
    { messageId: ID_A, state: "accepted" }, { messageId: ID_B, state: "accepted" },
  ], "a lost initial accepted report is retried without reconnecting");
  for (const messageId of [ID_A, ID_B]) {
    await client.onFrame(incoming("event", { name: "message.receipt", messageId,
      requestedState: "accepted", storedState: "accepted" }));
  }
  assert.deepEqual(poll(client, paths), []);
  markDelivered(paths.inbox, ID_A);
  // A closed socket reports nothing and marks nothing.
  assert.deepEqual(poll(client, paths, new Map(), false), []);
  assert.equal(getReceipt(paths.inbox, ID_A)?.reportedState, "accepted");
  assert.deepEqual(poll(client, paths).map((e) => [e.type, e.body]), [["message.status", { messageId: ID_A, state: "delivered" }]]);
  assert.equal(getReceipt(paths.inbox, ID_A)?.reportedState, "accepted", "socket write is not a persistence receipt");
  assert.deepEqual(poll(client, paths).map((e) => e.body), [{ messageId: ID_A, state: "delivered" }]);
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "refused", storedState: "refused" }));
  assert.equal(getReceipt(paths.inbox, ID_A)?.reportedState, "accepted", "a receipt for another requested state cannot acknowledge this report");
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "delivered", storedState: "accepted" }));
  assert.equal(getReceipt(paths.inbox, ID_A)?.reportedState, "accepted", "a lower canonical state is not a persistence confirmation");
  assert.deepEqual(poll(client, paths).map((e) => e.body), [{ messageId: ID_A, state: "delivered" }]);
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "delivered", storedState: "refused" }));
  assert.deepEqual([getReceipt(paths.inbox, ID_A)?.reportedState, getReceipt(paths.inbox, ID_A)?.workerState],
    ["delivered", "refused"], "a terminal conflict stops retries but preserves the Worker's canonical state");
  assert.deepEqual(poll(client, paths), []);
  // A refusal is retried with its reason; offered is local only.
  markOffered(paths.inbox, ID_B);
  assert.deepEqual(poll(client, paths), []);
  assert.ok(markRefused(paths.inbox, ID_B, "not confirmed by the session after 3 turns"));
  assert.deepEqual(poll(client, paths).map((e) => e.body),
    [{ messageId: ID_B, state: "refused", reason: "not confirmed by the session after 3 turns" }]);
  assert.equal(getReceipt(paths.inbox, ID_B)?.reportedState, "accepted");
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_B,
    requestedState: "refused", storedState: "delivered" }));
  assert.deepEqual(getReceipt(paths.inbox, ID_B), { reportedAt: getReceipt(paths.inbox, ID_B)?.reportedAt,
    reportedState: "refused", workerState: "delivered" });
  assert.deepEqual(poll(client, paths), []);
});

test("a canonical forward-state receipt confirms the local report and records Worker truth", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  storeMessage(paths.inbox, { messageId: ID_A, from: { nodeId: PEER, session: "s-a" }, toSession: "review",
    text: "hi", createdAt: new Date(0).toISOString() });
  markDelivered(paths.inbox, ID_A);
  assert.deepEqual(poll(client, paths).map((e) => e.body), [{ messageId: ID_A, state: "delivered" }]);
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "delivered", storedState: "replied" }));
  assert.deepEqual([getReceipt(paths.inbox, ID_A)?.reportedState, getReceipt(paths.inbox, ID_A)?.workerState],
    ["delivered", "replied"]);
  assert.deepEqual(poll(client, paths), []);
});

test("legacy optimistic report markers are retried until a receipt from the Worker", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  storeMessage(paths.inbox, { messageId: ID_A, from: { nodeId: PEER, session: "s-a" }, toSession: "review",
    text: "hi", createdAt: new Date(0).toISOString() });
  markDelivered(paths.inbox, ID_A);
  const file = path.join(paths.inbox, ID_A + ".json");
  const legacy = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...legacy, reportedAt: new Date(0).toISOString(), reportedState: "delivered" }));

  assert.deepEqual(poll(client, paths).map((e) => e.body), [{ messageId: ID_A, state: "delivered" }]);
  await client.onFrame(incoming("event", { name: "message.receipt", messageId: ID_A,
    requestedState: "delivered", storedState: "delivered" }));
  assert.deepEqual(poll(client, paths), []);
});

test("a successful listing refuses messages for sessions that stopped running; a failed one decides nothing", async (t) => {
  const paths = tempPaths(t);
  const { client } = await connected(paths);
  const received = Date.UTC(2026, 8, 25, 12);
  const ID_C = "00000000-0000-4000-8000-0000000000c3";
  const ID_D = "00000000-0000-4000-8000-0000000000d4";
  for (const [id, toSession] of [[ID_A, "gone"], [ID_B, "review"], [ID_C, "s-2"], [ID_D, "gone-too"]]) {
    storeMessage(paths.inbox, { messageId: id, from: { nodeId: PEER, session: "s-a" }, toSession, text: "hi", createdAt: new Date(0).toISOString() },
      received);
  }
  markOffered(paths.inbox, ID_D);
  let now = received + UNDELIVERABLE_AFTER_MS;
  let fail = false;
  let authoritative = false;
  const authority = createAdmissionAuthority(paths);
  const logs: string[] = [];
  const list = recordingSessions(paths, async () => {
    if (fail) throw new Error("claude agents failed");
    const rows = [{ sessionId: "s-1", runtime: "claude-code", state: "idle", name: "review" }, { sessionId: "s-2", runtime: "claude-code", state: "idle" }];
    return authoritative ? syntheticListing(authority, rows,
      ["gone", "gone-too"].map(sessionId => fixtureEvidence({ runtime: "claude-code", sessionId }, "closed", now)), now) : rows;
  }, (line) => logs.push(line), () => now, undefined, undefined, authority);
  await list();
  assert.equal(getMessage(paths.inbox, ID_A)?.state, "accepted", "not yet past the window");
  fail = true;
  now += 1;
  await assert.rejects(list());
  assert.equal(getMessage(paths.inbox, ID_A)?.state, "accepted", "a failed listing is not an empty node");
  fail = false;
  await list();
  assert.equal(getMessage(paths.inbox, ID_A)?.state, "accepted", "a complete raw listing without positive closure still leaves UNKNOWN waiting");
  authoritative = true;
  await list();
  assert.deepEqual([ID_A, ID_B, ID_C, ID_D].map((id) => [getMessage(paths.inbox, id)?.state, getMessage(paths.inbox, id)?.reason]), [
    ["refused", "target session not running"], ["accepted", undefined], ["accepted", undefined], ["refused", "target session not running"]]);
  assert.deepEqual(logs, ["kherep-node: refused 2 message(s) for sessions that are not running"]);
  const reports = poll(client, paths).map((e) => e.body as { messageId: string; state: "accepted" | "refused"; reason?: string });
  assert.deepEqual(reports, [
    { messageId: ID_A, state: "refused", reason: "target session not running" },
    { messageId: ID_B, state: "accepted" },
    { messageId: ID_C, state: "accepted" },
    { messageId: ID_D, state: "refused", reason: "target session not running" },
  ]);
  for (const report of reports) await client.onFrame(incoming("event", { name: "message.receipt",
    messageId: report.messageId, requestedState: report.state, storedState: report.state }));
  assert.deepEqual(poll(client, paths), []);
});

test("records every successful session listing in sessions.json and keeps it on a failed one", async (t) => {
  const paths = tempPaths(t);
  let fail = false;
  const list = recordingSessions(paths, async () => {
    if (fail) throw new Error("claude agents failed");
    return [{ sessionId: "s-1", runtime: "claude-code", state: "idle", name: "review", cwd: "/work" }, { sessionId: "s-2", runtime: "claude-code", state: "idle" }];
  }, () => {});
  await list();
  assert.deepEqual(readLocalSessions(paths), [
    { sessionId: "s-1", name: "review", runtime: "claude-code", state: "unknown" },
    { sessionId: "s-2", runtime: "claude-code", state: "unknown" },
  ]);
  fail = true;
  await assert.rejects(list());
  assert.equal(readLocalSessions(paths).length, 2);
});
