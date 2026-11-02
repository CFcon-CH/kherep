import { describe, expect, it } from "vitest";

import { makeEnvelope, MAX_FRAME_BYTES, parseEnvelope } from "../../protocol.mts";
import { intakeState, QUEUE_STALL_MS, type DirectoryNodeIntake } from "../../protocol-intake.mts";
import {
  isDirectoryBody, MAX_DIRECTORY_NODES, MESSAGING_CAPABILITY, MESSAGING_PROXY_CAPABILITY, type DirectoryBody,
} from "../../protocol-messages.mts";
import { directoryBody } from "../src/directory.mts";
import { authenticate, enroll, FACTS, newKey, registry } from "./helpers.mts";

const EMPTY: DirectoryNodeIntake = { lastAcceptedAt: null, oldestQueuedAt: null, queued: 0 };
const FULL: DirectoryNodeIntake = { lastAcceptedAt: "2026-10-17T09:57:30.000Z", oldestQueuedAt: "2026-10-17T09:59:50.000Z", queued: 100 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const frameOf = (body: DirectoryBody) => JSON.stringify(makeEnvelope("directory", body, 0, 0));

async function intakeOf(nodeId: string): Promise<DirectoryNodeIntake | undefined> {
  return (await registry().directory()).nodes.find((n) => n.nodeId === nodeId)?.intake;
}

describe("directory frames", () => {
  it("answers directory.get with the non-revoked nodes and their sessions", async () => {
    const a = await newKey();
    const b = await newKey();
    const c = await newKey();
    const aId = await enroll(a, "dir-a");
    const bId = await enroll(b, "dir-b");
    const cId = await enroll(c, "dir-c");
    await registry().replaceSessions(bId, [{ sessionId: "s-b", runtime: "claude-code", state: "idle", name: "review", cwd: "/work",
      startedAt: new Date(0).toISOString() }]);
    await registry().revoke(cId, "test");
    // Revocation deletes the sessions; a late snapshot must not bring the node back.
    await registry().replaceSessions(cId, [{ sessionId: "s-c", runtime: "claude-code", state: "idle" }]);

    const socket = await authenticate(aId, a);
    socket.send(makeEnvelope("directory.get", {}, 1, 0));
    const reply = await socket.next();
    expect(reply.type).toBe("directory");
    expect(isDirectoryBody(reply.body)).toBe(true);
    const body = reply.body as DirectoryBody;
    const ids = body.nodes.map((n) => n.nodeId);
    expect(ids).toEqual(expect.arrayContaining([aId, bId]));
    expect(ids).not.toContain(cId);
    // Issue #441: a measured empty queue, nothing taken yet.
    expect(body.nodes.find((n) => n.nodeId === aId)).toEqual({ nodeId: aId, name: "dir-a", status: "online", intake: EMPTY });
    expect(body.sessions.filter((s) => s.nodeId === bId)).toEqual(
      [{ nodeId: bId, sessionId: "s-b", runtime: "claude-code", state: "idle", name: "review", cwd: "/work" }]);
    expect(body.sessions.some((s) => s.nodeId === cId)).toBe(false);
    expect(body.truncated).toBeUndefined();
    // Issue #408, PR 4: a node relays a proxy answer only to a Worker that names this.
    expect(body.worker).toEqual({ capabilities: [MESSAGING_PROXY_CAPABILITY, "messaging.loop-brake.v1"] });

    socket.send(makeEnvelope("directory.get", { everything: true }, 2, 0));
    expect(await socket.next()).toMatchObject({ type: "error", body: { error: "invalid directory.get body" } });
    socket.ws.close(1000, "done");
  });

  it("reports the oldest queued message and the last intake per node (issue #441)", async () => {
    const sender = await enroll(await newKey(), "intake-sender");
    const target = await enroll(await newKey(), "intake-target");
    await registry().updateRegistration(target, FACTS, [], [MESSAGING_CAPABILITY]);
    expect(await intakeOf(target)).toEqual(EMPTY);
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    for (const messageId of [first, second]) {
      expect(await registry().sendMessage({ messageId, from: { nodeId: sender, session: "s" }, to: { nodeId: target, session: "t" },
        text: "x" }, "test")).toMatchObject({ ok: true, status: { state: "queued" } });
      await tick();
    }
    const created = new Map((await registry().listMessages(target, 10)).map((m) => [m.messageId, new Date(m.createdAt).toISOString()]));
    expect(await intakeOf(target)).toEqual({ lastAcceptedAt: null, oldestQueuedAt: created.get(first), queued: 2 });

    await registry().reportMessageStatus(target, { messageId: first, state: "accepted" });
    const taken = (await intakeOf(target))!;
    expect(taken).toMatchObject({ oldestQueuedAt: created.get(second), queued: 1 });
    expect(Date.parse(taken.lastAcceptedAt!)).toBeGreaterThanOrEqual(Date.parse(created.get(second)!));
    await tick();
    // A refusal from queued counts as an intake (coordinator decision).
    await registry().reportMessageStatus(target, { messageId: second, state: "refused", reason: "not now" });
    const refused = (await intakeOf(target))!;
    expect(refused).toMatchObject({ oldestQueuedAt: null, queued: 0 });
    expect(Date.parse(refused.lastAcceptedAt!)).toBeGreaterThan(Date.parse(taken.lastAcceptedAt!));
    await tick();
    // A duplicate, a progress-only report, accepted -> delivered and a report on a final row take nothing from the queue.
    await registry().reportMessageStatus(target, { messageId: first, state: "accepted" });
    await registry().reportMessageStatus(target, { messageId: first, state: "accepted",
      progress: { phase: "waiting", code: "target-busy", observedAt: new Date().toISOString() } });
    await registry().reportMessageStatus(target, { messageId: first, state: "delivered" });
    await registry().reportMessageStatus(target, { messageId: second, state: "accepted" });
    expect(await intakeOf(target)).toEqual(refused);
  });

  it("shows a connected node that never acknowledges as online with its queue (issue #441)", async () => {
    const [s, t] = [await newKey(), await newKey()];
    const senderId = await enroll(s, "stall-sender");
    const targetId = await enroll(t, "stall-target");
    await registry().updateRegistration(targetId, FACTS, [], [MESSAGING_CAPABILITY]);
    const target = await authenticate(targetId, t);
    const sender = await authenticate(senderId, s);
    const messageId = crypto.randomUUID();
    sender.send(makeEnvelope("message.send", { messageId, fromSession: "s-a", to: { nodeId: targetId, session: "s-b" }, text: "hello" }, 0, 0));
    expect(await target.next()).toMatchObject({ type: "message.deliver", body: { messageId } });
    // The fake node reads the delivery and answers nothing.
    const body = await registry().directory();
    const listed = body.nodes.find((n) => n.nodeId === targetId)!;
    expect(listed.status).toBe("online");
    expect(listed.intake).toMatchObject({ lastAcceptedAt: null, queued: 1 });
    const oldest = Date.parse(listed.intake!.oldestQueuedAt!);
    expect(oldest).toBeLessThanOrEqual(Date.parse(body.fetchedAt));
    // A reader five minutes on sees NOT DRAINING beside the online status; no real channel is blocked.
    expect(intakeState(listed, body, oldest + QUEUE_STALL_MS + 1, 10 * 60_000)).toMatchObject({ state: "stalled", queued: 1 });
    expect(intakeState(listed, body, oldest + QUEUE_STALL_MS - 1_000, 10 * 60_000).state).toBe("waiting");

    target.send(makeEnvelope("message.status", { messageId, state: "accepted" }, 0, 0));
    expect(await target.next()).toMatchObject({ type: "event", body: { name: "message.receipt", storedState: "accepted" } });
    const drained = await intakeOf(targetId);
    expect(drained).toMatchObject({ oldestQueuedAt: null, queued: 0 });
    expect(Date.parse(drained!.lastAcceptedAt!)).toBeGreaterThanOrEqual(oldest);
    target.ws.close(1000, "done");
    sender.ws.close(1000, "done");
  });

  it("omits intake for a node without a measurement and keeps a measured zero (issue #441)", () => {
    const [a, b] = [idOf(1), idOf(2)];
    const body = directoryBody([{ id: a, name: "a", status: "online" }, { id: b, name: "b", status: "online" }], [], 0,
      new Map([[a, EMPTY]]));
    expect(body.nodes[0]).toEqual({ nodeId: a, name: "a", status: "online", intake: EMPTY });
    expect(body.nodes[1]).toEqual({ nodeId: b, name: "b", status: "online" });
    expect(Object.hasOwn(body.nodes[1]!, "intake")).toBe(false);
    expect(isDirectoryBody(body)).toBe(true);
    expect(intakeState(body.nodes[0]!, body, 0, 60_000).state).toBe("empty");
    expect(intakeState(body.nodes[1]!, body, 0, 60_000)).toMatchObject({ state: "unknown", why: "not-reported", queued: null });
  });

  it("keeps a full directory within one frame: sessions first, then intake from the end, then nodes (issue #441)", () => {
    // The cross-review control: 256 nodes with equal 128-character names, no sessions, intake on every node.
    const rows = Array.from({ length: MAX_DIRECTORY_NODES }, (_, i) => ({ id: idOf(i + 1), name: "n".repeat(128), status: "online" }));
    const intake = new Map(rows.map((r) => [r.id, FULL]));
    const body = directoryBody(rows, [], 0, intake);
    expect(frameOf(body).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseEnvelope(frameOf(body)).ok).toBe(true);
    expect(isDirectoryBody(body)).toBe(true);
    expect([body.truncated, body.nodes.length]).toEqual([true, MAX_DIRECTORY_NODES]);
    expect(body.nodes.map((n) => n.nodeId)).toEqual(rows.map((r) => r.id));
    const cut = body.nodes.findIndex((n) => n.intake === undefined);
    expect(cut).toBeGreaterThan(0);
    expect(body.nodes.slice(0, cut).every((n) => n.intake?.queued === 100)).toBe(true);
    expect(body.nodes.slice(cut).some((n) => Object.hasOwn(n, "intake"))).toBe(false);
    expect(directoryBody(rows, [], 0, intake)).toEqual(body);

    // The widest valid nodes without intake still fit untruncated.
    const plain = directoryBody(rows.map((r) => ({ ...r, status: "s".repeat(32) })), [], 0);
    expect([plain.truncated, plain.nodes.length, parseEnvelope(frameOf(plain)).ok]).toEqual([undefined, MAX_DIRECTORY_NODES, true]);

    // A budget too small for every node drops nodes from the end, with their sessions.
    const few = rows.slice(0, 10);
    const sessions = few.map((r) => ({ nodeId: r.id, sessionId: `s-${r.id}`, runtime: "claude-code", state: "idle" }));
    const small = directoryBody(few, sessions, 0, intake, 2_000);
    expect(new TextEncoder().encode(JSON.stringify(small)).length).toBeLessThanOrEqual(2_000);
    expect(small.truncated).toBe(true);
    expect(small.nodes.length).toBeGreaterThan(0);
    expect(small.nodes.length).toBeLessThan(few.length);
    expect(small.nodes.map((n) => n.nodeId)).toEqual(few.slice(0, small.nodes.length).map((r) => r.id));
    const kept = new Set(small.nodes.map((n) => n.nodeId));
    expect(small.sessions.every((s) => kept.has(s.nodeId))).toBe(true);
    expect(directoryBody(few, sessions, 0, intake, 2_000)).toEqual(small);
  });

  it("drops sessions from the end so the directory fits into one frame, before any intake", () => {
    const nodeId = crypto.randomUUID();
    const sessions = Array.from({ length: 400 }, (_, i) => ({ nodeId, sessionId: `s-${i}`, runtime: "claude-code", state: "idle",
      cwd: `/${"x".repeat(400)}` }));
    const body = directoryBody([{ id: nodeId, name: "big", status: "online" }], sessions, 0, new Map([[nodeId, FULL]]));
    expect(body.truncated).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.nodes[0]?.intake).toEqual(FULL);
    expect(JSON.stringify(makeEnvelope("directory", body, 0, 0)).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(isDirectoryBody(body)).toBe(true);
  });
});
