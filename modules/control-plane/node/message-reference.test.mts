import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import { BINDING_TTL_MS, isDeliveryBinding, isResolveRequest, isResolveResponse, type ResolveRequest, type ResolveResponse } from "../protocol-message-binding.mts";
import { isMessageSendBody } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { nodePaths } from "./config.mts";
import { exchangeOptions } from "./exchange.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { MessageReferenceResolver, readSelectedLocalReferences } from "./message-reference.mts";
import { DEFAULT_POLICY } from "./policy.mts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const N = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", MID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-reference-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  writeLocalSessions(paths, [{ sessionId: A, name: "never-published", runtime: "claude-code", state: "unknown" },
    { sessionId: B, name: A, runtime: "codex", state: "unknown" }], Date.now(), 1);
  return paths;
}
function request(ref = "never-published"): ResolveRequest {
  return { version: 1, requestId: crypto.randomUUID(), messageId: MID, purpose: "admit",
    selections: [{ role: "to", ref }], expiresAt: Date.now() + 5000 };
}
test("S04 S07 S35: exact wins over an alias, UNKNOWN is selected metadata only, no private projection", t => {
  const paths = fixture(t);
  const selected = readSelectedLocalReferences(paths, [{ role: "from", ref: A }, { role: "to", ref: "never-published" }]);
  for (const r of selected.results) { assert.equal(r.code, "BOUND"); if (r.code === "BOUND") assert.deepEqual(r.owner, { sessionId: A, runtime: "claude-code" }); }
  assert.equal(selected.results[0].code === "BOUND" && selected.results[0].match, "exact");
  assert.equal(selected.results[1].code === "BOUND" && selected.results[1].match, "alias");
  assert.doesNotMatch(JSON.stringify(selected.results), /cwd|filename|state|policy|title|proof|liveness|never-published/);
});
test("S05 S35: duplicate aliases, capped documents and unreadable metadata do not become missing", t => {
  const paths = fixture(t);
  writeLocalSessions(paths, [{ sessionId: A, name: "same", runtime: "codex", state: "unknown" },
    { sessionId: B, name: "same", runtime: "claude-code", state: "closed" }]);
  assert.equal(readSelectedLocalReferences(paths, [{ role: "to", ref: "same" }]).results[0].code, "AMBIGUOUS");
  fs.writeFileSync(paths.sessions, JSON.stringify({ sessions: [], unseen: ["*"] }));
  assert.equal(readSelectedLocalReferences(paths, [{ role: "to", ref: A }]).results[0].code, "INVALID");
  fs.writeFileSync(paths.sessions, "{");
  assert.equal(readSelectedLocalReferences(paths, [{ role: "to", ref: A }]).results[0].code, "INVALID");
  fs.unlinkSync(paths.sessions);
  assert.equal(readSelectedLocalReferences(paths, [{ role: "to", ref: A }]).results[0].code, "MISSING");
});
test("S04: expected Registry owner cannot be overridden by a different local exact owner", t => {
  const paths = fixture(t);
  assert.equal(readSelectedLocalReferences(paths, [{ role: "to", ref: A, expected: { sessionId: B, runtime: "codex" } }]).results[0].code, "CONFLICT");
});
for (const drift of ["policy", "generation", "expiry", "alias", "disconnect"] as const) test(`S14 S17 S18: ${drift} invalidates a selected lease`, t => {
  const paths = fixture(t); let now = Date.now();
  const resolver = new MessageReferenceResolver(paths, () => now);
  const selectedRequest = request(); selectedRequest.expiresAt = now + 5000;
  const result = resolver.resolve(selectedRequest, "policy-1").results[0];
  assert.equal(result.code, "BOUND"); if (result.code !== "BOUND") return;
  const binding = { version: 1 as const, mode: "exact" as const,
    from: { sessionId: "source", runtime: null, lifecycleGeneration: null },
    to: { ...result.owner, lifecycleGeneration: result.lifecycleGeneration }, leaseId: result.leaseId, localGeneration: result.localGeneration };
  if (drift === "generation") writeLocalSessions(paths, [{ sessionId: A, name: "never-published", runtime: "claude-code", state: "unknown" }], now, 2);
  if (drift === "alias") writeLocalSessions(paths, [{ sessionId: B, name: "never-published", runtime: "codex", state: "unknown" }], now, 1);
  if (drift === "expiry") now += 5001;
  if (drift === "disconnect") resolver.clear();
  assert.equal(resolver.validate(MID, binding, drift === "policy" ? "policy-2" : "policy-1"), false);
});
test("706: a node clock behind the Worker keeps the selection and the lease keeps the request's expiry", t => {
  const paths = fixture(t); let now = Date.now();
  const resolver = new MessageReferenceResolver(paths, () => now);
  const expiresAt = now + 2000 + BINDING_TTL_MS; // created 2 s ahead of this node's clock
  const lease = () => {
    const result = resolver.resolve({ ...request(), expiresAt }, "policy-1").results[0];
    assert.equal(result.code, "BOUND");
    if (result.code !== "BOUND") throw new Error("expected destination lease");
    return { version: 1 as const, mode: "exact" as const, from: { sessionId: "source", runtime: null, lifecycleGeneration: null },
      to: { ...result.owner, lifecycleGeneration: result.lifecycleGeneration }, leaseId: result.leaseId, localGeneration: result.localGeneration };
  };
  const before = lease(), at = lease();
  now = expiresAt - 1;
  assert.equal(resolver.validate(MID, before, "policy-1"), true, "usable until the request's expiresAt");
  now = expiresAt;
  assert.equal(resolver.validate(MID, at, "policy-1"), false, "ended at the request's expiresAt");
});
test("706: the clock allowance applies to the upper bound only", t => {
  const paths = fixture(t), now = Date.now();
  const resolver = new MessageReferenceResolver(paths, () => now);
  const code = (expiresAt: number) => resolver.resolve({ ...request(), expiresAt }, "policy-1").results[0].code;
  assert.equal(code(now + BINDING_TTL_MS + 30_000), "BOUND");
  assert.equal(code(now + BINDING_TTL_MS + 30_001), "STALE");
  assert.equal(code(now), "STALE", "a request at its expiry is expired");
  assert.equal(code(now - 1), "STALE");
});
test("S13 S32 S35: protocol rejects extra keys, duplicate roles and sender-injected binding", () => {
  const r = request();
  assert.equal(isResolveRequest(r), true);
  for (const bad of [{ ...r, body: "private canary" }, { ...r, version: 2 }, { ...r, selections: [...r.selections, ...r.selections] }]) assert.equal(isResolveRequest(bad), false);
  assert.equal(isResolveResponse({ version: 1, requestId: r.requestId, messageId: MID, results: [{ role: "to", code: "MISSING" }] }), true);
  assert.equal(isResolveResponse({ version: 1, requestId: r.requestId, messageId: MID, results: [{ role: "to", code: "MISSING", error: "private canary" }] }), false);
  assert.equal(isDeliveryBinding({ version: 2 }), false);
  assert.equal(isMessageSendBody({ messageId: MID, fromSession: A, to: { nodeId: N, session: B }, text: "x", binding: {} }), false);
});
for (const match of ["exact", "alias"] as const) {
  const bound = { role: "to", code: "BOUND", match, owner: { sessionId: A, runtime: "codex" },
    selectionStamp: N, leaseId: B, lifecycleGeneration: 1 };
  const response = (result: unknown) => ({ version: 1, requestId: N, messageId: MID, results: [result] });
  for (const [label, localGeneration] of [["string", "bad"], ["negative", -1], ["fractional", 0.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1], ["undefined", undefined]] as const) {
    test(`S13: ${match} BOUND response rejects ${label} local generation`, () => {
      assert.equal(isResolveResponse(response({ ...bound, localGeneration })), false);
    });
  }
  test(`S13: ${match} BOUND response requires explicit local generation`, () => {
    assert.equal(isResolveResponse(response(bound)), false);
  });
  for (const localGeneration of [null, 0, 1, Number.MAX_SAFE_INTEGER]) {
    for (const lifecycleGeneration of [null, 1]) {
      test(`S13: ${match} BOUND response accepts local ${localGeneration} and lifecycle ${lifecycleGeneration}`, () => {
        assert.equal(isResolveResponse(response({ ...bound, localGeneration, lifecycleGeneration })), true);
      });
    }
  }
}
test("S14: destination lease capacity recovers after consumption and expiry", t => {
  const paths = fixture(t); let now = Date.now();
  const resolver = new MessageReferenceResolver(paths, () => now);
  const select = () => {
    const r = { ...request(), messageId: crypto.randomUUID(), expiresAt: now + 5000 };
    const result = resolver.resolve(r, "policy-1").results[0];
    assert.equal(result.code, "BOUND");
    if (result.code !== "BOUND") throw new Error("expected destination lease");
    return { messageId: r.messageId, binding: { version: 1 as const, mode: "exact" as const,
      from: { sessionId: "source", runtime: null, lifecycleGeneration: null },
      to: { ...result.owner, lifecycleGeneration: result.lifecycleGeneration },
      leaseId: result.leaseId, localGeneration: result.localGeneration } };
  };
  const overflow = () => {
    const r = { ...request(), messageId: crypto.randomUUID(), expiresAt: now + 5000 };
    assert.equal(resolver.resolve(r, "policy-1").results[0].code, "STALE");
  };
  const old = Array.from({ length: 32 }, select);
  overflow();
  assert.equal(resolver.validate(old[0].messageId, old[0].binding, "policy-1"), true);
  assert.equal(resolver.validate(old[0].messageId, old[0].binding, "policy-1"), false);
  old.push(select());
  overflow();
  now += 5001;
  Array.from({ length: 32 }, select);
  for (const lease of old) assert.equal(resolver.validate(lease.messageId, lease.binding, "policy-1"), false);
  overflow();
});
test("S11 S17 S18 S27: client resolves selected metadata on live connection and stores exact binding once", async t => {
  const paths = fixture(t), exchange = exchangeOptions(paths);
  const policy = { ...DEFAULT_POLICY, messaging: { accept: [{ session: "*", from: ["*"] }] } };
  const client = new NodeClient({ nodeId: N, identity: generateIdentity(), policy, handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "synthetic.example", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }), runtimes: async () => [], sessions: async () => [],
    ...exchange, bindingStorageReady: () => true, storeMessage: body => { storeMessage(paths.inbox, body); } });
  client.authenticated = true;
  const r = request();
  assert.deepEqual(await client.onFrame(JSON.stringify(makeEnvelope("message.resolve.request", r, 0, 0)), false), []);
  const frames = await client.onFrame(JSON.stringify(makeEnvelope("message.resolve.request", r, 0, 0)));
  const parsed = parseEnvelope(frames[0]); assert.equal(parsed.ok, true); if (!parsed.ok) return;
  const response = parsed.envelope.body as ResolveResponse, result = response.results[0];
  assert.equal(result.code, "BOUND"); if (result.code !== "BOUND") return;
  const body = { messageId: MID, from: { nodeId: N, session: "source" }, toSession: A, text: "Synthetic bound body", createdAt: new Date(0).toISOString(),
    binding: { version: 1 as const, mode: "exact" as const, from: { sessionId: "source", runtime: null, lifecycleGeneration: null },
      to: { ...result.owner, lifecycleGeneration: result.lifecycleGeneration }, leaseId: result.leaseId, localGeneration: result.localGeneration } };
  const delivery = JSON.stringify(makeEnvelope("message.deliver", body, 0, 0));
  assert.deepEqual(await client.onFrame(delivery, false), []); assert.equal(getMessage(paths.inbox, MID), null);
  const accepted = parseEnvelope((await client.onFrame(delivery))[0]); assert.equal(accepted.ok && (accepted.envelope.body as { state: string }).state, "accepted");
  assert.equal(getMessage(paths.inbox, MID)?.binding?.to.sessionId, A);
  assert.equal(Object.hasOwn(getMessage(paths.inbox, MID)!.binding!, "leaseId"), false);
  assert.throws(() => storeMessage(paths.inbox, { ...body, toSession: B, binding: { ...body.binding, to: { ...body.binding.to, sessionId: B } } }), /mismatch/);
});
test("S18: client revokes an existing bound lease and refuses a fresh lease under denied sender policy", async t => {
  const paths = fixture(t), policy = { ...DEFAULT_POLICY, messaging: { accept: [{ session: "*", from: [N] }] } };
  let stores = 0;
  const client = new NodeClient({ nodeId: N, identity: generateIdentity(), policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "synthetic.example", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }), runtimes: async () => [], sessions: async () => [],
    ...exchangeOptions(paths), bindingStorageReady: () => true, storeMessage: body => { stores++; storeMessage(paths.inbox, body); } });
  client.authenticated = true;
  const select = async (messageId: string) => {
    const frames = await client.onFrame(JSON.stringify(makeEnvelope("message.resolve.request", { ...request(), messageId }, 0, 0)));
    assert.equal(frames.length, 1);
    const parsed = parseEnvelope(frames[0]); assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("synthetic selected response missing");
    const result = (parsed.envelope.body as ResolveResponse).results[0]; assert.equal(result.code, "BOUND");
    if (result.code !== "BOUND") throw new Error("synthetic destination not bound");
    return { messageId, from: { nodeId: N, session: "source" }, toSession: A, text: "Synthetic S18 denied intake", createdAt: new Date(0).toISOString(),
      binding: { version: 1 as const, mode: "exact" as const, from: { sessionId: "source", runtime: null, lifecycleGeneration: null },
        to: { ...result.owner, lifecycleGeneration: result.lifecycleGeneration }, leaseId: result.leaseId, localGeneration: result.localGeneration } };
  };
  const beforeRevocation = await select(crypto.randomUUID());
  await client.refreshPolicy({ ...policy, messaging: { accept: [] } });
  const deliver = (body: Awaited<ReturnType<typeof select>>) => client.onFrame(JSON.stringify(makeEnvelope("message.deliver", body, 0, 0)));
  assert.deepEqual(await deliver(beforeRevocation), [], "revoked lease defers without an accepted receipt");
  assert.equal(stores, 0); assert.equal(getMessage(paths.inbox, beforeRevocation.messageId), null);
  const underDenial = await select(crypto.randomUUID()), denied = await deliver(underDenial);
  assert.equal(denied.length, 1);
  const parsed = parseEnvelope(denied[0]); assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.envelope.type, "message.status");
  assert.deepEqual(parsed.ok && parsed.envelope.body, { messageId: underDenial.messageId, state: "refused", reason: "not accepted by node policy" });
  assert.equal(stores, 0); assert.equal(getMessage(paths.inbox, underDenial.messageId), null);
});
