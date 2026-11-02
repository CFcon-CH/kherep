import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { parentOf } from "../src/message-loop-identity.mts";
import { routeEffects } from "../src/message-routing.mts";
import { FACTS, registry } from "./helpers.mts";
import { pair } from "./message-loop-fixture.mts";

// Every row is admitted by the real Registry/HMAC/SQL path before mutation.
// A saved valid delivery effect must not survive later stored-proof corruption.
for (const [field, value] of [["loop_pair", null], ["loop_pair", "invalid"], ["loop_thread", null], ["loop_direction", null]] as const) {
  for (const boundary of ["replay", "queued-push"] as const) it(`${boundary} refuses admitted row with ${field}=${value}`, async () => {
    const { a, b, send } = await pair();
    const sent = await send(a, b, "Synthetic queued admission"); if (!sent.ok) throw new Error(sent.error);
    const id = sent.status.messageId;
    expect(sent.effects.deliveries[0].body.loop?.version).toBe(1);
    await runInDurableObject(registry(), (_i, state) => {
      state.storage.sql.exec(`UPDATE messages SET ${field}=? WHERE id=?`, value, id);
      expect(parentOf(state.storage.sql, id).kind).toBe("guarded-invalid");
    });
    if (boundary === "replay") {
      const replay = await registry().pendingMessagesFor(b);
      expect(replay.deliveries).toEqual([]);
      expect(replay.statuses).toContainEqual({ nodeId: a, body: { messageId: id, state: "refused", reason: "loop-lineage-unavailable" } });
    }
    const delivered: unknown[] = [];
    await routeEffects(env, sent.effects, { nodeId: b, send: (type, body) => { if (type === "message.deliver") delivered.push(body); } });
    expect(delivered).toEqual([]);
    expect(await registry().messageDeliveryReady(id)).toBe(false);
    const status = await registry().mcpMessageStatus(a, id);
    expect(status).toMatchObject({ state: "refused", reason: "loop-lineage-unavailable" });
    expect(status && "loop" in status).toBe(false);
    const replayedStatus = await registry().messageStatusPageFor(a, 0, 128);
    expect(replayedStatus.effects.statuses).toContainEqual({ nodeId: a, body: { messageId: id, state: "refused", reason: "loop-lineage-unavailable" } });
    await runInDurableObject(registry(), (_i, state) => {
      expect(parentOf(state.storage.sql, id).kind).toBe("guarded-invalid");
      expect(state.storage.sql.exec(`SELECT ${field} AS value FROM messages WHERE id=?`, id).one().value).toBe(value);
    });
  });
}
for (const legacy of [false, true]) it(`${legacy ? "all-NULL legacy" : "complete guarded"} survives replay and queued push`, async () => {
  const { a, b, send } = await pair();
  if (legacy) await registry().updateRegistration(b, FACTS, [], ["messaging.v1"]);
  const sent = await send(a, b, "Synthetic positive admission"); if (!sent.ok) throw new Error(sent.error);
  const replay = await registry().pendingMessagesFor(b);
  expect(replay.deliveries).toHaveLength(1);
  expect(replay.deliveries[0].body.loop?.version).toBe(legacy ? undefined : 1);
  const delivered: unknown[] = [];
  await routeEffects(env, sent.effects, { nodeId: b, send: (type, body) => { if (type === "message.deliver") delivered.push(body); } });
  expect(delivered).toHaveLength(1);
  expect(await registry().messageDeliveryReady(sent.status.messageId)).toBe(true);
});
