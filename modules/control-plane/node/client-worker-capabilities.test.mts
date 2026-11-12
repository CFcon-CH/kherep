import assert from "node:assert/strict";
import test from "node:test";

import { makeEnvelope } from "../protocol.mts";
import { MESSAGING_PROXY_CAPABILITY, type DirectoryBody } from "../protocol-messages.mts";
import { NodeClient } from "./client.mts";
import { generateIdentity } from "./identity.mts";
import { DEFAULT_POLICY } from "./policy.mts";

// Issue #408, PR 4, design r3 section 3.3 (R2-2/WX3): the Worker capability
// a node relays a proxy answer under is held in memory for the current
// authenticated connection only. Set from a directory frame that arrived on
// the live socket while authenticated; cleared at every close and every
// auth.ok. Only live authenticated Directory frames reach the local readers.

const directory = (worker?: string[]): string => JSON.stringify(makeEnvelope("directory", {
  nodes: [], sessions: [], fetchedAt: new Date(0).toISOString(), ...(worker ? { worker: { capabilities: worker } } : {}),
} satisfies DirectoryBody, 0, 0));
const challenge = JSON.stringify(makeEnvelope("challenge", { nonce: "bm9uY2U", serverTime: 0 }, 0, 0));
const authOk = JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0));

function client() {
  const stored: DirectoryBody[] = [];
  const c = new NodeClient({
    nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, storeDirectory: (body) => { stored.push(body); },
  });
  return { c, stored };
}

test("set only from a live directory frame of an authenticated connection; cleared at close and at auth.ok", async () => {
  const { c, stored } = client();
  assert.equal(c.workerCapabilities, null);
  await c.onFrame(directory([MESSAGING_PROXY_CAPABILITY]));
  assert.equal(c.workerCapabilities, null, "not authenticated");
  assert.equal(stored.length,0,"unauthenticated metadata is not stored");
  await c.onFrame(challenge);
  await c.onFrame(authOk);
  assert.equal(c.workerCapabilities, null, "auth.ok starts without proof");
  await c.onFrame(directory([MESSAGING_PROXY_CAPABILITY]), false);
  assert.equal(c.workerCapabilities, null, "a frame of a socket that is no longer the live one");
  assert.equal(stored.length,0,"a stale connection supplies no metadata");
  await c.onFrame(directory([MESSAGING_PROXY_CAPABILITY]));
  assert.deepEqual(c.workerCapabilities, [MESSAGING_PROXY_CAPABILITY]);
  c.connectionClosed();
  assert.equal(c.workerCapabilities, null, "cleared at close");
  assert.equal(stored.at(-1)?.worker?.capabilities[0], MESSAGING_PROXY_CAPABILITY, "directory.json keeps its last frame");
  await c.onFrame(directory([MESSAGING_PROXY_CAPABILITY]));
  assert.equal(c.workerCapabilities, null, "closed and not authenticated again");
  assert.equal(stored.length,1,"closed connections do not change the retained directory");
  await c.onFrame(challenge);
  await c.onFrame(authOk);
  await c.onFrame(directory([MESSAGING_PROXY_CAPABILITY]));
  assert.deepEqual(c.workerCapabilities, [MESSAGING_PROXY_CAPABILITY]);
  await c.onFrame(authOk);
  assert.equal(c.workerCapabilities, null, "a new authentication clears an earlier value");
  await c.onFrame(directory());
  assert.deepEqual(c.workerCapabilities, [], "an old Worker: no field, no capability");
  await c.onFrame(directory(["other.v1"]));
  assert.deepEqual(c.workerCapabilities, ["other.v1"]);
  assert.equal(stored.length, 4, "only the four current authenticated directory frames are stored");
});

test("diagnostics follow live Worker negotiation, and capability loss strips them for the archived validator", async () => {
  const { blockerDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY } = await import("../protocol-diagnostics.mts");
  const { isNodeMessageStatusBody } = await import("../test/fixtures/diagnostics-pre-v1.mts");
  const { c } = client();
  const id = "00000000-0000-4000-8000-000000000001";
  const detail = blockerDiagnostic("runtime-pending", 0);
  await c.onFrame(challenge); await c.onFrame(authOk);
  const report = () => JSON.parse(c.reportStatus(id, "accepted", undefined, undefined, detail)[0]).body;
  assert.equal(isNodeMessageStatusBody(report()), true, "unknown Worker");
  await c.onFrame(directory([MESSAGING_DIAGNOSTICS_CAPABILITY]));
  assert.deepEqual(report().diagnostic, detail);
  assert.equal(isNodeMessageStatusBody(report()), false, "real old validator rejects new field");
  c.connectionClosed(); await c.onFrame(challenge); await c.onFrame(authOk); await c.onFrame(directory([]));
  assert.equal(isNodeMessageStatusBody(report()), true);
  assert.equal(report().diagnostic, undefined);
});

// Issue #883: the target node sends target-not-loaded only to a Worker that advertised messaging.diagnostics.v3. The deployed
// Worker without it would refuse the whole message.status, so it gets target-not-idle, the code a sender saw before.
test("target-not-loaded reaches only a v3 Worker; any other Worker gets target-not-idle", async () => {
  const { blockerDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY: V1, MESSAGING_DIAGNOSTICS_V3_CAPABILITY: V3 } = await import("../protocol-diagnostics.mts");
  const preV3 = await import("../test/fixtures/diagnostics-pre-v3.mts");
  const { c } = client();
  const id = "00000000-0000-4000-8000-000000000883";
  const detail = blockerDiagnostic("target-not-loaded", 0, "target-progress", "unknown");
  const progress = { phase: "waiting", code: "target-busy", observedAt: detail.observedAt } as const;
  await c.onFrame(challenge); await c.onFrame(authOk);
  const report = () => JSON.parse(c.reportStatus(id, "accepted", undefined, progress, detail)[0]).body;
  await c.onFrame(directory([MESSAGING_PROXY_CAPABILITY, "messaging.loop-brake.v1", V1]));
  assert.deepEqual(report().diagnostic, { ...detail, code: "target-not-idle" }, "the deployed Worker's list");
  assert.equal(preV3.isMessageDiagnostic(report().diagnostic), true);
  assert.deepEqual(report().progress, progress);
  await c.onFrame(directory([MESSAGING_PROXY_CAPABILITY, "messaging.loop-brake.v1", V1, V3]));
  assert.deepEqual(report().diagnostic, detail);
});
