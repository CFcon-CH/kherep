import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { ALARM_INTERVAL_MS } from "../src/node-session.mts";
import { egressBinding } from "../src/message-egress-binding.mts";
import { AlarmSchedule } from "../src/alarm-schedule.mts";
import { attestedPair, ID_A, ID_B } from "./message-loop-fixture.mts";
import { authenticate, enroll, FACTS, newKey, registry, session, until } from "./helpers.mts";
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, s) => run(s.storage.sql));
const alarmAt = (id: string) => runInDurableObject(session(id), (_i, s) => s.storage.getAlarm());

for (const retryFirst of [false, true]) it(`keeps the earlier alarm across an empty-queue race, retry first=${retryFirst}`, async () => {
  let due: number | null = null, release = () => {}, entered = () => {};
  const pause = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  const schedule = new AlarmSchedule({ getAlarm: async () => {
    const snapshot = due;
    if (first) { first = false; entered(); await pause; }
    return snapshot;
  }, setAlarm: async next => { due = Number(next); } });
  const firstWrite = schedule.earlier(retryFirst ? 60_000 : ALARM_INTERVAL_MS);
  await reading;
  const concurrent = schedule.earlier(retryFirst ? ALARM_INTERVAL_MS : 60_000);
  release(); await Promise.all([firstWrite, concurrent]);
  expect(due).toBe(60_000);
});

it("does not overwrite a concurrent same-socket delivery retry after an empty alarm snapshot", async () => {
  const f = await attestedPair();
  await runInDurableObject(session(f.nodeId), async (instance, state) => {
    await state.storage.deleteAlarm();
    const real = state.storage.setAlarm.bind(state.storage);
    let release = () => {}, entered = () => {}, retryWritten = () => {};
    const pause = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const retry = new Promise<void>(resolve => { retryWritten = resolve; });
    const spy = vi.spyOn(state.storage, "setAlarm").mockImplementation(async (due, options) => {
      if (Number(due) - Date.now() > 60_000) { entered(); await pause; }
      await real(due, options);
      if (Number(due) - Date.now() <= 60_000) retryWritten();
    });
    try {
      const alarm = instance.alarm(); await ready;
      const sent = await f.send(); if (!sent.ok) throw new Error(sent.error);
      const push = instance.pushFrame("message.deliver", { messageId: sent.status.messageId });
      // Original code completes this observable retry write before releasing
      // the stale empty snapshot. A serialized writer instead blocks behind
      // that snapshot, so the bounded fallback releases its first operation.
      await Promise.race([retry, new Promise(resolve => setTimeout(resolve, 100))]);
      release(); await Promise.all([alarm, push]);
      expect((await state.storage.getAlarm())! - Date.now()).toBeLessThanOrEqual(60_000);
    } finally { release(); spy.mockRestore(); }
  });
});

it("retries a deferred bound egress and lost acceptance on the unchanged registered socket without scoring", async () => {
  const f = await attestedPair(), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  const id = sent.status.messageId;
  const score = () => query(sql => sql.exec("SELECT * FROM message_loop_pairs WHERE from_node=?", f.nodeId).toArray());
  const before = await score();
  f.setRows([]);
  expect(await session(f.nodeId).pushFrame("message.deliver", { messageId: id })).toBe(false);
  expect((await alarmAt(f.nodeId))! - Date.now()).toBeLessThanOrEqual(60_000);
  f.setRows([{ sessionId: ID_A, runtime: "codex" }, { sessionId: ID_B, runtime: "codex" }]);
  await runDurableObjectAlarm(session(f.nodeId));
  const first = (await until(f.socket, "message.deliver", { messageId: id })).at(-1)!;
  await runDurableObjectAlarm(session(f.nodeId));
  const second = (await until(f.socket, "message.deliver", { messageId: id })).at(-1)!;
  const stable = (body: typeof first.body) => { const b = body as Record<string, unknown>; const binding = b.binding as Record<string, unknown>;
    const { leaseId: _lease, localGeneration: _generation, ...identity } = binding; return { ...b, binding: identity }; };
  expect(stable(first.body)).toEqual(stable(second.body));
  expect(await score()).toEqual(before);
  await registry().reportMessageStatus(f.nodeId, { messageId: id, state: "accepted" });
  await runDurableObjectAlarm(session(f.nodeId));
  expect((await alarmAt(f.nodeId))! - Date.now()).toBeGreaterThan(ALARM_INTERVAL_MS - 2000);
  expect(await registry().prepareMessageDelivery(id)).toBeNull();
});

it("retries unbound work before registration, without upgrading a previously emitted legacy binding", async () => {
  const key = await newKey(), nodeId = await enroll(key), socket = await authenticate(nodeId, key);
  await registry().updateRegistration(nodeId, FACTS, [], ["messaging.v1"]);
  const id = crypto.randomUUID();
  await registry().sendMessage({ messageId: id, from: { nodeId, session: "source" }, to: { nodeId, session: "target" }, text: "Synthetic unbound" }, "synthetic");
  await runDurableObjectAlarm(session(nodeId));
  const frame = (await until(socket, "message.deliver", { messageId: id })).at(-1)!;
  expect(frame.body).not.toHaveProperty("binding");
  expect((await alarmAt(nodeId))! - Date.now()).toBeLessThanOrEqual(60_000);
  await registry().reportMessageStatus(nodeId, { messageId: id, state: "accepted" });
  await runDurableObjectAlarm(session(nodeId));
  expect((await alarmAt(nodeId))! - Date.now()).toBeGreaterThan(ALARM_INTERVAL_MS - 2000);
  socket.ws.close();
});

