import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Issue #195, end to end through the real node modules and the real
// NodeSession and Registry: a lost answer on a live connection, a repeated
// send, and a daemon crash in the middle of an exchange on either side. Each
// case ends with exactly one delivery and the final state at the sender.
// Issue #607: every wait is on the frame that writes the record under test
// (FrameLog), never a poll of the file within the test's own bound.
import { parseEnvelope } from "../../protocol.mts";
import type { SessionInfo } from "../../protocol.mts";
import { NodeClient } from "../../node/client.mts";
import { nodePaths, type NodePaths } from "../../node/config.mts";
import { exchangeOptions, getOutbox, getSent, pollExchange, recordingSessions, SEND_RETRY_MS, writeOutbox } from "../../node/exchange.mts";
import { generateIdentity, type NodeIdentity } from "../../node/identity.mts";
import { getMessage, markDelivered, messageIds, storeMessage } from "../../node/inbox.mts";
import { DEFAULT_POLICY, type NodePolicy } from "../../node/policy.mts";
import { answered, E2E_TIMEOUT_MS, FrameLog } from "./frame-log.mts";
import { enroll, FACTS, workerFetch } from "./helpers.mts";

const ACCEPTS: NodePolicy = { ...DEFAULT_POLICY, messaging: { accept: [{ session: "review", from: ["*"] }] } };
const SESSIONS: SessionInfo[] = [{ sessionId: "s-b", runtime: "claude-code", state: "idle", name: "review" }];

interface Identity { nodeId: string; identity: NodeIdentity; paths: NodePaths; policy: NodePolicy }

async function enrolled(root: string, name: string, policy: NodePolicy = DEFAULT_POLICY): Promise<Identity> {
  const identity = generateIdentity();
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, `${name}-${crypto.randomUUID().slice(0, 8)}`);
  return { nodeId, identity, paths: nodePaths(path.join(root, name)), policy };
}

// One daemon process: a fresh client and inflight map on the node's
// directory. drop decides which received frames are lost before handling,
// mute which outgoing frames never reach the socket. handled logs a frame
// once the client handled it and its answers went out; dropped and outgoing
// log what the rules lost and what reached the socket. stop closes the socket
// once every answer the Worker owes the node arrived; crash closes it at once.
async function start(node: Identity) {
  const list = recordingSessions(node.paths, async () => SESSIONS, () => {});
  const client = new NodeClient({
    nodeId: node.nodeId, identity: node.identity, policy: node.policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": list },
    facts: () => FACTS, runtimes: async () => [], sessions: list,
    storeMessage: (body) => { storeMessage(node.paths.inbox, body); }, ...exchangeOptions(node.paths),
  });
  const response = await workerFetch(`/node/connect?nodeId=${node.nodeId}`, { headers: { upgrade: "websocket" } });
  const ws = response.webSocket!;
  const delivered: string[] = [];
  const handled = new FrameLog();
  const dropped = new FrameLog();
  const outgoing = new FrameLog();
  let drop = (_type: string, _body: Record<string, unknown>): boolean => false;
  let mute = (_type: string): boolean => false;
  let chain = Promise.resolve();
  const send = (frame: string): boolean => {
    const parsed = parseEnvelope(frame);
    if (parsed.ok && mute(parsed.envelope.type)) return true;
    ws.send(frame);
    if (parsed.ok) outgoing.add(parsed.envelope);
    return true;
  };
  ws.addEventListener("message", (event) => {
    const parsed = parseEnvelope(event.data as string);
    if (!parsed.ok) return;
    const body = parsed.envelope.body as Record<string, unknown>;
    if (drop(parsed.envelope.type, body)) return dropped.add(parsed.envelope);
    if (parsed.envelope.type === "message.deliver") delivered.push(String(body.messageId));
    chain = chain.then(async () => {
      for (const frame of await client.onFrame(event.data as string)) send(frame);
      handled.add(parsed.envelope);
    });
  });
  ws.accept();
  // Authenticated, and the Worker's auth-time frames are in: the directory
  // answers the directory.get sent on auth.ok, normally after the replayed
  // deliveries and statuses.
  await handled.seen("event", { name: "auth.ok" });
  await handled.seen("directory");
  const inflight = new Map<string, number>();
  return {
    ws, client, delivered, inflight, handled, dropped, outgoing,
    // One exchange round, complete when its frames went out; the caller waits for their answers.
    exchange: async (now = Date.now()) => { chain = chain.then(() => pollExchange(client, node.paths, inflight, send, now)); await chain; },
    idle: () => chain,
    dropIncoming: (rule: typeof drop) => { drop = rule; },
    muteOutgoing: (rule: typeof mute) => { mute = rule; },
    stop: async () => { await chain; await answered(outgoing, handled); await chain; ws.close(1000, "done"); },
    crash: async () => { drop = () => true; await chain; ws.close(1000, "crash"); },
  };
}

