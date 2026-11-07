import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, MAX_FRAME_BYTES, parseEnvelope, PONG_FRAME, type Envelope, type SessionInfo } from "../protocol.mts";
import { NodeClient, STAMP_MARGIN, type CommandHandlers } from "./client.mts";
import { nodePaths } from "./config.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { generateIdentity, verifyChallenge } from "./identity.mts";
import { MessageReferenceResolver } from "./message-reference.mts";
import { DEFAULT_POLICY, isAllowed, loadPolicy, type NodePolicy } from "./policy.mts";
import { attachIdentitySnapshot } from "./session-identity.mts";

const NODE_ID = "00000000-0000-4000-8000-0000000000aa";
const FACTS = { hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 2, memoryBytes: 1024 };

function setup(policy: NodePolicy = DEFAULT_POLICY, storeDirectory?: (body: import("../protocol-messages.mts").DirectoryBody) => void) {
  const identity = generateIdentity();
  const calls: string[] = [];
  const taskControl: unknown[] = [];
  const handlers: CommandHandlers = {
    "node.status": async () => { calls.push("node.status"); return { ok: true }; },
    "runtime.list": async () => { calls.push("runtime.list"); return []; },
    "session.list": async () => { calls.push("session.list"); return []; },
  };
  const client = new NodeClient({
    nodeId: NODE_ID, identity, policy, handlers, storeDirectory, facts: () => FACTS, runtimes: async () => [], sessions: async () => [],
    storeMessage: () => { throw new Error("messaging is not enabled in these tests"); },
    taskControlExecute: async (body) => { taskControl.push(body); },
    taskControlRegistrationReceipt: (body) => { taskControl.push(body); },
    taskControlResultReceipt: (body) => { taskControl.push(body); },
    taskControlQueryResult: (body) => { taskControl.push(body); },
  });
  return { client, identity, calls, taskControl };
}

const decode = (frames: string[]): Envelope[] => frames.map((f) => {
  const parsed = parseEnvelope(f);
  assert.ok(parsed.ok);
  return parsed.envelope;
});

async function authed(policy?: NodePolicy) {
  const ctx = setup(policy);
  const [auth] = decode(await ctx.client.onFrame(JSON.stringify(makeEnvelope("challenge", { nonce: "bm9uY2U", serverTime: 0 }, 0, 0))));
  assert.equal(auth.type, "auth");
  assert.equal(verifyChallenge(ctx.identity.publicKey, auth.body as never), true);
  const afterOk = decode(await ctx.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))));
  assert.deepEqual(afterOk.map((e) => e.type), ["register", "sessions.snapshot", "directory.get"]);
  return ctx;
}

const command = (seq: number, name: string) =>
  JSON.stringify(makeEnvelope("command", { commandId: `c${seq}`, command: name }, seq, 0, `c${seq}`));

test("answers the challenge with a verifiable signature and registers after auth.ok", async () => {
  await authed();
});

test("ignores commands before authentication and pong frames", async () => {
  const { client, calls } = setup();
  assert.deepEqual(await client.onFrame(command(1, "node.status")), []);
  assert.deepEqual(await client.onFrame(PONG_FRAME), []);
  assert.deepEqual(calls, []);
});

test("rejects a command outside the Phase 1 allowlist even when authenticated", async () => {
  const { client, calls } = await authed();
  const out = decode(await client.onFrame(command(1, "shell.exec")));
  assert.deepEqual(out.map((e) => e.type), ["command.ack", "command.result"]);
  assert.deepEqual(out[1].body, { commandId: "c1", ok: false, error: "rejected by local policy" });
  assert.deepEqual(calls, []);
});

test("rejects an allowlisted Phase 1 command that the local policy removed", async () => {
  const { client, calls } = await authed({ version: 1, allowedCommands: ["node.status"] });
  const out = decode(await client.onFrame(command(1, "runtime.list")));
  assert.equal((out[1].body as { ok: boolean }).ok, false);
  const ok = decode(await client.onFrame(command(2, "node.status")));
  assert.equal((ok[1].body as { ok: boolean }).ok, true);
  assert.deepEqual(calls, ["node.status"]);
});

