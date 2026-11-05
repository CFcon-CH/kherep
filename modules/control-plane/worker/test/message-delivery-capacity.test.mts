import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { BINDING_PENDING_LIMIT, BINDING_TTL_MS } from "../../protocol-message-binding.mts";
import { DELIVERY_RETRY_CONCURRENCY } from "../src/node-session.mts";
import { attestedPair } from "./message-loop-fixture.mts";
import { registry, session } from "./helpers.mts";

it("attempts more than 32 required rows oldest first behind stuck heads while a fresh admission keeps a resolve slot", async () => {
  const f = await attestedPair(), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  const ids = [sent.status.messageId, ...Array.from({ length: BINDING_PENDING_LIMIT + 7 }, () => crypto.randomUUID())];
  await runInDurableObject(registry(), (_i, state) => {
    const sql = state.storage.sql;
    const columns = sql.exec("PRAGMA table_info(messages)").toArray().map(row => String(row.name));
    for (const id of ids.slice(1)) sql.exec(`INSERT INTO messages (${columns.join(",")}) SELECT ${columns.map(column => column === "id" ? "?" : column).join(",")} FROM messages WHERE id=?`, id, ids[0]);
  });
  let started = () => {};
  const initialLanes = new Promise<void>(resolve => { started = resolve; });
  const attempted: string[] = [], stuck = new Set(ids.slice(0, BINDING_PENDING_LIMIT));
  f.respondWhen(request => {
    if (request.purpose === "egress") {
      attempted.push(request.messageId);
      if (attempted.length === DELIVERY_RETRY_CONCURRENCY) started();
      return !stuck.has(request.messageId);
    }
    return true;
  });
  await runInDurableObject(session(f.nodeId), async instance => {
    const pass = instance.alarm();
    try {
      await initialLanes;
      expect(attempted).toEqual(ids.slice(0, DELIVERY_RETRY_CONCURRENCY));
      const fresh = await f.send();
      expect(fresh.ok).toBe(true);
      if (fresh.ok) expect(fresh.status.state).toBe("queued");
      await pass;
      expect(attempted).toEqual(ids);
    } finally { f.respondWhen(() => true); await pass; }
  });
}, BINDING_TTL_MS * 6);

it("defers a historical required row without a stored binding without asking the node to resolve it", async () => {
  const f = await attestedPair(), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(registry(), (_i, state) => {
    state.storage.sql.exec("UPDATE messages SET delivery_binding=NULL,delivery_pair=NULL WHERE id=?", sent.status.messageId);
  });
  let resolutions = 0;
  f.respondWhen(() => { resolutions++; return true; });
  expect(await registry().prepareMessageDelivery(sent.status.messageId)).toBeNull();
  expect(resolutions).toBe(0);
  expect((await registry().mcpMessageStatus(f.nodeId, sent.status.messageId))?.state).toBe("queued");
});