async function twoNodes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-recovery-e2e-"));
  const a = await enrolled(root, "a");
  const b = await enrolled(root, "b", ACCEPTS);
  fs.mkdirSync(a.paths.outbox, { recursive: true });
  const messageId = crypto.randomUUID();
  writeOutbox(a.paths, { messageId, fromSession: "planner", to: { nodeId: b.nodeId, session: "review" }, text: "please check the build",
    createdAt: new Date().toISOString() });
  return { root, a, b, messageId };
}

describe("exchange recovery", { timeout: E2E_TIMEOUT_MS }, () => {
  it("resends after a lost answer on the live connection; one delivery, and the sender sees the final state", async () => {
    const { root, a, b, messageId } = await twoNodes();
    const target = await start(b);
    const sender = await start(a);
    // Every status for the message is lost on the way to the sender: its answer and the forwarded accepted.
    sender.dropIncoming((type, body) => type === "message.status" && body.messageId === messageId);
    const t0 = Date.now();
    await sender.exchange(t0);
    await target.handled.seen("message.deliver", { messageId });
    expect(getMessage(b.paths.inbox, messageId)?.state).toBe("accepted");
    // The target stored it before its accepted report reached the Worker; wait
    // until the forwarded accepted was lost too, or it could still arrive and
    // settle the message without a resend.
    await sender.dropped.seen("message.status", { messageId, state: "accepted" });
    const statuses = sender.dropped.list("message.status", { messageId });
    const canonical = statuses.filter(frame => !(frame.body as Record<string, unknown>).diagnostic);
    expect(canonical).toHaveLength(2);
    expect(canonical.filter(frame => (frame.body as Record<string, unknown>).state === "queued")).toHaveLength(1);
    for (const frame of statuses.filter(frame => (frame.body as Record<string, unknown>).diagnostic)) {
      expect(frame.body).toMatchObject({ state: "queued", diagnostic: { code: "acceptance-unconfirmed", stage: "upstream-egress" } });
    }
    expect(getSent(a.paths, messageId)).toBeNull();
    expect(getOutbox(a.paths, messageId)).not.toBeNull();

    sender.dropIncoming(() => false);
    await sender.exchange(t0 + SEND_RETRY_MS - 1);
    expect(sender.outgoing.count("message.send", { messageId })).toBe(1); // not due: no resend went out
    expect(getSent(a.paths, messageId)).toBeNull();
    await sender.exchange(t0 + SEND_RETRY_MS);
    expect(sender.outgoing.count("message.send", { messageId })).toBe(2);
    await sender.handled.seen("message.status", { messageId, state: "accepted" });
    expect(getSent(a.paths, messageId)?.state).toBe("accepted");
    expect(getOutbox(a.paths, messageId)).toBeNull();

    // The target confirms delivery; the sender sees it.
    markDelivered(b.paths.inbox, messageId);
    await target.exchange();
    await sender.handled.seen("message.status", { messageId, state: "delivered" });
    expect(getSent(a.paths, messageId)?.state).toBe("delivered");
    expect(target.delivered).toEqual([messageId]);
    await Promise.all([sender.stop(), target.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers a repeated send request once", async () => {
    const { root, a, b, messageId } = await twoNodes();
    const target = await start(b);
    const sender = await start(a);
    const frame = sender.client.sendMessage({ messageId, fromSession: "planner", to: { nodeId: b.nodeId, session: "review" },
      text: "please check the build" })[0];
    sender.ws.send(frame);
    sender.ws.send(frame);
    await sender.exchange();
    // A second process on the same node directory repeats it too.
    sender.inflight.clear();
    await sender.exchange();
    await sender.handled.seen("message.status", { messageId, state: "accepted" });
    expect(getSent(a.paths, messageId)?.state).toBe("accepted");
    // The Worker took three sends (the repeated raw frame carries the same seq
    // and is dropped on the connection) and answered each; the target's
    // accepted report is forwarded as a fourth status. The count relies on
    // exchanges #1 and #2 running before the raw frame's answer is handled (the
    // chain is idle after start()); if that changes, seen(..., 4) fails after
    // 10 s. The delivery check below is a regression check; the last send's
    // routing may still be in flight.
    await sender.handled.seen("message.status", { messageId }, 4);
    await target.handled.seen("message.deliver", { messageId });
    expect(target.delivered).toEqual([messageId]);
    expect(messageIds(b.paths.inbox)).toEqual([messageId]);
    await Promise.all([sender.stop(), target.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recovers a sender daemon crash between the socket send and recordSent", async () => {
    const { root, a, b, messageId } = await twoNodes();
    const target = await start(b);
    const crashed = await start(a);
    crashed.dropIncoming((type) => type === "message.status");
    await crashed.exchange();
    await target.handled.seen("message.deliver", { messageId });
    expect(getMessage(b.paths.inbox, messageId)?.state).toBe("accepted");
    // The answer and the forwarded accepted both reached the process and were lost before it ends.
    await crashed.dropped.seen("message.status", { messageId, state: "accepted" });
    await crashed.crash();
    expect(getSent(a.paths, messageId)).toBeNull();

    const restarted = await start(a);
    await restarted.exchange();
    await restarted.handled.seen("message.status", { messageId, state: "accepted" });
    expect(getSent(a.paths, messageId)?.state).toBe("accepted");
    expect(getOutbox(a.paths, messageId)).toBeNull();
    expect(target.delivered).toEqual([messageId]);
    await Promise.all([restarted.stop(), target.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recovers a target daemon crash between storing a message and reporting accepted", async () => {
    const { root, a, b, messageId } = await twoNodes();
    const crashed = await start(b);
    // The accepted answer never reaches the socket: the process ends first.
    crashed.muteOutgoing((type) => type === "message.status");
    const sender = await start(a);
    await sender.exchange();
    await crashed.handled.seen("message.deliver", { messageId });
    expect(getMessage(b.paths.inbox, messageId)?.state).toBe("accepted");
    await crashed.crash();
    await sender.handled.seen("message.status", { messageId, state: "queued" });
    expect(getSent(a.paths, messageId)?.state).toBe("queued");

    // The Worker kept it queued and hands it over again after authentication;
    // the stored inbox record is kept, so the session gets it once.
    const restarted = await start(b);
    await sender.handled.seen("message.status", { messageId, state: "accepted" });
    expect(getSent(a.paths, messageId)?.state).toBe("accepted");
    expect(restarted.delivered).toEqual([messageId]);
    expect(messageIds(b.paths.inbox)).toEqual([messageId]);
    markDelivered(b.paths.inbox, messageId);
    await restarted.exchange();
    await sender.handled.seen("message.status", { messageId, state: "delivered" });
    expect(getSent(a.paths, messageId)?.state).toBe("delivered");
    await Promise.all([sender.stop(), restarted.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