it("rearms the retry alarm when egress throws", async () => {
  const f = await attestedPair();
  await runInDurableObject(session(f.nodeId), async (instance, state) => {
    const original = instance.pushFrame;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    instance.pushFrame = async () => { throw new Error("synthetic storage fault"); };
    try {
      const sent = await f.send(); if (!sent.ok) throw new Error(sent.error);
      await expect(instance.alarm()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledExactlyOnceWith("DELIVERY_RETRY_FAILED");
      expect((await state.storage.getAlarm())! - Date.now()).toBeLessThanOrEqual(60_000);
    } finally { instance.pushFrame = original; log.mockRestore(); }
  });
});

it("never changes an emitted legacy binding when later held scope requires selection", async () => {
  const f = await attestedPair();
  await query(sql => {
    const row = { id: crypto.randomUUID(), from_node: f.nodeId, from_session: ID_A, to_node: f.nodeId, to_session: ID_B,
      delivery_binding: null, delivery_pair: null, loop_identity: null };
    expect(egressBinding(sql, row, null, false)).toEqual({});
    expect(egressBinding(sql, row, null, true)).toBeNull();
  });
});

it("does not send binding-required rows until this socket's registration is accepted", async () => {
  const f = await attestedPair(), sent = await f.send(); if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(session(f.nodeId), (_i, state) => {
    const ws = state.getWebSockets()[0]; ws.serializeAttachment({ ...ws.deserializeAttachment(), registrationAccepted: false });
  });
  expect(await session(f.nodeId).pushFrame("message.deliver", { messageId: sent.status.messageId })).toBe(false);
  await runDurableObjectAlarm(session(f.nodeId));
  expect((await registry().mcpMessageStatus(f.nodeId, sent.status.messageId))?.state).toBe("queued");
});

for (const writeFailure of [false, true]) for (const failed of [false, true]) it(`schedules the queued retry sixty seconds after a slow real pass, failure=${failed}, alarm failure=${writeFailure}`, async () => {
  const f = await attestedPair(), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(session(f.nodeId), async (instance, state) => {
    await state.storage.deleteAlarm();
    const startedAt = Date.now();
    let clock = startedAt;
    const date = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const realSet = state.storage.setAlarm.bind(state.storage);
    let writes = 0;
    const set = vi.spyOn(state.storage, "setAlarm").mockImplementation(async (due, options) => {
      if (++writes === 2 && writeFailure) throw new Error("synthetic one-shot completion alarm failure");
      await realSet(due, options);
    });
    const ws = state.getWebSockets()[0], send = ws.send.bind(ws);
    const push = vi.spyOn(ws, "send").mockImplementation(message => {
      if (typeof message === "string" && JSON.parse(message).type === "message.deliver") {
        clock += 65_000;
        if (failed) throw new Error("synthetic socket failure");
      }
      send(message);
    });
    try {
      await instance.alarm();
      expect(clock - startedAt).toBe(65_000);
      expect(await state.storage.getAlarm()).toBe(clock + 60_000);
      expect(log).toHaveBeenCalledTimes(failed ? 1 : 0);
    } finally { push.mockRestore(); date.mockRestore(); log.mockRestore(); set.mockRestore(); }
  });
});

for (const [at, persistent] of [[1, false], [2, false], [2, true]] as const) it(`retains a retry and does not reject after alarm write failure ${at}, persistent=${persistent}`, async () => {
  const f = await attestedPair(), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(session(f.nodeId), async (instance, state) => {
    await state.storage.deleteAlarm();
    const real = state.storage.setAlarm.bind(state.storage);
    let writes = 0;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const set = vi.spyOn(state.storage, "setAlarm").mockImplementation(async (due, options) => {
      if (++writes === at || persistent && writes > at) throw new Error("synthetic alarm storage failure");
      await real(due, options);
    });
    try {
      await expect(instance.alarm()).resolves.toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
      if (at === 1 || persistent) expect(log).toHaveBeenCalledExactlyOnceWith("DELIVERY_RETRY_FAILED");
      else expect(log).not.toHaveBeenCalled(); // serialized completion retry recovered
    } finally { set.mockRestore(); log.mockRestore(); }
  });
});

it("serializes a completion retry before an interleaved fresh delivery alarm", async () => {
  let due: number | null = 60_000, writes = 0, release = () => {}, entered = () => {};
  const pause = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const schedule = new AlarmSchedule({ getAlarm: async () => due, setAlarm: async next => {
    if (++writes === 1) throw new Error("synthetic transient alarm write");
    if (writes === 2) { entered(); await pause; }
    due = Number(next);
  } });
  const completion = schedule.replace(ALARM_INTERVAL_MS);
  await ready;
  const fresh = schedule.earlier(60_000);
  release(); await Promise.all([completion, fresh]);
  expect(due).toBe(60_000);
});
