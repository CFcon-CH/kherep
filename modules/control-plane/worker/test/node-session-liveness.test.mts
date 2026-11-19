import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { NONCE_TTL_MS, PING_FRAME } from "../../protocol.mts";
import { CLOSE, type Attachment } from "../src/handshake.mts";
import { ALARM_INTERVAL_MS, DELIVERY_RETRY_MS, MISSED_INTERVALS } from "../src/node-session.mts";
import { authenticate, connect, enroll, newKey, registry, session } from "./helpers.mts";

// Issue #965: liveness branches of NodeSession: the alarm on a node that is
// not online, without a socket, with missing metadata, and kept online only by
// the runtime's ping auto-response; and the stale-handshake sweep.
const OLD = () => String(Date.now() - MISSED_INTERVALS * ALARM_INTERVAL_MS - 1000);
const meta = (nodeId: string, sql: string, ...params: string[]) =>
  runInDurableObject(session(nodeId), (_i, state) => { state.storage.sql.exec(sql, ...params); });
const alarmAt = (nodeId: string) => runInDurableObject(session(nodeId), (_i, state) => state.storage.getAlarm());

async function closedOnline(): Promise<string> {
  const key = await newKey();
  const nodeId = await enroll(key);
  const socket = await authenticate(nodeId, key);
  socket.ws.close(1000, "gone");
  await socket.closed;
  return nodeId;
}

describe("NodeSession alarm", () => {
  it("does nothing and does not re-arm for a node that was never online", async () => {
    const nodeId = await enroll(await newKey());
    await runInDurableObject(session(nodeId), (_i, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(session(nodeId))).toBe(true);
    expect(await alarmAt(nodeId)).toBeNull();
    expect(await session(nodeId).status()).toMatchObject({ status: null, connected: false });
  });

  it("re-arms at the idle interval while online without a socket", async () => {
    const nodeId = await closedOnline();
    const before = Date.now();
    expect(await runDurableObjectAlarm(session(nodeId))).toBe(true);
    expect((await registry().getNode(nodeId))?.status).toBe("online");
    // No socket means no delivery pass: the next alarm is the idle interval, not the retry.
    expect(await alarmAt(nodeId)).toBeGreaterThanOrEqual(before + ALARM_INTERVAL_MS);
    expect(ALARM_INTERVAL_MS).toBeGreaterThan(DELIVERY_RETRY_MS);
  });

  it("treats a missing lastSeen as never seen and goes offline", async () => {
    const nodeId = await closedOnline();
    await meta(nodeId, "DELETE FROM meta WHERE key IN ('lastSeen', 'connectionToken')");
    expect(await runDurableObjectAlarm(session(nodeId))).toBe(true);
    expect(await session(nodeId).status()).toMatchObject({ status: "offline", lastSeen: null });
    expect(await alarmAt(nodeId)).toBeNull();
  });

  it("goes offline without a Registry update when the node id is missing", async () => {
    const nodeId = await closedOnline();
    await meta(nodeId, "UPDATE meta SET value = ? WHERE key = 'lastSeen'", OLD());
    await meta(nodeId, "DELETE FROM meta WHERE key = 'nodeId'");
    expect(await runDurableObjectAlarm(session(nodeId))).toBe(true);
    expect((await session(nodeId).status()).status).toBe("offline");
    expect((await registry().getNode(nodeId))?.status).toBe("online");
  });

  it("stays online on a ping answered by the auto-response alone", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    const socket = await authenticate(nodeId, key);
    socket.ws.send(PING_FRAME);
    await vi.waitFor(async () => {
      const stamps = await runInDurableObject(session(nodeId), (_i, state) =>
        state.getWebSockets().map((ws) => state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null));
      expect(stamps.some((stamp) => stamp !== null)).toBe(true);
    });
    await meta(nodeId, "UPDATE meta SET value = ? WHERE key = 'lastSeen'", OLD());
    expect(await runDurableObjectAlarm(session(nodeId))).toBe(true);
    expect((await session(nodeId).status()).status).toBe("online");
    expect((await registry().getNode(nodeId))?.status).toBe("online");
    socket.ws.close(1000, "done");
  });
});

describe("NodeSession stale handshake sweep", () => {
  it("closes unauthenticated sockets whose nonce is stale or missing on the next connect", async () => {
    const nodeId = await enroll(await newKey());
    const stale = await connect(nodeId), missing = await connect(nodeId);
    await runInDurableObject(session(nodeId), (_i, state) => {
      const [first, second] = state.getWebSockets();
      first.serializeAttachment({ ...first.deserializeAttachment() as Attachment, nonceIssuedAt: Date.now() - NONCE_TTL_MS - 1000 });
      const { nonceIssuedAt: _dropped, ...rest } = second.deserializeAttachment() as Attachment;
      second.serializeAttachment(rest);
    });
    const fresh = await connect(nodeId);
    expect((await stale.socket.closed).code).toBe(CLOSE.nonceExpired);
    expect((await missing.socket.closed).code).toBe(CLOSE.nonceExpired);
    fresh.socket.ws.close(1000, "done");
  });
});