test("executes a resent command once and acknowledges the duplicate", async () => {
  const { client, calls } = await authed();
  const first = decode(await client.onFrame(command(1, "node.status")));
  assert.equal(first[1].ack, 1);
  client.connectionClosed();
  assert.equal(client.ack, 1);
  const again = decode(await client.onFrame(command(1, "node.status")));
  assert.deepEqual(again.map((e) => e.type), []); // not authenticated on the new connection yet
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const dup = decode(await client.onFrame(command(1, "node.status")));
  assert.deepEqual(dup.map((e) => e.type), ["command.ack"]);
  assert.deepEqual(calls, ["node.status"]);
});

test("a policy file can narrow but never widen the allowlist; a broken file allows nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-node-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "policy.json");
  assert.deepEqual(loadPolicy(file), DEFAULT_POLICY);
  fs.writeFileSync(file, JSON.stringify({ version: 1, allowedCommands: ["node.status", "shell.exec", "session.start"] }));
  const narrowed = loadPolicy(file);
  assert.deepEqual(narrowed.allowedCommands, ["node.status"]);
  assert.equal(isAllowed(narrowed, "shell.exec"), false);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(loadPolicy(file).allowedCommands, []);
  fs.writeFileSync(file, JSON.stringify({ allowedCommands: ["node.status"] }));
  assert.deepEqual(loadPolicy(file).allowedCommands, []);
});

test("typed task-control events are handled only after authentication and outbound bodies use event envelopes", async () => {
  const { client, taskControl } = await authed();
  const execute = { name: "task.control.execute", operationId: "20000000-0000-4000-8000-000000000001",
    requestId: "10000000-0000-4000-8000-000000000001", taskId: "30000000-0000-4000-8000-000000000001",
    action: "status", ownerNodeId: "00000000-0000-4000-8000-0000000000bb", targetNodeId: NODE_ID, runtime: "codex",
    origin: { kind: "source-request", sourceRequestId: "40000000-0000-4000-8000-000000000001" }, grantVersion: 1 };
  assert.deepEqual(await client.onFrame(JSON.stringify(makeEnvelope("event", execute, 0, 0))), []);
  assert.deepEqual(taskControl, [execute]);
  await client.onFrame(JSON.stringify(makeEnvelope("event", { ...execute, taskId: "not-an-id" }, 0, 0)));
  assert.equal(taskControl.length, 1, "invalid execute ignored");
  const [out] = decode(client.sendTaskControl({ name: "task.control.query", requestId: execute.requestId }));
  assert.equal(out.type, "event");
  assert.deepEqual(out.body, { name: "task.control.query", requestId: execute.requestId });

  const registrationId = "50000000-0000-4000-8000-000000000001";
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "task.control.registration.receipt",
    registrationId, ok: false, errorCode: "capability_required" }, 0, 0)));
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "task.control.registration.receipt",
    registrationId, ok: false, errorCode: "source_not_found" }, 0, 0)));
  const pending = { name: "task.control.query.result", requestId: execute.requestId, operationId: execute.operationId,
    state: "pending", taskId: execute.taskId, targetNodeId: NODE_ID, action: "status", freshness: "unavailable" };
  await client.onFrame(JSON.stringify(makeEnvelope("event", pending, 0, 0)));
  const completed = { ...pending, state: "succeeded", runtime: "codex", taskState: "running", processState: "running",
    runVersion: "a".repeat(64), observedAt: new Date(0).toISOString(), freshness: "cached",
    stopSupported: true, stopConfirmed: false };
  await client.onFrame(JSON.stringify(makeEnvelope("event", completed, 0, 0)));
  assert.deepEqual(taskControl.slice(1), [
    { name: "task.control.registration.receipt", registrationId, ok: false, errorCode: "capability_required" },
    { name: "task.control.registration.receipt", registrationId, ok: false, errorCode: "source_not_found" },
    pending, completed,
  ], "retry receipts and pending-to-terminal queries are not deduplicated by correlation id");
});

