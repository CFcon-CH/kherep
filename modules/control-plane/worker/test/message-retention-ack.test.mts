import { describe, expect, it } from "vitest";

import { type MessageStatusBody } from "../../protocol-messages.mts";
import { authenticate, nextMessageStatus, registry, until } from "./helpers.mts";
import {
  ack, acked, deletedByAck, deletes, deliveredMessage, frame, holdNext, node, pair, query, receipt, reported, row, settles, sync,
  tombstone,
} from "./message-retention-fixture.mts";

// Issue #308, PR 4: a message row is deleted once its sender acknowledged the
// final status; the overtaking regressions of issues #529, #557 and #569.

describe("deletion after the sender's acknowledgement", () => {
  it("deletes an acknowledged final row into a metadata-only tombstone, once", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    expect(await row(id)).toMatchObject({ deletable: 1, depth: 0, delete_after: null });
    ack(sender, id, "delivered");
    await deletedByAck(id, a.nodeId, b.nodeId);
    const stone = await tombstone(id);
    expect(stone).toMatchObject({ from_node: a.nodeId, to_node: b.nodeId, state: "delivered", depth: 0 });
    expect(Object.keys(stone ?? {}).sort()).toEqual(["deleted_at", "depth", "from_node", "id", "loop_direction", "loop_generation", "loop_ordinal", "loop_pair", "loop_thread", "reason", "reply_message_id", "state", "to_node"]);
    expect(await deletes(id)).toEqual([{ actor: `node:${a.nodeId}`, detail: JSON.stringify({ messageId: id, via: "ack" }) }]);
    expect(await settles(id)).toEqual([]); // issue #493: a deletable row is deleted, never settled
    expect((await registry().listMessages(a.nodeId, 100)).map((m) => m.messageId)).not.toContain(id);
    // Idempotent: a repeated ack changes nothing.
    await acked(a.nodeId, id, "delivered");
    expect(await tombstone(id)).toEqual(stone);
    expect(await deletes(id)).toHaveLength(1);
  });

  it("ignores acks from another node, for another state or an unknown id, and refuses invalid bodies", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    await acked(b.nodeId, id, "delivered"); // another node
    await acked(a.nodeId, id, "refused"); // another state
    await acked(a.nodeId, crypto.randomUUID(), "delivered"); // an unknown id
    expect(await row(id)).toMatchObject({ state: "delivered" });
    ack(sender, id, "accepted");
    const [error] = await sync(sender); // the validator's error is sent before any await, so it precedes the directory answer
    expect(error).toMatchObject({ type: "error", body: { error: "invalid message.status.ack body" } });
    expect(await row(id)).toMatchObject({ state: "delivered" });
  });

  it("keeps the row for an offline sender until the reconnect replay is acknowledged", async () => {
    const { a, sender, target, b } = await pair();
    const id = crypto.randomUUID();
    frame(sender, "message.send", { messageId: id, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    await nextMessageStatus(sender, { messageId: id, state: "queued" });
    sender.ws.close(1000, "offline");
    await until(target, "message.deliver", { messageId: id });
    frame(target, "message.status", { messageId: id, state: "delivered" });
    await receipt(target, id, "delivered", "delivered");
    expect(await row(id)).toMatchObject({ state: "delivered", delete_after: null });
    const back = await authenticate(a.nodeId, a.key);
    expect(await nextMessageStatus(back, { messageId: id, state: "delivered" })).toEqual({ messageId: id, state: "delivered" });
    ack(back, id, "delivered");
    await deletedByAck(id, a.nodeId, b.nodeId);
  });

  it("answers a late resend and a late target report from the tombstone, and after the prune", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    ack(sender, id, "delivered");
    await deletedByAck(id, a.nodeId, b.nodeId);
    frame(sender, "message.send", { messageId: id, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    expect((await until(sender, "message.status", { messageId: id, state: "delivered" })).map((envelope) => [envelope.type, envelope.body]))
      .toEqual([["message.status", { messageId: id, state: "delivered" } satisfies MessageStatusBody]]);
    expect(await sync(sender)).toEqual([]); // no second frame for the sender before its directory answer
    expect(await row(id)).toBeUndefined(); // answered from the tombstone: no row came back
    expect(await sync(target)).toEqual([]); // nothing for the target before its directory answer
    const other = await node("retention-foreign");
    const foreign = await authenticate(other.nodeId, other.key);
    frame(foreign, "message.send", { messageId: id, fromSession: "s-c", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    const refused = await until(foreign, "error", { messageId: id });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ type: "error", body: { error: "duplicate messageId", messageId: id } });

    frame(target, "message.status", { messageId: id, state: "delivered" });
    await receipt(target, id, "delivered", "delivered");
    await reported(other.nodeId, id, "delivered"); // a tombstone of another target: no receipt (lateReceipt)
    await query((sql) => sql.exec("DELETE FROM message_tombstones WHERE id = ?", id));
    frame(target, "message.status", { messageId: id, state: "accepted" });
    await receipt(target, id, "accepted", "expired");
  });

  // Issue #529: the status of a resend reaches the socket after the answer to a
  // later directory.get. The hold forces that order; sync() alone misses the status.
  it("answers a resend whose status a directory answer overtakes", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    ack(sender, id, "delivered");
    await deletedByAck(id, a.nodeId, b.nodeId);
    const hold = await holdNext("sendMessage", "after");
    try {
      frame(sender, "message.send", { messageId: id, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
      expect(await sync(sender)).toEqual([]); // the failure shape of CI run 39371064143: the directory answer comes first under the hold
      hold.release();
      expect((await until(sender, "message.status", { messageId: id, state: "delivered" })).map((e) => [e.type, e.body]))
        .toEqual([["message.status", { messageId: id, state: "delivered" } satisfies MessageStatusBody]]);
      expect(await row(id)).toBeUndefined();
      expect(await sync(sender)).toEqual([]);
    } finally {
      hold.release();
      await hold.restore();
    }
  });

  // Issue #557: an ack has no answer frame, and the directory answer may be
  // handled before it. The hold forces that order; sync() alone proves nothing.
  it("deletes after an ack that a directory answer overtakes", async () => {
    const { a, sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    const hold = await holdNext("ackMessageStatus", "before");
    try {
      ack(sender, id, "delivered");
      expect(await sync(sender)).toEqual([]);
      expect(await row(id)).toMatchObject({ state: "delivered" }); // after sync(): the row is still there, the old barrier passed falsely
      hold.release();
      await deletedByAck(id, a.nodeId, b.nodeId);
      expect(await deletes(id)).toHaveLength(1);
    } finally {
      hold.release();
      await hold.restore();
    }
  });

  // Issue #569: a target's report is answered by a receipt, sent after the
  // Registry's RPC returned, and the directory answer may be handled before
  // both. The hold forces that order; sync() alone proves nothing and leaves
  // the receipt in the socket's queue.
  it("stores a target's report that a directory answer overtakes", async () => {
    const { sender, target, b } = await pair();
    const id = crypto.randomUUID();
    frame(sender, "message.send", { messageId: id, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    await nextMessageStatus(sender, { messageId: id, state: "queued" });
    await until(target, "message.deliver", { messageId: id });
    const hold = await holdNext("reportMessageStatus", "before");
    try {
      frame(target, "message.status", { messageId: id, state: "delivered" });
      expect(await sync(target)).toEqual([]);
      expect(await row(id)).toMatchObject({ state: "queued" }); // after sync(): the report has not run, the old barrier passed falsely
      hold.release();
      await receipt(target, id, "delivered", "delivered");
      expect(await row(id)).toMatchObject({ state: "delivered", deletable: 1 });
      expect(await nextMessageStatus(sender, { messageId: id, state: "delivered" })).toEqual({ messageId: id, state: "delivered" });
    } finally {
      hold.release();
      await hold.restore();
    }
  });

  it("until() names the frames seen when the awaited frame never comes", async () => {
    const { sender, target, b } = await pair();
    const id = await deliveredMessage(sender, target, b.nodeId);
    ack(sender, id, "accepted"); // refused by the frame validator: one error frame, then silence
    await expect(until(sender, "message.status", { messageId: id, state: "replied" })).rejects.toThrow(
      /^no message\.status \{"messageId":"[^"]+","state":"replied"\} after \[\["error",\{"error":"invalid message\.status\.ack body"\}\]\]$/);
  });
});
