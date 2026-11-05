import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeEnvelope } from "../protocol.mts";
import { SELECTED_BINDING_CAPABILITY } from "../protocol-message-binding.mts";
import { NodeClient } from "./client.mts";
import { recordLockFile, setRecordLockWait, RECORD_LOCK_WAIT_MS } from "./inbox-record-lock.mts";
import { createBindingStorage } from "./inbox-storage.mts";
import { MessageReferenceResolver } from "./message-reference.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { generateIdentity } from "./identity.mts";
import { DEFAULT_POLICY } from "./policy.mts";
import { storeMessage, getMessage } from "./inbox.mts";
import { fixture, ID, OWNER, PEER } from "./inbox-storage-fixture.mts";
const frame = (type: string, body: unknown): string => JSON.stringify(makeEnvelope(type as never, body as never, 0, 0));
test("storage capability transitions invalidate leases and unsent registrations with unchanged runtime readiness", async t => {
  const f = fixture(t), storage = createBindingStorage(f.paths.inbox);
  writeLocalSessions(f.paths, [{ sessionId: OWNER, runtime: "codex", state: "unknown" }]);
  const client = new NodeClient({ nodeId: PEER, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "synthetic.example", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], readyRuntimes: () => [],
    selectedReferences: new MessageReferenceResolver(f.paths), bindingStorageReady: storage.snapshot,
    bindingStorageFault: storage.fault, storeMessage: body => { storeMessage(f.paths.inbox, body); } });
  const auth = await client.onFrame(frame("event", { name: "auth.ok" }));
  const has = (frames: string[]) => frames.some(s => JSON.parse(s).type === "register" && JSON.parse(s).body.capabilities.includes(SELECTED_BINDING_CAPABILITY));
  assert.equal(has(auth), true); // intentionally leave unsent
  const resolve = async () => {
    const [response] = await client.onFrame(frame("message.resolve.request", { version: 1, requestId: crypto.randomUUID(), messageId: ID,
      purpose: "admit", selections: [{ role: "to", ref: OWNER }], expiresAt: Date.now() + 5000 }));
    return JSON.parse(response).body.results[0];
  };
  const selected = await resolve();
  const delivery = { ...f.body, binding: { ...f.body.binding, to: { ...selected.owner, lifecycleGeneration: selected.lifecycleGeneration },
    leaseId: selected.leaseId, localGeneration: selected.localGeneration } };
  storage.fault();
  const unavailable = await client.refreshPolicy(DEFAULT_POLICY);
  assert.equal(has(unavailable), false); assert.ok(unavailable.length > 0);
  assert.deepEqual(await client.onFrame(frame("message.deliver", delivery)), []); assert.equal(getMessage(f.paths.inbox, ID), null);
  assert.equal(storage.recheck(), true);
  const restored = await client.refreshPolicy(DEFAULT_POLICY); assert.equal(has(restored), true);
  assert.deepEqual(await client.onFrame(frame("message.deliver", delivery)), [], "old lease cannot survive recovery");
  assert.deepEqual(await client.refreshPolicy(DEFAULT_POLICY), restored, "failed register send retries current frames");
  client.registrationSent(); assert.deepEqual(await client.refreshPolicy(DEFAULT_POLICY), []);
  const hiddenFaultLease = await resolve();
  storage.fault(); assert.equal(storage.recheck(), true);
  const changedEpoch = await client.refreshPolicy(DEFAULT_POLICY);
  assert.equal(has(changedEpoch), true); assert.ok(changedEpoch.length > 0, "a recovered fault still invalidates registration");
  assert.deepEqual(await client.onFrame(frame("message.deliver", { ...delivery, binding: { ...delivery.binding, leaseId: hiddenFaultLease.leaseId } })), []);
  const fresh = await resolve();
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.bound) throw new Error("synthetic rename fault"); return rename(from, to);
  }) as typeof fs.renameSync);
  assert.deepEqual(await client.onFrame(frame("message.deliver", { ...delivery, binding: { ...delivery.binding, leaseId: fresh.leaseId } })), []);
  assert.equal(storage.ready(), false); assert.equal(fs.existsSync(f.flat), false); assert.equal(fs.existsSync(f.bound), false);
  assert.equal(has(await client.refreshPolicy(DEFAULT_POLICY)), false);
});
test("layout faults preserve bytes and readiness recovers only after a real check", t => {
  const f = fixture(t), storage = createBindingStorage(f.paths.inbox); assert.equal(storage.ready(), true);
  fs.mkdirSync(path.join(f.paths.inbox, "bound-v9")); assert.equal(storage.recheck(), false);
  fs.rmdirSync(path.join(f.paths.inbox, "bound-v9")); assert.equal(storage.ready(), false);
  assert.equal(storage.recheck(), true); assert.deepEqual(fs.readdirSync(path.join(f.paths.inbox, "bound-v1")), []);
});

test("redelivery under an existing record lock defers without faulting storage or clearing leases", async t => {
  const f = fixture(t), storage = createBindingStorage(f.paths.inbox);
  writeLocalSessions(f.paths, [{ sessionId: OWNER, runtime: "codex", state: "unknown" }]);
  const references = new MessageReferenceResolver(f.paths);
  const client = new NodeClient({ nodeId: PEER, identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "synthetic.example", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], selectedReferences: references,
    bindingStorageReady: storage.snapshot, bindingStorageFault: storage.fault,
    storeMessage: body => { storeMessage(f.paths.inbox, body); } });
  await client.onFrame(frame("event", { name: "auth.ok" })); client.registrationSent();
  const resolve = async () => {
    const [response] = await client.onFrame(frame("message.resolve.request", { version: 1, requestId: crypto.randomUUID(), messageId: ID,
      purpose: "admit", selections: [{ role: "to", ref: OWNER }], expiresAt: Date.now() + 5000 }));
    const selected = JSON.parse(response).body.results[0];
    return { ...f.body, binding: { ...f.body.binding, leaseId: selected.leaseId, localGeneration: selected.localGeneration } };
  };
  storeMessage(f.paths.inbox, f.body);
  const unrelated = await resolve(), delivery = await resolve();
  const before = fs.readFileSync(f.bound, "utf8"), snapshot = storage.snapshot();
  const lock = recordLockFile(f.paths.inbox, ID);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  setRecordLockWait(0);
  try {
    assert.deepEqual(await client.onFrame(frame("message.deliver", delivery)), []);
    assert.deepEqual(storage.snapshot(), snapshot);
    assert.deepEqual(await client.refreshPolicy(DEFAULT_POLICY), [], "no capability withdrawal or re-registration");
    assert.equal(fs.readFileSync(f.bound, "utf8"), before);
  } finally { setRecordLockWait(RECORD_LOCK_WAIT_MS); fs.unlinkSync(lock); }
  assert.equal(JSON.parse((await client.onFrame(frame("message.deliver", unrelated)))[0]).body.state, "accepted", "other pending leases survive contention");
  assert.equal(fs.readFileSync(f.bound, "utf8"), before);
  const mismatch = { ...await resolve(), text: "synthetic mismatched redelivery" };
  assert.deepEqual(await client.onFrame(frame("message.deliver", mismatch)), []);
  assert.equal(storage.ready(), false, "a real redelivery mismatch still faults storage");
});