// Issue #441: a delivery answered on the intake lane while a command handler
// awaits must not carry a higher seq than that command's ack, or the Worker
// drops the ack as a duplicate (it keeps only strictly increasing node seqs).
test("onCommand allocates the ack after the handler", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const client = new NodeClient({
    nodeId: NODE_ID, identity: generateIdentity(), facts: () => FACTS, runtimes: async () => [], sessions: async () => [],
    policy: { ...DEFAULT_POLICY, allowedCommands: ["node.status"], messaging: { accept: [{ from: ["*"], session: "*" }] } } as NodePolicy,
    handlers: {
      "node.status": async () => { await held; return { ok: true }; },
      "runtime.list": async () => [], "session.list": async () => [],
    },
    storeMessage: () => {},
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const commandFrames = client.onFrame(command(1, "node.status"));
  const [accepted] = decode(await client.onFrame(JSON.stringify(makeEnvelope("message.deliver", {
    messageId: "00000000-0000-4000-8000-000000000001", from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" },
    toSession: "synthetic-session", text: "synthetic", createdAt: new Date(0).toISOString() }, 0, 0))));
  assert.equal(accepted.type, "message.status");
  release();
  const [ack, result] = decode(await commandFrames);
  assert.equal(ack.type, "command.ack");
  assert.equal(result.type, "command.result");
  // Build order only: the wire order is stamped at the send step (daemon-wire-order.test.mts).
  assert.ok(ack.seq > accepted.seq, `ack built with seq ${ack.seq} after accepted built with seq ${accepted.seq}`);
  assert.ok(result.seq > ack.seq);
});

// Issue #441: every node frame carries ack = processedSeq, and the Worker drops
// its resend copy of every command up to it. A frame sent on the intake lane
// while a handler runs must not ack that command before its result exists.
function heldClient(logs: string[] = []) {
  let release: () => void = () => {};
  let runs = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const client = new NodeClient({
    nodeId: NODE_ID, identity: generateIdentity(), facts: () => FACTS, runtimes: async () => [], sessions: async () => [],
    policy: { ...DEFAULT_POLICY, allowedCommands: ["node.status"], messaging: { accept: [{ from: ["*"], session: "*" }] } } as NodePolicy,
    handlers: {
      "node.status": async () => { runs++; await held; return { ok: true }; },
      "runtime.list": async () => [], "session.list": async () => [],
    },
    storeMessage: () => {}, log: (line) => logs.push(line),
  });
  return { client, release: () => release(), runs: () => runs };
}
const delivery = (n: number): string => JSON.stringify(makeEnvelope("message.deliver", {
  messageId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" },
  toSession: "synthetic-session", text: "synthetic", createdAt: new Date(0).toISOString() }, 0, 0));

test("a frame sent while a command handler is pending does not ack that command", async () => {
  const { client, release } = heldClient();
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const pending = client.onFrame(command(7, "node.status"));
  const [during] = decode(await client.onFrame(delivery(1)));
  assert.ok(during.ack < 7, `accepted carries ack ${during.ack} below the pending command seq 7`);
  release();
  const [ack, result] = decode(await pending);
  assert.deepEqual([ack.type, ack.ack, result.ack], ["command.ack", 7, 7]);
  const [after] = decode(await client.onFrame(delivery(2)));
  assert.equal(after.ack, 7, "the next frame acks the completed command");
});

test("a resend after the handler resolved returns only command.ack and does not run the handler twice", async () => {
  const { client, release, runs } = heldClient();
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  release();
  assert.deepEqual(decode(await client.onFrame(command(3, "node.status"))).map((e) => e.type), ["command.ack", "command.result"]);
  const resend = decode(await client.onFrame(command(3, "node.status")));
  assert.deepEqual(resend.map((e) => [e.type, e.ack]), [["command.ack", 3]]);
  assert.equal(runs(), 1);
});

// Issue #441: a built frame's seq is provisional; the daemon's single send step
// stamps the wire seq and the current ack, so lanes cannot reorder the wire.
test("stamp assigns the wire seq at send time and the current ack", async () => {
  const { client, release } = heldClient();
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const pending = client.onFrame(command(7, "node.status"));
  const [status] = await client.onFrame(delivery(1));
  const wireStatus = client.stamp(status!);
  release();
  const [ack, result] = await pending;
  const [stampedStatus, stampedAck, stampedResult] = decode([wireStatus, client.stamp(ack!), client.stamp(result!)]);
  assert.deepEqual([stampedStatus.seq, stampedAck.seq, stampedResult.seq], [1, 2, 3]);
  assert.deepEqual([stampedStatus.ack, stampedAck.ack, stampedResult.ack], [0, 7, 7]);
  const [built] = decode([status!]);
  assert.deepEqual({ ...stampedStatus, seq: built.seq, ack: built.ack }, built, "only seq and ack change");
});

test("stamp keeps an unsequenced frame at seq 0 and leaves an unparseable string unchanged", async () => {
  const { client, release } = heldClient();
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  release();
  await client.onFrame(command(3, "node.status"));
  const [unsequenced] = decode([client.stamp(JSON.stringify(makeEnvelope("auth", { nodeId: NODE_ID }, 0, 0)))]);
  assert.deepEqual([unsequenced.seq, unsequenced.ack], [0, 3]);
  assert.equal(client.stamp("not json"), "not json");
  assert.equal(client.stamp(PONG_FRAME), PONG_FRAME);
  const [next] = decode([client.stamp(client.directoryRequest()[0]!)]);
  assert.equal(next.seq, 1, "an unsequenced frame consumes no wire seq");
});

test("a Worker error frame that names no message is logged once", async () => {
  const logs: string[] = [];
  const { client } = heldClient(logs);
  await client.onFrame(JSON.stringify(makeEnvelope("error", { error: "synthetic rejection" }, 0, 0)));
  assert.deepEqual(logs, ["kherep-node: control plane rejected a frame: synthetic rejection"]);
});

test("I10: snapshot generation participates in frame deduplication", async () => {
  const { attachIdentitySnapshot } = await import("./session-identity.mts");
  const { client } = await authed();
  const rows = [{ sessionId: "synthetic", runtime: "codex", state: "unknown" }];
  attachIdentitySnapshot(rows, 1);
  assert.equal(decode(client.sessionFrames(rows))[0].body && client.sessionFrames(rows).length, 0);
  attachIdentitySnapshot(rows, 2);
  assert.deepEqual(decode(client.sessionFrames(rows))[0].body, { sessions: rows, identitySnapshot: { version: 1, generation: 2 } });
});

// Issue #706: a sessions.snapshot must fit one frame, or the Worker rejects all of it.
async function snapshotClient() {
  const logs: string[] = [];
  const { client } = heldClient(logs);
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  return { client, logs };
}
const carried = (count: number, cwd = "/".padEnd(400, "x")): SessionInfo[] =>
  Array.from({ length: count }, (_, i) => ({ sessionId: `carried-${i}`, runtime: "codex", state: "unknown", cwd }));
const proof = (sessionId: string) => ({ version: 1, source: "codex-hook", runtime: "codex", sessionId, observedAt: 1, lifecycleGeneration: 0 }) as SessionInfo["canonicalIdentity"];
const snapshotBody = (frame: string) => JSON.parse(frame).body as { sessions: SessionInfo[]; identitySnapshot?: unknown };

test("sessionFrames keeps a snapshot within MAX_FRAME_BYTES by dropping unknown unproven rows from the end", async () => {
  const { client, logs } = await snapshotClient();
  const rows = carried(600);
  attachIdentitySnapshot(rows, 7);
  const frames = client.sessionFrames(rows);
  assert.equal(frames.length, 1);
  assert.ok(Buffer.byteLength(frames[0], "utf8") + STAMP_MARGIN <= MAX_FRAME_BYTES);
  const body = snapshotBody(frames[0]);
  const kept = body.sessions.length;
  assert.ok(kept > 0 && kept < rows.length);
  assert.deepEqual(body.sessions, rows.slice(0, kept), "the kept rows are a prefix");
  assert.deepEqual(body.identitySnapshot, { version: 1, generation: 7 }, "trimming keeps the generation");
  assert.deepEqual(logs, [`kherep-node: sessions.snapshot trimmed ${rows.length - kept} of ${rows.length} rows (frame too large)`]);
  // As much as fits: one more carried row would not have.
  assert.ok(Buffer.byteLength(frames[0], "utf8") + STAMP_MARGIN + Buffer.byteLength(JSON.stringify(rows[kept]), "utf8") + 1 > MAX_FRAME_BYTES);
});

test("sessionFrames: a trimmed frame passes parseEnvelope with both stamps at their largest", async () => {
  const { client } = await snapshotClient();
  const [frame] = client.sessionFrames(carried(600));
  Object.assign(client, { sent: Number.MAX_SAFE_INTEGER - 1, processedSeq: Number.MAX_SAFE_INTEGER });
  const stamped = client.stamp(frame);
  assert.equal(JSON.parse(stamped).seq, Number.MAX_SAFE_INTEGER);
  assert.equal(JSON.parse(stamped).ack, Number.MAX_SAFE_INTEGER);
  assert.ok(Buffer.byteLength(stamped, "utf8") <= MAX_FRAME_BYTES);
  assert.equal(parseEnvelope(stamped).ok, true);
});

test("sessionFrames measures the envelope and its stamp margin, in bytes", async () => {
  const padded = (extra: number, fill = "x"): SessionInfo[] => [carried(1, "/")[0], { ...carried(2, "/")[1], cwd: "/" + fill.repeat(extra) }];
  const size = async (rows: SessionInfo[]) => Buffer.byteLength((await snapshotClient()).client.sessionFrames(rows)[0], "utf8");
  const atLimit = MAX_FRAME_BYTES - STAMP_MARGIN - await size(padded(0));
  const fits = await snapshotClient();
  assert.equal(snapshotBody(fits.client.sessionFrames(padded(atLimit))[0]).sessions.length, 2, "exactly at the limit nothing is dropped");
  assert.deepEqual(fits.logs, []);
  const over = await snapshotClient();
  assert.equal(snapshotBody(over.client.sessionFrames(padded(atLimit + 1))[0]).sessions.length, 1, "one byte over the row goes");
  assert.equal(over.logs.length, 1);
  // Fewer characters than the limit, more bytes: bytes decide.
  const wide = await snapshotClient();
  assert.equal(snapshotBody(wide.client.sessionFrames(padded(atLimit - 1, "\u00fc"))[0]).sessions.length, 1);
});

test("sessionFrames never drops a live or attested row", async () => {
  const { client, logs } = await snapshotClient();
  const running = ["live-1", "live-2", "live-3"].map((sessionId) => ({ sessionId, runtime: "codex", state: "running", canonicalIdentity: proof(sessionId) }));
  const provenUnknown = { sessionId: "proven", runtime: "codex", state: "unknown", canonicalIdentity: proof("proven") };
  const liveUnproven = { sessionId: "unproven", runtime: "codex", state: "idle" };
  const rows = [...carried(300), provenUnknown, ...carried(300).map((row) => ({ ...row, sessionId: `${row.sessionId}-b` })), liveUnproven, ...running];
  const { sessions } = snapshotBody(client.sessionFrames(rows)[0]);
  const ids = sessions.map((row) => row.sessionId);
  for (const id of ["proven", "unproven", "live-1", "live-2", "live-3"]) assert.ok(ids.includes(id), `${id} stays`);
  assert.deepEqual(ids, rows.map((row) => row.sessionId).filter((id) => ids.includes(id)), "the order is unchanged");
  assert.equal(logs.length, 1);
});

test("sessionFrames sends nothing and logs when live rows alone exceed one frame", async () => {
  const { client, logs } = await snapshotClient();
  const small = carried(1, "/");
  assert.equal(client.sessionFrames(small).length, 1);
  const live = carried(600).map((row) => ({ ...row, state: "running" }));
  assert.deepEqual(client.sessionFrames(live), []);
  assert.deepEqual(logs, ["kherep-node: sessions.snapshot withheld: 600 live rows exceed one frame"]);
  assert.equal(client.sessionFrames(small).length, 1, "the cached snapshot is cleared, so the next call rebuilds");
});

test("sessionFrames logs one line per distinct count, and counts only", async () => {
  const { client, logs } = await snapshotClient();
  const rows = carried(600);
  attachIdentitySnapshot(rows, 1);
  assert.equal(client.sessionFrames(rows).length, 1);
  assert.deepEqual(client.sessionFrames(rows), [], "an unchanged trimmed snapshot is deduplicated");
  attachIdentitySnapshot(rows, 2);
  assert.equal(client.sessionFrames(rows).length, 1, "a new generation sends again");
  assert.equal(logs.length, 1);
  assert.equal(client.sessionFrames(carried(601)).length, 1);
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => !line.includes("carried-")));
});

