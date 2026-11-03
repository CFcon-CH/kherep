import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { makeEnvelope, type CommandBody } from "../../protocol.mts";
import { ALARM_INTERVAL_MS, MISSED_INTERVALS } from "../src/node-session.mts";
import { authenticate, enroll, newKey, registry, session } from "./helpers.mts";

describe("seq/ack and resend", () => {
  it("resends unacknowledged commands after a reconnect and drops acknowledged ones", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    const first = await authenticate(nodeId, key);

    const a = await session(nodeId).enqueue("node.status");
    expect(a).toMatchObject({ ok: true, seq: 1, delivered: true });
    const delivered = await first.next();
    expect(delivered).toMatchObject({ type: "command", seq: 1, body: { command: "node.status" } });
    first.ws.close(1000, "network drop");
    await first.closed;

    const b = await session(nodeId).enqueue("runtime.list");
    expect(b).toMatchObject({ ok: true, seq: 2, delivered: false });

    // Reconnect without acknowledging anything: both commands come back, in order, same ids.
    const second = await authenticate(nodeId, key, 0);
    const resent = [await second.next(), await second.next()];
    expect(resent.map((e) => e.seq)).toEqual([1, 2]);
    expect(resent[0].id).toBe(delivered.id);

    // Acknowledge seq 1 only, then reconnect: only seq 2 is resent.
    second.send(makeEnvelope("command.ack", { commandId: (resent[0].body as CommandBody).commandId }, 1, 1));
    await expect(second.next(200)).rejects.toThrow();
    second.ws.close(1000, "again");
    await second.closed;
    const third = await authenticate(nodeId, key, 1);
    const again = await third.next();
    expect(again.seq).toBe(2);
    await expect(third.next(200)).rejects.toThrow();

    // A result completes the command and removes it from the log.
    third.send(makeEnvelope("command.result",
      { commandId: (again.body as CommandBody).commandId, ok: true, result: [{ name: "codex", kind: "cli" }] }, 1, 2));
    await expect(third.next(200)).rejects.toThrow();
    expect((await session(nodeId).status()).pending).toBe(0);
    expect((await registry().getNode(nodeId))?.runtimes).toEqual([{ name: "codex", kind: "cli" }]);
    third.ws.close(1000, "done");
  });

  it("refuses a command outside the Phase 1 allowlist at the object", async () => {
    const nodeId = await enroll(await newKey());
    // Deliberately outside the type: the object must check at runtime too.
    const result = await session(nodeId).enqueue("shell.exec" as "node.status");
    expect(result).toEqual({ ok: false, error: "command not allowed" });
  });
});

describe("offline detection", () => {
  it("re-arms the alarm while the node is active", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    const socket = await authenticate(nodeId, key);
    expect(await runDurableObjectAlarm(session(nodeId))).toBe(true);
    expect((await registry().getNode(nodeId))?.status).toBe("online");
    const alarm = await runInDurableObject(session(nodeId), (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    socket.ws.close(1000, "done");
  });

  it("marks a node offline after three missed intervals and stops the alarm", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    const socket = await authenticate(nodeId, key);
    socket.ws.close(1000, "gone");
    await socket.closed;
    await runInDurableObject(session(nodeId), (_i, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'lastSeen'",
        String(Date.now() - MISSED_INTERVALS * ALARM_INTERVAL_MS - 1000));
    });
    expect(await runDurableObjectAlarm(session(nodeId))).toBe(true);
    expect((await registry().getNode(nodeId))?.status).toBe("offline");
    const alarm = await runInDurableObject(session(nodeId), (_i, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();
  });
});

for (const event of ["old-close", "old-alarm", "closed-new", "revoke"] as const) it(`status epoch fences ${event} after replacement`, async () => {
  const nodeId = await enroll(await newKey()), r = registry();
  const old = "synthetic-old-epoch", current = "synthetic-new-epoch";
  expect(await r.beginMessageConnection(nodeId, old)).toBe(true);
  await r.setStatus(nodeId, "online", 1, old);
  await r.invalidateMessageConnection(nodeId, old);
  expect(await r.beginMessageConnection(nodeId, current)).toBe(true);
  await r.setStatus(nodeId, "online", 2, current);
  if (event === "closed-new") await r.invalidateMessageConnection(nodeId, current);
  if (event === "revoke") await r.revoke(nodeId, "synthetic");
  await r.invalidateMessageConnection(nodeId, old);
  await r.setStatus(nodeId, "offline", 3, old);
  expect((await r.getNode(nodeId))?.status).toBe(event === "revoke" ? "revoked" : "online");
  const tokens = await runInDurableObject(r, (_i, state) => state.storage.sql.exec(
    "SELECT message_connection_token,registration_token,status_connection_token FROM nodes WHERE id=?", nodeId).one());
  expect(tokens.registration_token).toBeNull();
  expect(tokens.message_connection_token).toBe(event === "revoke" || event === "closed-new" ? null : current);
  expect(tokens.status_connection_token).toBe(event === "revoke" ? null : current);
  if (event !== "revoke") {
    await r.invalidateMessageConnection(nodeId, current);
    await r.setStatus(nodeId, "online", 4, current);
    expect((await r.getNode(nodeId))?.lastSeen).toBe(2);
    // A closed epoch cannot regain online authority, but owns its offline alarm.
    await r.setStatus(nodeId, "offline", 5, current);
    expect((await r.getNode(nodeId))?.status).toBe("offline");
    const after = await runInDurableObject(r, (_i, state) => state.storage.sql.exec(
      "SELECT message_connection_token,registration_token,status_connection_token FROM nodes WHERE id=?", nodeId).one());
    expect(after).toEqual({ message_connection_token: null, registration_token: null, status_connection_token: null });
    await r.setStatus(nodeId, "online", 6, current);
    expect((await r.getNode(nodeId))?.status).toBe("offline");
  }
});
