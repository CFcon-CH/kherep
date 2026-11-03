import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { makeEnvelope, type SessionInfo } from "../../protocol.mts";
import { authenticate, enroll, newKey, registry, session } from "./helpers.mts";

const changes = (sql: SqlStorage): number =>
  Number(sql.exec("SELECT total_changes() AS count").toArray()[0]?.count ?? 0);

async function reconcile(nodeId: string, sessions: SessionInfo[]): Promise<number> {
  return runInDurableObject(registry(), (instance, state) => {
    const before = changes(state.storage.sql);
    instance.replaceSessions(nodeId, sessions);
    return changes(state.storage.sql) - before;
  });
}

async function stored(nodeId: string) {
  return (await registry().listSessions()).filter((row) => row.nodeId === nodeId);
}

describe("session snapshot write budget", () => {
  it("does not rewrite unchanged or reordered rows and updates only changed metadata", async () => {
    const nodeId = await enroll(await newKey());
    const a: SessionInfo = {
      sessionId: "a", runtime: "codex", state: "active", startedAt: "2026-09-29T10:00:00.000Z",
      name: "alpha", cwd: "/synthetic/a", kind: "interactive", label: "alpha", title: "Alpha",
    };
    const b: SessionInfo = {
      sessionId: "b", runtime: "claude-code", state: "idle", name: "beta", title: "Beta",
    };

    expect(await reconcile(nodeId, [a, b])).toBe(2);
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET updated_at = 41 WHERE node_id = ? AND session_id = 'a'", nodeId);
      state.storage.sql.exec("UPDATE sessions SET updated_at = 42 WHERE node_id = ? AND session_id = 'b'", nodeId);
    });

    expect(await reconcile(nodeId, [a, b])).toBe(0);
    expect(await reconcile(nodeId, [b, a])).toBe(0);
    expect((await stored(nodeId)).map((row) => row.updatedAt)).toEqual([41, 42]);

    expect(await reconcile(nodeId, [{ ...a, state: "idle" }, b])).toBe(1);
    expect(await reconcile(nodeId, [{ ...a, state: "idle", title: "Alpha changed" }, b])).toBe(1);
    const { name: _name, title: _title, ...withoutNullable } = a;
    expect(await reconcile(nodeId, [{ ...withoutNullable, state: "idle" }, b])).toBe(1);
    expect(await stored(nodeId)).toEqual([
      expect.objectContaining({ sessionId: "a", state: "idle" }),
      expect.objectContaining({ sessionId: "b", state: "idle", title: "Beta" }),
    ]);
    expect((await stored(nodeId))[0]).not.toHaveProperty("name");
    expect((await stored(nodeId))[0]).not.toHaveProperty("title");
  });

  it("bounds add, remove and empty snapshots to the affected rows", async () => {
    const nodeId = await enroll(await newKey());
    const a: SessionInfo = { sessionId: "a", runtime: "codex", state: "active" };
    const b: SessionInfo = { sessionId: "b", runtime: "codex", state: "idle" };
    const c: SessionInfo = { sessionId: "c", runtime: "claude-code", state: "idle" };

    expect(await reconcile(nodeId, [a, b])).toBe(2);
    expect(await reconcile(nodeId, [a, c])).toBe(2);
    expect((await stored(nodeId)).map((row) => row.sessionId)).toEqual(["a", "c"]);
    expect(await reconcile(nodeId, [])).toBe(2);
    expect(await stored(nodeId)).toEqual([]);
    expect(await reconcile(nodeId, [])).toBe(0);
  });

  it("rejects duplicate IDs before deduplication without changing stored rows", async () => {
    const nodeId = await enroll(await newKey());
    const snapshot: SessionInfo[] = [
      { sessionId: "same", runtime: "codex", state: "active" },
      { sessionId: "same", runtime: "claude-code", state: "idle" },
    ];
    expect(await registry().replaceSessions(nodeId, snapshot)).toEqual({ ok: false, code: "IDENTITY_SNAPSHOT_REJECTED" });
    expect(await stored(nodeId)).toEqual([]);
  });
});

describe("duplicate frame write budget", () => {
  it("processes a newer ack without rewriting lastSeen or dispatching the duplicate body", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    const socket = await authenticate(nodeId, key);

    const first = await session(nodeId).enqueue("node.status");
    expect(first).toMatchObject({ ok: true, seq: 1, delivered: true });
    await socket.next();
    socket.send(makeEnvelope("command.ack", { commandId: first.ok ? first.commandId : "" }, 1, 1));
    await expect.poll(async () => (await session(nodeId).status()).pending).toBe(0);

    const second = await session(nodeId).enqueue("runtime.list");
    expect(second).toMatchObject({ ok: true, seq: 2, delivered: true });
    await socket.next();

    const before = await runInDurableObject(session(nodeId), (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '123' WHERE key = 'lastSeen'");
      return changes(state.storage.sql);
    });
    socket.send(makeEnvelope("command.ack", { commandId: second.ok ? second.commandId : "" }, 1, 2));
    await expect.poll(async () => (await session(nodeId).status()).pending).toBe(0);

    const result = await runInDurableObject(session(nodeId), (instance, state) => ({
      writes: changes(state.storage.sql) - before,
      lastSeen: instance.status().lastSeen,
      secondState: instance.recentCommands().find((command) => command.commandId === (second.ok ? second.commandId : ""))?.state,
    }));
    expect(result).toEqual({ writes: 1, lastSeen: 123, secondState: "pending" });
    socket.ws.close(1000, "done");
  });
});