test("a snapshot under the limit is byte-identical to the untrimmed frame", async () => {
  const { client, logs } = await snapshotClient();
  const rows: SessionInfo[] = [{ sessionId: "synthetic", runtime: "codex", state: "unknown" }];
  attachIdentitySnapshot(rows, 1);
  const [frame] = client.sessionFrames(rows);
  const { id, seq, ack, ts } = JSON.parse(frame);
  const body = { sessions: rows, identitySnapshot: { version: 1, generation: 1 } };
  assert.equal(frame, JSON.stringify({ ...makeEnvelope("sessions.snapshot", body, seq, ack, id), ts }));
  assert.deepEqual(logs, []);
});

test("an error frame \"frame too large\" clears the cached snapshot", async () => {
  const { client, logs } = await snapshotClient();
  const rows = carried(1, "/");
  assert.equal(client.sessionFrames(rows).length, 1);
  assert.deepEqual(client.sessionFrames(rows), []);
  await client.onFrame(JSON.stringify(makeEnvelope("error", { error: "synthetic rejection" }, 0, 0)));
  assert.deepEqual(client.sessionFrames(rows), [], "another rejection keeps the cache");
  await client.onFrame(JSON.stringify(makeEnvelope("error", { error: "frame too large" }, 0, 0)));
  assert.equal(client.sessionFrames(rows).length, 1);
  assert.equal(logs.at(-1), "kherep-node: control plane rejected a frame: frame too large");
});

