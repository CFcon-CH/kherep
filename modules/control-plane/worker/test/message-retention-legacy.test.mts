import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MESSAGE_STATUS_ACK, OPERATOR_NODE_ID } from "../../protocol-messages.mts";
import { MessageStore } from "../src/message-store.mts";
import { registry, until } from "./helpers.mts";
import { nodes } from "./message-proxy-fixture.mts";
import {
  ack, acked, deletes, frame, legacyGroups, legacyRow, node, offline, pair, query, receipt, reconnect, replyTo, reported, row, settledByAck,
  settledState, settles, statusOf, tombstone,
} from "./message-retention-fixture.mts";

// Issue #493: a row stored before PR 4 is never deleted. An acknowledgement of
// its current final state by its sender settles it instead: it stays, and the
// reconnect replay leaves it out until its state changes. This inverts the
// earlier expectation that such a row is replayed after every reconnect: that
// replay was a redundancy the ack already covered, not a delivery guarantee.
describe("rows stored before this version", () => {
  it("are settled by their sender's ack, leave the replay, and survive expiry, the alarm sweep and a revoke", async () => {
    const { a, sender, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    const queued = await legacyRow(OPERATOR_NODE_ID, b.nodeId, "queued");
    ack(sender, old, "delivered");
    await settledByAck(old, "delivered");
    expect(await row(old)).toMatchObject({ state: "delivered", deletable: null, delete_after: null });
    expect(await tombstone(old)).toBeUndefined();
    expect(await deletes(old)).toEqual([]);
    expect(await settles(old)).toEqual([{ actor: `node:${a.nodeId}`, detail: JSON.stringify({ messageId: old }) }]);
    const back = await reconnect(a);
    expect(back.replayed).not.toContain(old);
    // A repeated ack writes nothing: no second audit entry, settled_state unchanged.
    await acked(a.nodeId, old, "delivered");
    expect(await settledState(old)).toBe("delivered");
    expect(await settles(old)).toHaveLength(1);
    // The alarm expires the operator row without a fallback deadline, and clears
    // a deadline written by hand instead of sweeping it or re-arming on it.
    await query((sql) => sql.exec("UPDATE messages SET delete_after = 1 WHERE id = ?", old));
    await runInDurableObject(registry(), (instance) => instance.alarm());
    const rearmed = await runInDurableObject(registry(), (_i, state) => state.storage.getAlarm());
    expect(rearmed === null || rearmed > Date.now() - 1000).toBe(true);
    expect(await row(queued)).toMatchObject({ state: "expired", delete_after: null, deletable: null, settled_state: null });
    expect(await registry().revoke(a.nodeId, "test")).not.toBeNull();
    await runInDurableObject(registry(), (instance) => instance.alarm());
    for (const id of [old, queued]) {
      expect(await row(id)).toMatchObject({ deletable: null, delete_after: null });
      expect(await tombstone(id)).toBeUndefined();
      expect(await deletes(id)).toEqual([]);
    }
  });

  it("stay unsettled and replayed on an ack from another node, of another state, or of a state that is not final", async () => {
    const { a, b } = await pair();
    const foreign = await legacyRow(a.nodeId, b.nodeId);
    const stale = await legacyRow(a.nodeId, b.nodeId);
    const open = await legacyRow(a.nodeId, b.nodeId, "accepted");
    await acked(b.nodeId, foreign, "delivered");
    await acked(a.nodeId, stale, "refused");
    await acked(a.nodeId, open, "delivered");
    // The node frame validator refuses an accepted ack; the Registry checks it again.
    await registry().ackMessageStatus(a.nodeId, { name: MESSAGE_STATUS_ACK, messageId: open, state: "accepted" as "delivered" });
    for (const id of [foreign, stale, open]) {
      expect(await settledState(id)).toBeNull();
      expect(await settles(id)).toEqual([]);
    }
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => [foreign, stale, open].includes(s.messageId))).toEqual([
      { messageId: foreign, state: "delivered" }, { messageId: stale, state: "delivered" }, { messageId: open, state: "accepted" }]);
  });

  it("settle a legacy accepted row once its later delivered status is acknowledged", async () => {
    const { a, sender, target, b } = await pair();
    const id = await legacyRow(a.nodeId, b.nodeId, "accepted");
    frame(target, "message.status", { messageId: id, state: "delivered" });
    expect(await statusOf(sender, id)).toEqual({ messageId: id, state: "delivered" });
    await receipt(target, id, "delivered", "delivered");
    expect(await row(id)).toMatchObject({ state: "delivered", deletable: null, settled_state: null });
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === id)).toEqual([{ messageId: id, state: "delivered" }]);
    ack(back.socket, id, "delivered");
    await settledByAck(id, "delivered");
    expect((await reconnect(a)).replayed).not.toContain(id);
  });

  it("replay a settled row again once a reply marks it replied, and settle it only on the replied ack", async () => {
    const { a, sender, target, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    ack(sender, old, "delivered");
    await settledByAck(old, "delivered");
    await replyTo(target, old, { nodeId: a.nodeId, session: "s-a" });
    expect(await statusOf(sender, old)).toEqual({ messageId: old, state: "replied" });
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: "delivered" });
    let back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === old)).toEqual([{ messageId: old, state: "replied" }]);
    // A delivered ack arriving late never settles the replied row.
    await acked(a.nodeId, old, "delivered");
    expect(await settledState(old)).toBe("delivered");
    back = await reconnect(a);
    expect(back.replayed).toContain(old);
    ack(back.socket, old, "replied");
    await settledByAck(old, "replied");
    expect(await settles(old)).toHaveLength(2);
    expect(await deletes(old)).toEqual([]);
    expect((await reconnect(a)).replayed).not.toContain(old);
  });

  it("replay a row that was replied to while its sender was offline, whatever late delivered ack follows", async () => {
    const { a, sender, target, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    sender.ws.close(1000, "offline");
    await offline(a.nodeId);
    await replyTo(target, old, { nodeId: a.nodeId, session: "s-a" });
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: null });
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === old)).toEqual([{ messageId: old, state: "replied" }]);
    await acked(a.nodeId, old, "delivered");
    expect(await settledState(old)).toBeNull();
    expect(await settles(old)).toEqual([]);
    expect((await reconnect(a)).statuses.filter((s) => s.messageId === old)).toEqual([{ messageId: old, state: "replied" }]);
  });

  // A rollback to a Worker before this fix (36aae53) moves the state with its
  // own setState SQL, which knows nothing of the settle mark. After the roll
  // forward the row is replayed in its new state until that state is acked.
  it("replay a settled row that a rolled-back Worker marked replied, until the replied ack", async () => {
    const { a, sender, b } = await pair();
    const old = await legacyRow(a.nodeId, b.nodeId);
    ack(sender, old, "delivered");
    await settledByAck(old, "delivered");
    expect(await settles(old)).toHaveLength(1);
    // 36aae53 message-store.mts:379-381, verbatim, for delivered -> replied.
    await query((sql) => sql.exec(`UPDATE messages SET state = ?, reason = ?, text = NULL, progress_phase = ?, progress_code = ?,
      progress_observed_at = ?, progress_retry_at = ?, updated_at = ? WHERE id = ?`, "replied", null, null, null, null, null, Date.now(), old));
    // The roll-forward start: the constructor's column loop and index run again.
    await query((sql) => { new MessageStore(sql, () => {}, () => null); });
    let back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === old)).toEqual([{ messageId: old, state: "replied" }]);
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: "delivered" });
    expect(await legacyGroups(a.nodeId, "replied")).toEqual([["unsettled", 1]]);
    await acked(a.nodeId, old, "delivered");
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: "delivered" });
    expect(await settles(old)).toHaveLength(1);
    ack(back.socket, old, "replied");
    await settledByAck(old, "replied");
    expect(await row(old)).toMatchObject({ state: "replied", settled_state: "replied" });
    expect(await settles(old)).toHaveLength(2);
    expect(await legacyGroups(a.nodeId, "replied")).toEqual([["settled", 1]]);
    back = await reconnect(a);
    expect(back.replayed).not.toContain(old);
  });

  it("stay settled on a duplicate, regressive or foreign report, a reply to another session and a resend", async () => {
    const { a, sender, target, b } = await pair();
    const third = await node("retention-third");
    const old = await legacyRow(a.nodeId, b.nodeId);
    ack(sender, old, "delivered");
    await settledByAck(old, "delivered");
    frame(target, "message.status", { messageId: old, state: "delivered" });
    await receipt(target, old, "delivered", "delivered");
    frame(target, "message.status", { messageId: old, state: "accepted" });
    await receipt(target, old, "accepted", "delivered"); // regressive: the receipt carries the state that stayed
    // markReplied: a reply that does not go to the original's sending session marks nothing.
    await replyTo(target, old, { nodeId: a.nodeId, session: "s-x" });
    await reported(third.nodeId, old, "delivered"); // another node than the target: no receipt, nothing changed
    frame(sender, "message.send", { messageId: old, fromSession: "s-a", to: { nodeId: b.nodeId, session: "s-b" }, text: "synthetic" });
    await until(sender, "message.status", { messageId: old, state: "delivered" }); // the resend is answered from the row
    expect(await row(old)).toMatchObject({ state: "delivered", settled_state: "delivered" });
    expect(await settles(old)).toHaveLength(1);
    expect((await reconnect(a)).replayed).not.toContain(old);
  });

  it("keep a legacy accepted row replayable with its newest progress", async () => {
    const { a, target, b } = await pair();
    const id = await legacyRow(a.nodeId, b.nodeId, "accepted");
    const newer = { phase: "waiting", code: "target-busy", observedAt: new Date().toISOString() };
    const older = { ...newer, observedAt: new Date(Date.now() - 60_000).toISOString() };
    frame(target, "message.status", { messageId: id, state: "accepted", progress: newer });
    await receipt(target, id, "accepted", "accepted", { storedProgressAt: newer.observedAt });
    frame(target, "message.status", { messageId: id, state: "accepted", progress: older });
    await receipt(target, id, "accepted", "accepted", { storedProgressAt: newer.observedAt }); // older progress: nothing stored
    expect(await row(id)).toMatchObject({ state: "accepted", progress_observed_at: newer.observedAt, settled_state: null });
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => s.messageId === id)).toEqual([{ messageId: id, state: "accepted", progress: newer }]);
  });

  it("replay a row made final by expiry, a revoked target or a superseding owner until its sender acknowledges it", async () => {
    const { a, b } = await pair();
    const gone = await node("retention-revoked");
    const expiring = await legacyRow(a.nodeId, b.nodeId, "queued");
    const waiting = await legacyRow(a.nodeId, gone.nodeId, "queued");
    await query((sql) => sql.exec("UPDATE messages SET expires_at = ? WHERE id = ?", Date.now() + 60 * 60_000, waiting));
    await runInDurableObject(registry(), (instance) => instance.alarm());
    expect(await row(expiring)).toMatchObject({ state: "expired", settled_state: null });
    expect(await registry().revoke(gone.nodeId, "test")).not.toBeNull();
    expect(await row(waiting)).toMatchObject({ state: "refused", settled_state: null });
    const back = await reconnect(a);
    expect(back.statuses.filter((s) => [expiring, waiting].includes(s.messageId))).toEqual([
      { messageId: expiring, state: "expired" }, { messageId: waiting, state: "refused", reason: "target node revoked" }]);
    ack(back.socket, expiring, "expired");
    ack(back.socket, waiting, "refused");
    await settledByAck(expiring, "expired");
    await settledByAck(waiting, "refused");
    expect((await reconnect(a)).replayed).toEqual([]);

    // A proxy that the owner's read supersedes goes through the same setState.
    const { original, proxy } = await nodes();
    const read = await original();
    const queuedProxy = (await proxy(read)).messageId;
    await registry().reportMessageStatus(String((await row(read))?.to_node), { messageId: read, state: "delivered" });
    expect(await row(queuedProxy)).toMatchObject({ state: "refused", settled_state: null });
  });
});
