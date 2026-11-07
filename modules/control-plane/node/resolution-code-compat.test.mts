import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { blockerDiagnostic, compatibleDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY, MESSAGING_DIAGNOSTICS_V2_CAPABILITY } from "../protocol-diagnostics.mts";
import { makeEnvelope } from "../protocol.mts";
import { isMessageDiagnostic as previousNodeAccepts } from "../test/fixtures/diagnostics-pre-v2.mts";
import { NodeClient } from "./client.mts";
import { nodePaths } from "./config.mts";
import { getSent, recordSent, writeOutbox } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { runMsg } from "./msg-cli.mts";
import { DEFAULT_POLICY, advertisedCapabilities } from "./policy.mts";

const ID = "00000000-0000-4000-8000-000000000706", T0 = Date.parse("2026-11-07T00:00:00.000Z");
function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolution-code-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = nodePaths(dir);
  for (const sub of [paths.inbox, paths.outbox, paths.sent]) fs.mkdirSync(sub, { recursive: true });
  writeOutbox(paths, { messageId: ID, fromSession: "synthetic-sender", to: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-target" }, text: "synthetic", createdAt: new Date(T0).toISOString() });
  const client = new NodeClient({ nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {},
    sentUpdate: (messageId, state, reason, progress, diagnostic) => { recordSent(paths, messageId, state, reason, T0, progress, diagnostic); } });
  return { paths, client };
}
async function statusText(paths: ReturnType<typeof nodePaths>): Promise<string> {
  const lines: string[] = [];
  assert.equal(await runMsg(["status", ID], { paths, env: {}, now: () => T0, out: line => lines.push(line), err: line => { throw new Error(line); } }), 0);
  return lines.join("\n");
}
const refused = (capabilities: string[]) => compatibleDiagnostic({ messageId: ID, state: "refused" as const, reason: "loop-resolution-required",
  diagnostic: blockerDiagnostic("resolution-missing", T0, "send-admission") }, capabilities);
const frame = (body: object) => JSON.stringify(makeEnvelope("message.status", { ...body }, 0, 0));

test("the frame a v1 peer gets is valid at a previous node, records refused and renders the resolution-unavailable words", async t => {
  const { paths, client } = setup(t), body = refused([MESSAGING_DIAGNOSTICS_CAPABILITY]);
  assert.equal(previousNodeAccepts(body.diagnostic), true);
  assert.equal(previousNodeAccepts(blockerDiagnostic("resolution-missing", T0, "send-admission")), false, "the ungated code is what a previous node dropped");
  const acks = await client.onFrame(frame(body));
  assert.equal(getSent(paths, ID)?.state, "refused");
  assert.match(await statusText(paths), /Refused: target owner resolution is unavailable\. Observed 2026-11-07T00:00:00\.000Z; stage send-admission\./);
  assert.equal(acks.length, 0, "not authenticated in this fixture, so no ack frame");
});

test("the frame a v2 peer gets names the node's answer", async t => {
  const { paths, client } = setup(t);
  await client.onFrame(frame(refused([MESSAGING_DIAGNOSTICS_CAPABILITY, MESSAGING_DIAGNOSTICS_V2_CAPABILITY])));
  assert.equal(getSent(paths, ID)?.state, "refused");
  const text = await statusText(paths);
  assert.match(text, /^Refused: /m);
  assert.doesNotMatch(text, /target owner resolution is unavailable/);
});

test("a node advertises both diagnostics capabilities next to each other", () => {
  const list = advertisedCapabilities(DEFAULT_POLICY), v1 = list.indexOf(MESSAGING_DIAGNOSTICS_CAPABILITY);
  assert.ok(v1 >= 0);
  assert.equal(list[v1 + 1], MESSAGING_DIAGNOSTICS_V2_CAPABILITY);
});