test("828 Directory metadata is stored only on a current authenticated connection",async()=>{
  let stores=0;const {client}=setup(DEFAULT_POLICY,()=>{stores++;});
  const directory=JSON.stringify(makeEnvelope("directory",{nodes:[],sessions:[],fetchedAt:new Date().toISOString()},0,0));
  await client.onFrame(directory);assert.equal(stores,0,"unauthenticated frames cannot become notice evidence");
  await client.onFrame(JSON.stringify(makeEnvelope("event",{name:"auth.ok"},0,0)));
  await client.onFrame(directory);assert.equal(stores,1);
  await client.onFrame(directory,false);assert.equal(stores,1,"old connection cannot advance metadata");
  client.connectionClosed();await client.onFrame(directory);assert.equal(stores,1);
});

// Issue #706: a resolve the node skipped or could not bind names why in its log, metadata only.
const RESOLVE_NOW = 1_000_000_000, SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SESSION_NAME = "synthetic-private-name";
const REQUEST_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const resolveFrame = (body: Record<string, unknown>): string => JSON.stringify(makeEnvelope("message.resolve.request", { version: 1, requestId: REQUEST_ID,
  messageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", purpose: "admit", selections: [{ role: "to", ref: SESSION_NAME }], expiresAt: RESOLVE_NOW + 5000, ...body }, 0, 0));
function resolveClient(t: test.TestContext, overrides: { resolver?: false; storage?: boolean; authenticated?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-resolve-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root), logs: string[] = [];
  writeLocalSessions(paths, [{ sessionId: SESSION_ID, name: SESSION_NAME, runtime: "codex", state: "unknown" }], RESOLVE_NOW, 1);
  const client = new NodeClient({ nodeId: NODE_ID, identity: generateIdentity(), policy: DEFAULT_POLICY, facts: () => FACTS, runtimes: async () => [], sessions: async () => [],
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] }, storeMessage: () => {},
    ...(overrides.resolver === false ? {} : { selectedReferences: new MessageReferenceResolver(paths, () => RESOLVE_NOW) }),
    bindingStorageReady: () => overrides.storage !== false, now: () => RESOLVE_NOW, log: line => logs.push(line) });
  client.authenticated = overrides.authenticated !== false;
  return { client, logs };
}
const assertMetadataOnly = (line: string | undefined): void => {
  assert.ok(line);
  for (const forbidden of [SESSION_ID, SESSION_NAME, "codex", "policy", os.tmpdir()]) assert.equal(line.includes(forbidden), false, forbidden);
};

for (const [reason, overrides, live] of [
  ["not live", {}, false], ["not authenticated", { authenticated: false }, true],
  ["storage not ready", { storage: false }, true], ["no resolver", { resolver: false }, true],
] as const) test(`706: a resolve skipped as ${reason} logs the condition with requestId and margin`, async t => {
  const { client, logs } = resolveClient(t, overrides);
  assert.deepEqual(await client.onFrame(resolveFrame({}), live), []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`skipped: ${reason} `));
  assert.match(logs[0], new RegExp(`requestId=${REQUEST_ID} margin_ms=5000$`));
  assertMetadataOnly(logs[0]);
});

