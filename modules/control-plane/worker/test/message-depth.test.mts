import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { MAX_REPLY_DEPTH, MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { MessageStore } from "../src/message-store.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

// Issue #308, PR 4: the Worker stores the reply depth of every message itself.
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const depthOf = (id: string) => query((sql) => sql.exec("SELECT depth, state, reason FROM messages WHERE id = ?", id).toArray()[0]);

async function nodes() {
  const a = await enroll(await newKey(), "depth-a");
  const b = await enroll(await newKey(), "depth-b");
  for (const id of [a, b]) await registry().updateRegistration(id, FACTS, [], [MESSAGING_CAPABILITY]);
  const send = async (from: string, to: string, inReplyTo?: string) => {
    const messageId = crypto.randomUUID();
    expect((await registry().sendMessage({ messageId, from: { nodeId: from, session: "s" }, to: { nodeId: to, session: "s" },
      text: "synthetic", ...(inReplyTo ? { inReplyTo } : {}) }, "test")).ok).toBe(true);
    return messageId;
  };
  return { a, b, send };
}

it("derives the depth from the parent row, its tombstone, or restarts at 1 for an unknown parent", async () => {
  const { a, b, send } = await nodes();
  const root = await send(a, b);
  const reply = await send(b, a, root);
  expect(await depthOf(root)).toMatchObject({ depth: 0, state: "replied" });
  expect(await depthOf(reply)).toMatchObject({ depth: 1, state: "queued" });

  await query((sql) => sql.exec(`INSERT INTO message_tombstones (id, from_node, to_node, state, depth, deleted_at)
    VALUES ('gone', ?, ?, 'delivered', 3, ?)`, a, b, Date.now()));
  expect(await depthOf(await send(b, a, "gone"))).toMatchObject({ depth: 4, state: "queued" });
  expect(await depthOf(await send(b, a, crypto.randomUUID()))).toMatchObject({ depth: 1, state: "queued" });

  // A parent stored before the depth column counts as 0.
  await query((sql) => sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, state, created_at, updated_at,
    expires_at) VALUES ('legacy-parent', ?, 's', ?, 's', 'delivered', 1, 1, 1)`, a, b));
  expect(await depthOf(await send(b, a, "legacy-parent"))).toMatchObject({ depth: 1, state: "queued" });
});

it("stores a reply beyond MAX_REPLY_DEPTH as refused, whatever the node claims", async () => {
  const { a, b, send } = await nodes();
  await query((sql) => sql.exec(`INSERT INTO message_tombstones (id, from_node, to_node, state, depth, deleted_at)
    VALUES ('deep', ?, ?, 'delivered', ?, ?)`, a, b, MAX_REPLY_DEPTH - 1, Date.now()));
  const last = await send(b, a, "deep");
  expect(await depthOf(last)).toMatchObject({ depth: MAX_REPLY_DEPTH, state: "queued" });
  const beyond = await send(a, b, last);
  expect(await depthOf(beyond)).toMatchObject({ depth: MAX_REPLY_DEPTH + 1, state: "refused", reason: "reply depth exceeded" });
});

it("adds the retention columns and the tombstone table once and leaves earlier rows unmarked", async () => {
  await query((sql) => {
    const columns = () => sql.exec("PRAGMA table_info(messages)").toArray().map((column) => String(column.name));
    sql.exec("DROP TABLE messages");
    sql.exec("DROP TABLE IF EXISTS message_tombstones");
    sql.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, from_node TEXT NOT NULL, from_session TEXT NOT NULL,
      to_node TEXT NOT NULL, to_session TEXT NOT NULL, in_reply_to TEXT, text TEXT, state TEXT NOT NULL, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, state, created_at, updated_at, expires_at)
      VALUES ('legacy', 'a', 'sa', 'b', 'sb', 'delivered', 1, 1, 9999999999999)`);
    new MessageStore(sql, () => {}, () => null);
    new MessageStore(sql, () => {}, () => null);
    for (const name of ["depth", "delete_after", "deletable"]) expect(columns().filter((c) => c === name), name).toHaveLength(1);
    expect(sql.exec("SELECT depth, delete_after, deletable FROM messages WHERE id = 'legacy'").toArray())
      .toEqual([{ depth: null, delete_after: null, deletable: null }]);
    const indexes = sql.exec("SELECT name FROM sqlite_master WHERE type = 'index'").toArray().map((r) => String(r.name));
    expect(indexes).toEqual(expect.arrayContaining(["messages_delete_after", "tombstones_deleted_at"]));
    expect(sql.exec("PRAGMA table_info(message_tombstones)").toArray().map((c) => String(c.name)))
      .toEqual(["id", "from_node", "to_node", "state", "reason", "depth", "reply_message_id", "deleted_at", "loop_thread", "loop_pair", "loop_generation", "loop_ordinal", "loop_direction"]);
  });
});

it("resolves task-control provenance of a deleted message from its tombstone", async () => {
  const id = crypto.randomUUID();
  await query((sql) => {
    sql.exec(`INSERT INTO message_tombstones (id, from_node, to_node, state, depth, deleted_at)
      VALUES (?, 'owner-node', 'target-node', 'delivered', 0, ?)`, id, Date.now());
    const store = new MessageStore(sql, () => {}, () => null);
    expect(store.taskControlSource(id)).toEqual({ ownerNodeId: "owner-node", targetNodeId: "target-node" });
    expect(store.taskControlSource(crypto.randomUUID())).toBeNull();
  });
});
