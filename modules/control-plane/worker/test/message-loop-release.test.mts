import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { handleApi } from "../src/api.mts";
import type { Env } from "../src/env.mts";
import { BASE, registry, workerFetch } from "./helpers.mts";
import { pair } from "./message-loop-fixture.mts";

it("holds survive node history and release is Access-only, CAS/idempotent, with no delivery or budget reset", async () => {
  const { a, b, send } = await pair();
  let last: string | undefined;
  for (const text of ["Synthetic work 1", "ack", "ok", "received"]) {
    const sent = await send(a, b, text); // roots share the pair's strike state
    if (!sent.ok) throw new Error(sent.error);
    if (sent.status.state === "queued") {
      last = sent.status.messageId;
      await registry().reportMessageStatus(b, { messageId: last, state: "delivered" });
      await registry().ackMessageStatus(a, { name: "message.status.ack", messageId: last, state: "delivered" });
    }
  }
  const list = await registry().listMessageHolds(50);
  expect(list).toHaveLength(1);
  const hold = list[0];
  expect(Object.keys(hold).sort()).toEqual(["admittedCount", "fromNode", "generation", "heldAt", "holdId", "noProgressCount", "reason", "toNode", "triggerMessageId", "version"].sort());
  const path = `/api/message-holds/${hold.holdId}/release`;
  expect((await workerFetch(path, { method: "POST", body: JSON.stringify({ expectedVersion: hold.version }) })).status).toBe(403);
  const post = (body: unknown) => handleApi(new Request(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) }), env as Env, "synthetic-verified-operator");
  expect((await post({ expectedVersion: -1 })).status).toBe(400);
  expect((await post({ expectedVersion: hold.version, extra: true })).status).toBe(400);
  expect((await post({ expectedVersion: Number(hold.version) + 1 })).status).toBe(409);
  const [one, two] = await Promise.all([post({ expectedVersion: hold.version }), post({ expectedVersion: hold.version })]);
  expect(one.status).toBe(200); expect(two.status).toBe(200);
  expect(await one.json()).toEqual(await two.json());
  expect(await registry().listMessageHolds(50)).toEqual([]);
  const refusedParent = await send(b, a, "Synthetic reply to refused trigger", String(hold.triggerMessageId));
  expect(refusedParent.ok && refusedParent.status.reason).toBe("loop-lineage-unavailable");
  expect((await registry().pendingMessagesFor(b)).deliveries).toEqual([]);
  const continued = await send(b, a, "New synthetic result 27", last);
  if (!continued.ok) throw new Error(continued.error);
  expect(continued.status.state).toBe("queued");
  expect(continued.effects.deliveries[0].body.loop).toMatchObject({ generation: 1, ordinal: 1, depth: 1, threadId: last });
  const repeated = await post({ expectedVersion: hold.version });
  expect(repeated.status).toBe(200);
  const next = await send(a, b, "New root result 28");
  if (!next.ok) throw new Error(next.error);
  expect(next.effects.deliveries[0].body.loop?.ordinal).toBe(2);
});