test("706: a malformed resolve is skipped without repeating its fields", async t => {
  const { client, logs } = resolveClient(t);
  assert.deepEqual(await client.onFrame(resolveFrame({ requestId: SESSION_NAME, expiresAt: SESSION_ID })), []);
  assert.deepEqual(await client.onFrame(resolveFrame({ extra: SESSION_NAME })), []);
  assert.deepEqual(logs.map(line => line.replace(/^.*skipped: /, "")), ["malformed requestId=invalid margin_ms=unknown",
    `malformed requestId=${REQUEST_ID} margin_ms=5000`]);
  logs.forEach(assertMetadataOnly);
});

test("706: an answer with a non-BOUND result logs its role:code pairs, the margin may be negative", async t => {
  const { client, logs } = resolveClient(t);
  assert.equal((await client.onFrame(resolveFrame({ selections: [{ role: "from", ref: "synthetic-absent" }, { role: "to", ref: SESSION_ID }] }))).length, 1);
  assert.match(logs[0], new RegExp(`answered from:MISSING,to:BOUND requestId=${REQUEST_ID} margin_ms=5000$`));
  assert.doesNotMatch(logs[0], /synthetic-absent/);
  assertMetadataOnly(logs[0]);
  assert.equal((await client.onFrame(resolveFrame({ expiresAt: RESOLVE_NOW - 200 }))).length, 1);
  assert.match(logs[1], new RegExp(`answered to:STALE requestId=${REQUEST_ID} margin_ms=-200$`));
  assert.equal(logs.length, 2);
});

test("706: a BOUND answer logs only when under one second of margin remains", async t => {
  const { client, logs } = resolveClient(t);
  assert.equal((await client.onFrame(resolveFrame({}))).length, 1);
  assert.equal((await client.onFrame(resolveFrame({ expiresAt: RESOLVE_NOW + 1000 }))).length, 1);
  assert.deepEqual(logs, [], "a healthy BOUND resolve logs nothing");
  assert.equal((await client.onFrame(resolveFrame({ expiresAt: RESOLVE_NOW + 999 }))).length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`answered to:BOUND requestId=${REQUEST_ID} margin_ms=999$`));
  assertMetadataOnly(logs[0]);
});
