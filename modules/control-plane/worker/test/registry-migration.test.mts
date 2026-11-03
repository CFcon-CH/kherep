import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { MessageStore } from "../src/message-store.mts";
import { ADDED_SESSION_COLUMNS, migrateRegistry } from "../src/registry-schema.mts";
import { enroll, newKey, registry } from "./helpers.mts";

const columns = (sql: SqlStorage) => sql.exec("PRAGMA table_info(sessions)").toArray().map((c) => String(c.name));

describe("Registry sessions migration", () => {
  it("adds name, cwd, kind, label and title to a sessions table from an earlier deployment, once", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      // The Phase 1 table, with a row that must survive.
      sql.exec("DROP TABLE sessions");
      sql.exec(`CREATE TABLE sessions (node_id TEXT NOT NULL, session_id TEXT NOT NULL, runtime TEXT NOT NULL, state TEXT NOT NULL,
        started_at TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (node_id, session_id))`);
      sql.exec("INSERT INTO sessions (node_id, session_id, runtime, state, updated_at) VALUES ('n', 's', 'claude', 'running', 1)");
      for (const column of ADDED_SESSION_COLUMNS) expect(columns(sql)).not.toContain(column);

      migrateRegistry(sql);
      expect(columns(sql)).toEqual(expect.arrayContaining([...ADDED_SESSION_COLUMNS]));
      // A second start finds the columns and changes nothing.
      migrateRegistry(sql);
      expect(columns(sql).length).toBe(12);
      expect(sql.exec("SELECT canonical_identity FROM sessions").one().canonical_identity).toBeNull();
      expect(sql.exec("SELECT session_id, name, cwd, kind, label, title FROM sessions").toArray())
        .toEqual([{ session_id: "s", name: null, cwd: null, kind: null, label: null, title: null }]);
    });
  });

  // Issue #441: the last intake of a node, written only by the Worker.
  it("adds last_accepted_at to a nodes table from an earlier deployment, once", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      const nodeColumns = () => sql.exec("PRAGMA table_info(nodes)").toArray().map((c) => String(c.name));
      sql.exec("DROP TABLE nodes");
      sql.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT, status TEXT NOT NULL DEFAULT 'offline',
        hostname TEXT, os TEXT, arch TEXT, cpus INTEGER, memory_bytes INTEGER, capabilities TEXT NOT NULL DEFAULT '[]',
        enrolled_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER)`);
      sql.exec("INSERT INTO nodes (id, name, enrolled_at) VALUES ('n', 'earlier', 1)");
      const addedColumns = [
        "message_connection_token", "identity_digest", "registration_token", "last_accepted_at", "identity_generation",
      ];
      const schema = () => sql.exec("PRAGMA table_info(nodes)").toArray();
      const oldColumns = nodeColumns();
      const oldRow = sql.exec("SELECT * FROM nodes WHERE id=?", "n").one();
      expect(oldColumns).toHaveLength(13);
      for (const name of addedColumns) expect(oldColumns).not.toContain(name);
      expect(nodeColumns()).not.toContain("last_accepted_at");

      migrateRegistry(sql);
      expect(nodeColumns()).toContain("last_accepted_at");
      expect([...nodeColumns()].sort()).toEqual([...oldColumns, ...addedColumns].sort());
      const firstSchema = schema();
      for (const name of addedColumns) {
        expect(firstSchema.filter((column) => column.name === name)).toHaveLength(1);
        expect(firstSchema.find((column) => column.name === name)).toMatchObject({
          type: name === "last_accepted_at" || name === "identity_generation" ? "INTEGER" : "TEXT",
          notnull: 0, dflt_value: null,
        });
      }
      const firstRow = sql.exec("SELECT * FROM nodes WHERE id=?", "n").one();
      expect(firstRow).toEqual({
        ...oldRow, message_connection_token: null, identity_digest: null, registration_token: null,
        last_accepted_at: null, identity_generation: null,
      });

      migrateRegistry(sql);
      expect(schema()).toEqual(firstSchema);
      expect(sql.exec("SELECT * FROM nodes WHERE id=?", "n").one()).toEqual(firstRow);
      expect(sql.exec("SELECT identity_generation, identity_digest, registration_token, message_connection_token FROM nodes").one())
        .toEqual({ identity_generation: null, identity_digest: null, registration_token: null, message_connection_token: null });
      expect(sql.exec("SELECT id, name, last_accepted_at FROM nodes").toArray()).toEqual([{ id: "n", name: "earlier", last_accepted_at: null }]);
    });
  });

  // Issue #493: settled_state and the partial replay index on a messages table of
  // an earlier deployment; the index can only follow the column.
  it("adds settled_state and the messages_replay index to an earlier messages table, and keeps settled rows on a restart", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      const ids = (page: ReturnType<MessageStore["statusPageFor"]>) => page.effects.statuses.map((s) => s.body.messageId);
      sql.exec("DROP TABLE messages");
      sql.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, from_node TEXT NOT NULL, from_session TEXT NOT NULL, to_node TEXT NOT NULL,
        to_session TEXT NOT NULL, in_reply_to TEXT, text TEXT, state TEXT NOT NULL, reason TEXT, progress_phase TEXT, progress_code TEXT,
        progress_observed_at TEXT, progress_retry_at TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX messages_to_state ON messages (to_node, state, created_at);
        CREATE INDEX messages_queued_expiry ON messages (expires_at) WHERE state = 'queued';
        CREATE INDEX messages_from_node ON messages (from_node);
        CREATE INDEX messages_state_updated ON messages (state, updated_at);`);
      const later = Date.now() + 60 * 60_000;
      sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, state, created_at, updated_at, expires_at)
        VALUES ('old-delivered', 'sender', 's', 'target', 't', 'delivered', 1, 1, ?), ('old-queued', 'sender', 's', 'target', 't', 'queued', 2, 2, ?)`,
      later, later);
      const columns = () => sql.exec("PRAGMA table_info(messages)").toArray().map((c) => String(c.name));
      expect(columns()).not.toContain("settled_state");

      const capabilities = (nodeId: string) => (nodeId === "target" ? [MESSAGING_CAPABILITY] : null);
      let store = new MessageStore(sql, () => {}, capabilities);
      expect(columns()).toContain("settled_state");
      expect(String(sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages_replay'").one().sql))
        .toMatch(/ON messages \(from_node\) WHERE settled_state IS NOT state$/);
      expect(sql.exec("SELECT id, settled_state FROM messages ORDER BY rowid").toArray())
        .toEqual([{ id: "old-delivered", settled_state: null }, { id: "old-queued", settled_state: null }]);
      expect(ids(store.statusPageFor("sender", 0, 32))).toEqual(["old-delivered", "old-queued"]);

      // A settled row stays settled when the Registry starts again.
      sql.exec("UPDATE messages SET settled_state = 'delivered' WHERE id = 'old-delivered'");
      store = new MessageStore(sql, () => {}, capabilities);
      expect(sql.exec("SELECT settled_state FROM messages WHERE id = 'old-delivered'").one().settled_state).toBe("delivered");
      expect(ids(store.statusPageFor("sender", 0, 32))).toEqual(["old-queued"]);

      // New rows start unsettled, queued or refused at once.
      const send = (messageId: string, to: string) => store.send({ messageId, from: { nodeId: "sender", session: "s" },
        to: { nodeId: to, session: "t" }, text: "synthetic" }, "test", Date.now());
      expect(send("new-queued", "target")).toMatchObject({ ok: true, status: { state: "queued" } });
      expect(send("new-refused", "unknown")).toMatchObject({ ok: true, status: { state: "refused" } });
      expect(sql.exec("SELECT id, settled_state FROM messages WHERE id LIKE 'new-%' ORDER BY rowid").toArray())
        .toEqual([{ id: "new-queued", settled_state: null }, { id: "new-refused", settled_state: null }]);
    });
  });

  it("stores and returns the new session fields, and omits them when absent", async () => {
    const nodeId = await enroll(await newKey());
    await registry().replaceSessions(nodeId, [
      { sessionId: "a", runtime: "claude-code", state: "running", name: "review", cwd: "/work/repo", kind: "interactive",
        label: "intercom: claude@sekhmet" },
      { sessionId: "b", runtime: "claude-code", state: "idle" },
      { sessionId: "c", runtime: "codex", state: "active", name: "codex-d7d07717", title: "Kherep-Funktionen nachschlagen" },
    ]);
    const mine = (await registry().listSessions()).filter((s) => s.nodeId === nodeId);
    expect(mine).toEqual([
      expect.objectContaining({ sessionId: "a", name: "review", cwd: "/work/repo", kind: "interactive", label: "intercom: claude@sekhmet" }),
      expect.not.objectContaining({ name: expect.anything() }),
      expect.objectContaining({ sessionId: "c", name: "codex-d7d07717", title: "Kherep-Funktionen nachschlagen" }),
    ]);
    expect(mine[1]).not.toHaveProperty("cwd");
    expect(mine[0]).not.toHaveProperty("title");
    // The directory frame nodes read carries the title (issue #88).
    const directory = await registry().directory();
    expect(directory.sessions.find((s) => s.sessionId === "c")).toMatchObject({ title: "Kherep-Funktionen nachschlagen" });
  });
});
