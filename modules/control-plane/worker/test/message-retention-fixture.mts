import { runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";

import { makeEnvelope, type Envelope, type MessageType } from "../../protocol.mts";
import {
  MESSAGE_STATUS_ACK, MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY, type FinalMessageState, type MessageStatusBody,
  type NodeReportedState,
} from "../../protocol-messages.mts";
import { authenticate, enroll, FACTS, newKey, nextMessageStatus, registry, until, type NodeKey, type TestSocket } from "./helpers.mts";

// Issue #308, PR 4: a message row is deleted once its sender acknowledged the
// final status, or by the 24 h fallback; only rows stored by this version. The
// fixture of the three message-retention test files (split in issue #569):
// nodes, frames, Registry rows, the completions of acks and reports, replay.
const ACKING = [MESSAGING_CAPABILITY, MESSAGING_ACK_CAPABILITY];
export const WAIT = { timeout: 3_000, interval: 20 };
type Row = Record<string, SqlStorageValue> | undefined;

export async function node(name: string, capabilities = ACKING): Promise<{ key: NodeKey; nodeId: string }> {
  const key = await newKey();
  const nodeId = await enroll(key, name);
  await registry().updateRegistration(nodeId, FACTS, [], capabilities);
  return { key, nodeId };
}

export const frame = (socket: TestSocket, type: MessageType, body: Record<string, unknown>) => socket.send(makeEnvelope(type, body, 0, 0));
export const ack = (socket: TestSocket, messageId: string, state: string) => frame(socket, "event", { name: MESSAGE_STATUS_ACK, messageId, state });
export const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
// A closed socket reaches the Registry on its own (node-session.mts webSocketClose,
// registry.mts invalidateMessageConnection), and a send prepared before it lands
// is refused as loop-context-changed (issue #914). The close has landed once the
// node's message connection token is gone.
export const offline = (nodeId: string) => vi.waitFor(async () => expect(await query((sql) =>
  sql.exec("SELECT message_connection_token AS token FROM nodes WHERE id = ?", nodeId).toArray()[0]?.token)).toBeNull(),
{ timeout: 10_000, interval: 20 });
export const row = (id: string): Promise<Row> => query((sql) => sql.exec("SELECT * FROM messages WHERE id = ?", id).toArray()[0]);
export const tombstone = (id: string): Promise<Row> => query((sql) => sql.exec("SELECT * FROM message_tombstones WHERE id = ?", id).toArray()[0]);
export const deletes = (id: string) => query((sql) => sql.exec("SELECT actor, detail FROM audit WHERE action = 'message.delete' AND detail LIKE ?",
  `%${id}%`).toArray());
export const settles = (id: string) => query((sql) => sql.exec("SELECT actor, detail FROM audit WHERE action = 'message.settle' AND detail LIKE ?",
  `%${id}%`).toArray());

// The frames sent before the answer to a directory.get. The Worker starts
// handling frames in order, but each frame reaches the Registry on its own
// stub and there is no ordering between different stubs (issue #529): an empty
// result does not prove that nothing was sent, a frame still awaiting the
// Registry can follow. An expected frame is awaited with until(). An ack has no
// answer frame, so sync() cannot see it land (issue #557): its effect is awaited
// on the Registry's state (deletedByAck, settledByAck), and an ack without an
// effect goes through the Registry's RPC (acked), whose answer is the completion.
// A target's report is answered by a receipt event, sent after the Registry's
// RPC returned, so the receipt is its completion (receipt, issue #569); a report
// of another node on a stored message has no receipt and goes through the RPC
// (reported).
export async function sync(socket: TestSocket): Promise<Envelope[]> {
  frame(socket, "directory.get", {});
  const frames: Envelope[] = [];
  for (let envelope = await socket.next(); envelope.type !== "directory"; envelope = await socket.next()) frames.push(envelope);
  return frames;
}

// The receipt that answers a report of the target node (message-store.mts
// report, node-session.mts message.status): sent after the Registry's RPC
// returned, so the stored state it carries is committed. Consuming it keeps the
// frame from a later sync() or until() on the same socket.
export async function receipt(socket: TestSocket, messageId: string, requestedState: string, storedState: string,
  more: Record<string, unknown> = {}): Promise<void> {
  const frames = await until(socket, "event", { name: "message.receipt", messageId, requestedState });
  expect(frames.map((e) => e.body)).toEqual([{ name: "message.receipt", messageId, requestedState, storedState, ...more }]);
}

// A report of another node than the target on a stored message gets no receipt
// and changes nothing (message-store.mts report; an unknown id without a tombstone
// gets an `expired` receipt from any node, message-retention.mts lateReceipt): nothing to wait
// for, so it goes through the Registry's RPC, whose answer is the completion;
// the null receipt is what node-session.mts tests before it sends one.
export async function reported(nodeId: string, messageId: string, state: NodeReportedState): Promise<void> {
  expect((await registry().reportMessageStatus(nodeId, { messageId, state })).receipt).toBeNull();
}

// A message from `a` to `b`, reported delivered by b; returns its id.
export async function deliveredMessage(a: TestSocket, b: TestSocket, bNode: string, messageId = crypto.randomUUID()): Promise<string> {
  frame(a, "message.send", { messageId, fromSession: "s-a", to: { nodeId: bNode, session: "s-b" }, text: "synthetic text" });
  await nextMessageStatus(a, { messageId, state: "queued" });
  await until(b, "message.deliver", { messageId }); // consumed: receipt() is strict, so an unconsumed frame before it fails the test
  frame(b, "message.status", { messageId, state: "delivered" });
  await nextMessageStatus(a, { messageId, state: "delivered" });
  await receipt(b, messageId, "delivered", "delivered");
  return messageId;
}

export async function pair() {
  const a = await node("retention-sender");
  const b = await node("retention-target");
  return { a, b, sender: await authenticate(a.nodeId, a.key), target: await authenticate(b.nodeId, b.key) };
}

// A final row as a Worker before PR 4 stored it: no deletable mark, no depth.
export async function legacyRow(from: string, to: string, state = "delivered"): Promise<string> {
  const id = crypto.randomUUID();
  await query((sql) => sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, state, created_at, updated_at,
    expires_at) VALUES (?, ?, 's-a', ?, 's-b', ?, 1, 1, 1)`, id, from, to, state));
  return id;
}

type Tx = { messageTx: (path: string, run: () => unknown) => Promise<unknown> };
// Holds the Registry's next message transaction of `path` until release(), with
// a non-storage await that keeps the Registry's input gate open for a
// directory() call meanwhile. Forces the order the stub docs allow (no ordering
// between different stubs): "after" the commit delays the frame that reports
// the result (issue #529, a resend's status), "before" delays the transaction
// itself (issue #557, an ack whose only trace is the Registry's state; issue
// #569, a report whose receipt follows the RPC's answer).
// restore() puts the method back: whether a patched instance outlives the test
// is unknown, so it is not left to chance.
export async function holdNext(path: "sendMessage" | "ackMessageStatus" | "reportMessageStatus", at: "before" | "after"):
Promise<{ release: () => void; restore: () => Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = await runInDurableObject(registry(), (instance) => {
    const target = instance as unknown as Tx;
    const method = target.messageTx;
    let armed = true;
    target.messageTx = async function (this: unknown, current, run) {
      const hit = current === path && armed;
      if (hit) armed = false;
      if (hit && at === "before") await held;
      const result = await method.call(this, current, run);
      if (hit && at === "after") await held;
      return result;
    };
    return method;
  });
  return { release, restore: () => runInDurableObject(registry(), (instance) => { (instance as unknown as Tx).messageTx = original; }) };
}

// Issue #529, step 1: the ack landed, the row is gone and the tombstone is the expected one.
export async function deletedByAck(id: string, from: string, to: string): Promise<void> {
  await vi.waitFor(async () => expect(await row(id)).toBeUndefined(), WAIT);
  expect(await tombstone(id)).toMatchObject({ from_node: from, to_node: to, state: "delivered" });
}

// An ack without an effect leaves nothing to wait for (issue #557): it goes
// through the Registry's RPC, whose answer is the completion. The frame path
// (node-session.mts, event message.status.ack) is covered by the acks that
// delete or settle a row.
export const acked = (nodeId: string, messageId: string, state: FinalMessageState) =>
  registry().ackMessageStatus(nodeId, { name: MESSAGE_STATUS_ACK, messageId, state });

// Reconnects a node and returns its replay, in rowid order. sync() does not
// bound it (auth.ok starts the replay while later frames may already be
// handled), so a final legacy row inserted just before the reconnect ends it:
// the pages go out in rowid order. Earlier end rows are left out.
const ends = new Set<string>();
export async function reconnect(n: { key: NodeKey; nodeId: string }): Promise<{ socket: TestSocket; statuses: MessageStatusBody[]; replayed: string[] }> {
  const end = await legacyRow(n.nodeId, crypto.randomUUID(), "refused");
  ends.add(end);
  const socket = await authenticate(n.nodeId, n.key);
  const statuses: MessageStatusBody[] = [];
  for (;;) {
    const envelope = await socket.next();
    if (envelope.type !== "message.status") continue;
    const body = envelope.body as MessageStatusBody;
    if (body.messageId === end) break;
    if (!ends.has(body.messageId)) statuses.push(body);
  }
  return { socket, statuses, replayed: statuses.map((s) => s.messageId) };
}

// The next status of one message, skipping other frames (a reply's delivery).
export async function statusOf(socket: TestSocket, messageId: string): Promise<MessageStatusBody> {
  for (;;) {
    const envelope = await socket.next();
    const body = envelope.body as MessageStatusBody;
    if (envelope.type === "message.status" && body.messageId === messageId) return body;
  }
}

export const settledState = async (id: string) => (await row(id))?.settled_state;
// The ack landed: the row carries the acknowledged state as settled (issue #493).
export const settledByAck = (id: string, state: string) => vi.waitFor(async () => expect(await settledState(id)).toBe(state), WAIT);
// The [settled bucket, count] groups of one sender's legacy rows in one state.
export const legacyGroups = async (nodeId: string, state: string) => (await registry().messageSummary(nodeId, Date.now())).groups
  .filter((g) => g.state === state && g.deletable === "null").map((g) => [g.settled, g.count]);
// A reply from `socket`: its queued status answers the send once the Registry
// committed it, markReplied included (message-store.mts send), so it is awaited.
export async function replyTo(socket: TestSocket, original: string, to: { nodeId: string; session: string }): Promise<void> {
  const messageId = crypto.randomUUID();
  frame(socket, "message.send", { messageId, fromSession: "s-b", to, text: "synthetic reply", inReplyTo: original });
  await until(socket, "message.status", { messageId, state: "queued" });
}
