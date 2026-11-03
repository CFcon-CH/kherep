import { bindingConnection } from "./binding-node-fixture.mts";
import { SELECTED_BINDING_CAPABILITY } from "../../protocol-message-binding.mts";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { FACTS, newKey, registry, session } from "./helpers.mts";
import { BRAKE_CAPS } from "./message-loop-fixture.mts";

// Public test API: one instance is torn down, persistent storage is retained.
// https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#durable-objects
// No product test hook, storage substitute, module mock, or blanket error filter.
const SECRET = "loop-hmac-v1";
function retainedSnapshot(sql: SqlStorage): string {
  return JSON.stringify({
    pairs: sql.exec("SELECT * FROM message_loop_pairs ORDER BY pair_key").toArray(),
    messages: sql.exec(`SELECT id, state, depth, loop_thread, loop_pair, loop_generation,
      loop_ordinal, loop_direction, loop_identity FROM messages ORDER BY id`).toArray(),
    tombstones: sql.exec(`SELECT id, state, depth, loop_thread, loop_pair, loop_generation,
      loop_ordinal, loop_direction, loop_identity FROM message_tombstones ORDER BY id`).toArray(),
  });
}

it("L13: a fresh Registry with a lost persisted secret fails closed without resetting retained pairs", async () => {
  // A new ephemeral object, separate from the singleton used by other fixtures.
  const stub = env.REGISTRY.get(env.REGISTRY.newUniqueId());
  const key = await newKey();
  const { code } = await stub.createEnrollment("synthetic-secret-loss");
  const enrolled = await stub.redeemEnrollment({ code, publicKey: key.publicKey, name: "synthetic-secret-loss", facts: FACTS,
    runtimes: [{ name: "codex", kind: "cli" }] });
  expect(enrolled.ok).toBe(true);
  if (!enrolled.ok) throw new Error("synthetic enrollment failed");
  const nodeId = enrolled.nodeId;
  const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  // NodeSession authenticates against the configured singleton. Mirror this
  // generated fixture's enrolled public row there, while all subject state
  // and secret-loss eviction remain on the separate, real Registry instance.
  const enrollmentRow = await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("SELECT * FROM nodes WHERE id=?", nodeId).one());
  await runInDurableObject(registry(), (_i, state) => {
    const columns = Object.keys(enrollmentRow);
    state.storage.sql.exec(`INSERT INTO nodes (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, ...columns.map(k => enrollmentRow[k]));
  });
  const owner = await bindingConnection(nodeId, key, [a, b, c].map(sessionId => ({ sessionId, runtime: "codex" })), BRAKE_CAPS);
  const connection = await session(nodeId).loopCapabilityEvidence();
  await stub.beginMessageConnection(nodeId, connection.token!);
  await stub.updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], [...BRAKE_CAPS, SELECTED_BINDING_CAPABILITY], connection.token!);
  expect((await stub.replaceSessions(nodeId, [a, b, c].map(sessionId => ({ sessionId, runtime: "codex", state: "unknown",
    canonicalIdentity: { version: 1, source: "codex-hook", runtime: "codex", sessionId, observedAt: Date.now(), lifecycleGeneration: 0 },
  })), { version: 1, generation: 1 })).ok).toBe(true);
  const send = (to: string, text: string) => stub.sendMessage({ messageId: crypto.randomUUID(),
    from: { nodeId, session: a }, to: { nodeId, session: to }, text }, "synthetic-secret-loss");
  const settle = async (messageId: string) => {
    await stub.reportMessageStatus(nodeId, { messageId, state: "delivered" });
    await stub.ackMessageStatus(nodeId, { name: "message.status.ack", messageId, state: "delivered" });
  };

  const first = await send(b, "Synthetic retained pair control");
  expect(first.ok && first.effects.deliveries[0]?.body.loop?.ordinal).toBe(1);
  if (!first.ok) throw new Error("synthetic control failed");
  await settle(first.status.messageId);
  for (let n = 0; n < 3; n++) {
    const ack = await send(b, "ack");
    expect(ack.ok && ack.status.state).toBe(n === 2 ? "refused" : "queued");
    if (!ack.ok) throw new Error("synthetic control failed");
    if (n < 2) await settle(ack.status.messageId);
  }
  const open = await send(c, "Synthetic unheld pair control");
  expect(open.ok && open.effects.deliveries[0]?.body.loop?.ordinal).toBe(1);
  const held = await stub.listMessageHolds(1);
  expect(held.length).toBe(1);
  expect(held[0].admittedCount).toBe(3);

  const instances = new WeakSet<object>();
  let before = await runInDurableObject(stub, async (instance, state) => {
    instances.add(instance);
    expect((await state.storage.get(SECRET)) instanceof Uint8Array).toBe(true);
    return retainedSnapshot(state.storage.sql);
  });
  await evictDurableObject(stub);
  const positiveFresh = await runInDurableObject(stub, async (instance, state) => ({
    fresh: !instances.has(instance), preserved: retainedSnapshot(state.storage.sql) === before,
    secretPresent: (await state.storage.get(SECRET)) instanceof Uint8Array,
  }));
  expect(positiveFresh).toEqual({ fresh: true, preserved: true, secretPresent: true });
  // S25: this is the new instance, with real persisted signer state. Its
  // Registry rows can disappear while the selected owning Node retains them.
  await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("DELETE FROM sessions WHERE node_id=?", nodeId));
  const heldAfterLoss = await send(b, "Synthetic post-eviction row-loss attempt");
  expect(heldAfterLoss.ok && heldAfterLoss.status.state).toBe("refused");
  expect(heldAfterLoss.ok && heldAfterLoss.status.reason).toContain(String(held[0].holdId));
  expect(heldAfterLoss.ok && heldAfterLoss.effects.deliveries).toEqual([]);
  expect(await stub.listMessageHolds(1)).toEqual(held);
  // Restore the final key-loss attempt's original positive attestation control.
  await stub.replaceSessions(nodeId, [a, b, c].map(sessionId => ({ sessionId, runtime: "codex", state: "unknown",
    canonicalIdentity: { version: 1, source: "codex-hook", runtime: "codex", sessionId, observedAt: Date.now(), lifecycleGeneration: 0 },
  })), { version: 1, generation: 2 });
  before = await runInDurableObject(stub, (_i, state) => retainedSnapshot(state.storage.sql));


  let storagePrototype: DurableObjectStorage | undefined;
  let sqlPrototype: SqlStorage | undefined;
  const missing = await runInDurableObject(stub, async (_instance, state) => {
    storagePrototype = Object.getPrototypeOf(state.storage) as DurableObjectStorage;
    sqlPrototype = Object.getPrototypeOf(state.storage.sql) as SqlStorage;
    expect(retainedSnapshot(state.storage.sql) === before).toBe(true);
    const deleted = await state.storage.delete(SECRET);
    return deleted && await state.storage.get(SECRET) === undefined;
  });
  expect(missing).toBe(true);
  if (!storagePrototype || !sqlPrototype) throw new Error("synthetic observation unavailable");

  // Supported direct-access/test spies observe real native APIs. They retain
  // their original implementation, receiver and return value, including errors.
  const get = vi.spyOn(storagePrototype, "get");
  const put = vi.spyOn(storagePrototype, "put");
  const originalExec = sqlPrototype.exec;
  const guardedSnapshots: string[] = [];
  const exec = vi.spyOn(sqlPrototype, "exec").mockImplementation(function(this: SqlStorage, query: string, ...bindings: unknown[]) {
    const cursor = Reflect.apply(originalExec, this, [query, ...bindings]);
    if (query === "SELECT 1 FROM message_loop_pairs LIMIT 1") guardedSnapshots.push(retainedSnapshot(this));
    return cursor;
  });
  try {
    await evictDurableObject(stub);
    // The unheld pair has current proofs, runtime, capability and positive
    // admission control. Its new call must fail at fresh crypto initialization.
    let cryptoRefused = false;
    try { await send(c, "Synthetic admission must not occur"); }
    catch (error) { cryptoRefused = error instanceof Error && error.message.includes("loop-crypto-unavailable"); }
    expect(cryptoRefused).toBe(true);
    const keyReads = get.mock.calls.flatMap((args: readonly unknown[], i) => args[0] === SECRET ? [get.mock.results[i]] : []);
    expect(keyReads.length > 0).toBe(true); // Fresh constructor actually read storage.
    const readValues = await Promise.all(keyReads.map(result => result.value));
    expect(readValues.every(value => value === undefined)).toBe(true);
    expect(put.mock.calls.filter((args: readonly unknown[]) => args[0] === SECRET || typeof args[0] === "object" && args[0] !== null && Object.hasOwn(args[0], SECRET)).length).toBe(0);
    expect(guardedSnapshots.length > 0).toBe(true);
    expect(guardedSnapshots.every(snapshot => snapshot === before)).toBe(true);
    const admissionsOrResets = exec.mock.calls.filter(([query]) => /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:message_loop_pairs|messages|message_tombstones)\b/i.test(query));
    expect(admissionsOrResets.length).toBe(0);
  } finally {
    get.mockRestore(); put.mockRestore(); exec.mockRestore(); owner.socket.ws.close();
  }
});
