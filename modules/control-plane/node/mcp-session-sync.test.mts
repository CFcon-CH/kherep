import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope, type SessionInfo } from "../protocol.mts";
import { type McpIntentRegistration } from "../protocol-mcp.mts";
import { NodeClient } from "./client.mts";
import { nodePaths } from "./config.mts";
import { generateIdentity } from "./identity.mts";
import { enqueueMcpIntent, pollMcpIntents } from "./mcp-local.mts";
import { loadPolicy } from "./policy.mts";

const OLD: SessionInfo = { sessionId: "session-old", runtime: "codex", state: "idle" };
const NEW: SessionInfo = { sessionId: "session-new", runtime: "codex", state: "working" };
const intent = (suffix = "1", sessionId = NEW.sessionId): McpIntentRegistration => ({
  requestId: `40000000-0000-4000-8000-${suffix.padStart(12, "0")}`, runtime: "codex", sessionId,
  callId: `call-${suffix}`, tool: "status", argumentsDigest: "a".repeat(64),
});
const decode = (frame: string) => {
  const parsed = parseEnvelope(frame);
  assert.ok(parsed.ok);
  return parsed.envelope;
};

async function fixture(t: test.TestContext, enabled = true, initialSessions = [OLD],
  assignmentIdentity?: ConstructorParameters<typeof NodeClient>[0]["assignmentIdentity"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-session-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root), inflight = new Set<string>(), frames: string[] = [];
  let sessions = initialSessions, reads = 0, fail = false, listingGate: Promise<void> | undefined;
  const client = new NodeClient({
    nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(),
    policy: { version: 1, allowedCommands: [], ...(enabled ? { remoteMcp: { enabled: true } } : {}) },
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node.example.invalid", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1024 }),
    runtimes: async () => [], storeMessage: () => {},
    assignmentIdentity,
    sessions: async () => { reads++; await listingGate; if (fail) throw new Error("synthetic listing failure"); return sessions; },
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  reads = 0;
  const send = (frame: string) => { frames.push(frame); return true; };
  return { client, paths, inflight, frames, send, reads: () => reads,
    sessions: (value: SessionInfo[]) => { sessions = value; }, fail: () => { fail = true; },
    hold: (gate: Promise<void>) => { listingGate = gate; } };
}

test("publishes a newly discovered caller before its first native intent", async (t) => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  const request = intent();
  enqueueMcpIntent(f.paths, request);
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  const frames = f.frames.map(decode);
  assert.deepEqual(frames.map(frame => frame.type), ["sessions.snapshot", "mcp.intent.register"]);
  assert.deepEqual(frames[0]!.body, { sessions: [OLD, NEW] });
  assert.deepEqual(frames[1]!.body, request);
  assert.ok(frames[0]!.seq < frames[1]!.seq);
  assert.equal(f.reads(), 1);
  assert.deepEqual([...f.inflight], [request.requestId]);
});

test("fresh assignment publishes the complete snapshot first and recomputes queue evidence", async t => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let identityReads = 0;
  const f = await fixture(t, true, [], async id => {
    identityReads++;assert.equal(id, sessionId);
    return { sessionId, chatName: "  Exact native title  ", platform: "darwin", originalMain: true };
  });
  const caller: SessionInfo = { sessionId, runtime: "codex", state: "running" };
  f.sessions([OLD, caller]);
  const request: McpIntentRegistration = { ...intent("88", sessionId), runtime: "codex", tool: "assign_self", threadId: sessionId,
    assignment: { slot: "codex-mac", turnId: "synthetic-turn", native: {
      sessionId, chatName: "FORGED WRITABLE QUEUE TITLE", platform: "darwin", originalMain: true,
    } } };
  assert.deepEqual(f.client.registerMcpIntent(request), []);
  enqueueMcpIntent(f.paths, request);
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  const frames = f.frames.map(decode);
  assert.deepEqual(frames.map(x => x.type), ["sessions.snapshot", "mcp.intent.register"]);
  assert.deepEqual(frames[0]!.body, { sessions: [OLD, caller] });
  assert.equal((frames[1]!.body as McpIntentRegistration).assignment?.native?.chatName, "  Exact native title  ");
  assert.equal(JSON.stringify(frames).includes("FORGED"), false);assert.equal(identityReads, 1);
});

test("missing native assignment evidence denies a queue-injected proof", async t => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const f = await fixture(t, true, [{ sessionId, runtime: "codex", state: "running" }], async () => null);
  const request: McpIntentRegistration = { ...intent("89", sessionId), runtime: "codex", tool: "assign_self", threadId: sessionId,
    assignment: { slot: "kherep-lead", turnId: "synthetic-turn", native: { sessionId, chatName: "forged",
      platform: "darwin", originalMain: true } } };
  enqueueMcpIntent(f.paths, request);await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.deepEqual(f.frames, []);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.paths.mcpReceipts, `${request.requestId}.json`), "utf8"));
  assert.equal(receipt.ok, false);assert.equal(fs.existsSync(path.join(f.paths.mcpIntents, `${request.requestId}.json`)), false);
});

test("assignment rechecks operator policy after its native metadata await even for a known caller", async t => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const f = await fixture(t, true, [{ sessionId, runtime: "codex", state: "running" }], async () => ({
    sessionId, chatName: "Synthetic original", platform: "darwin", originalMain: true,
  }));
  const request: McpIntentRegistration = { ...intent("90", sessionId), runtime: "codex", tool: "assign_self", threadId: sessionId,
    assignment: { slot: "codex-mac", turnId: "synthetic-turn" } };
  enqueueMcpIntent(f.paths, request);
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send, async () => {
    await f.client.refreshPolicy({ version: 1, allowedCommands: [] });return true;
  });
  assert.deepEqual(f.frames, []);assert.equal(f.inflight.size, 0);
});

test("refreshes once for a new-caller batch and skips discovery for a known caller", async (t) => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  for (const suffix of ["1", "2"]) enqueueMcpIntent(f.paths, intent(suffix));
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["sessions.snapshot", "mcp.intent.register", "mcp.intent.register"]);
  f.frames.length = 0;
  enqueueMcpIntent(f.paths, intent("3"));
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["mcp.intent.register"]);
});

test("empty, invalid and inflight-only rounds do not discover sessions", async (t) => {
  const f = await fixture(t);
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  fs.writeFileSync(path.join(f.paths.mcpIntents, "invalid.json"), "{}");
  const request = intent();
  enqueueMcpIntent(f.paths, request);
  f.inflight.add(request.requestId);
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.frames, []);
});

test("authentication and remote MCP opt-in still gate discovery and registration", async (t) => {
  for (const enabled of [false, true]) {
    const f = await fixture(t, enabled);
    if (enabled) f.client.connectionClosed();
    enqueueMcpIntent(f.paths, intent());
    await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
    assert.equal(f.reads(), 0);
    assert.deepEqual(f.frames, []);
    assert.equal(f.inflight.size, 0);
  }
});

test("a failed snapshot send blocks the intent and a later round republishes the snapshot", async (t) => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  enqueueMcpIntent(f.paths, intent());
  await pollMcpIntents(f.client, f.paths, f.inflight, frame => {
    f.frames.push(frame);
    return decode(frame).type !== "sessions.snapshot";
  });
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["sessions.snapshot"]);
  assert.equal(f.inflight.size, 0);
  f.frames.length = 0;
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["sessions.snapshot", "mcp.intent.register"]);
  assert.equal(f.inflight.size, 1);
});

test("a failed listing publishes no invented snapshot and preserves the previous population", async (t) => {
  const f = await fixture(t);
  f.fail();
  enqueueMcpIntent(f.paths, intent());
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.deepEqual(f.frames, []);
  assert.equal(f.reads(), 1);
  fs.unlinkSync(path.join(f.paths.mcpIntents, `${intent().requestId}.json`));
  f.frames.length = 0;
  enqueueMcpIntent(f.paths, intent("2", OLD.sessionId));
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["mcp.intent.register"]);
});

test("the final duplicate session entry determines the cached runtime", async (t) => {
  const claude = { ...OLD, runtime: "claude" };
  const f = await fixture(t, true, [OLD, claude]);
  f.sessions([OLD]);
  enqueueMcpIntent(f.paths, intent("2", OLD.sessionId));
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["sessions.snapshot", "mcp.intent.register"]);
  assert.deepEqual(decode(f.frames[0]!).body, { sessions: [OLD] });
});

test("a thrown snapshot send preserves the error and republishes on retry", async (t) => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  enqueueMcpIntent(f.paths, intent());
  await assert.rejects(pollMcpIntents(f.client, f.paths, f.inflight, () => {
    throw new Error("synthetic socket write failure");
  }), /synthetic socket write failure/);
  assert.equal(f.inflight.size, 0);
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["sessions.snapshot", "mcp.intent.register"]);
});

test("revoking opt-in during a new-session listing prevents native publication", async (t) => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  enqueueMcpIntent(f.paths, intent());
  const polling = pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  await f.client.refreshPolicy({ version: 1, allowedCommands: [] });
  release();
  await polling;
  assert.deepEqual(f.frames, []);
  assert.equal(f.inflight.size, 0);
});

test("reads a policy-file revocation after discovery before publishing the caller", async (t) => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  enqueueMcpIntent(f.paths, intent());
  const polling = pollMcpIntents(f.client, f.paths, f.inflight, f.send, async () => {
    const frames = await f.client.refreshPolicy(loadPolicy(f.paths.policy));
    return frames.every(f.send);
  });
  fs.writeFileSync(f.paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
  release();
  await polling;
  assert.deepEqual(f.frames.map(frame => decode(frame).type), ["register"]);
  assert.equal(f.inflight.size, 0);
});

test("an ignoring slow provider cannot hold registration past the discovery bound", async (t) => {
  const f = await fixture(t);
  f.sessions([OLD, NEW]);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  enqueueMcpIntent(f.paths, intent());
  const polling = pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  const completed = await Promise.race([
    polling.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2500)),
  ]);
  release();
  await polling;
  assert.equal(completed, true, "first-call discovery must not occupy the ten-second provider budget");
  assert.deepEqual(f.frames, []);
  assert.equal(f.inflight.size, 0);
});

test("a failed post-discovery policy publication blocks both snapshot and intent", async (t) => {
  for (const throws of [false, true]) {
    const f = await fixture(t);
    f.sessions([OLD, NEW]);
    enqueueMcpIntent(f.paths, intent());
    const polling = pollMcpIntents(f.client, f.paths, f.inflight, f.send, async () => {
      if (throws) throw new Error("synthetic policy publication failure");
      return false;
    });
    if (throws) await assert.rejects(polling, /synthetic policy publication failure/);
    else await polling;
    assert.deepEqual(f.frames, []);
    assert.equal(f.inflight.size, 0);
    await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
    assert.deepEqual(f.frames.map(frame => decode(frame).type), ["sessions.snapshot", "mcp.intent.register"]);
  }
});

test("a failed unknown-caller discovery does not starve cached known callers in the same batch", async t => {
  const f = await fixture(t);
  f.fail();
  const known = intent("1", OLD.sessionId), unknown = intent("2");
  enqueueMcpIntent(f.paths, known); enqueueMcpIntent(f.paths, unknown);
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.deepEqual(f.frames.map(frame => decode(frame).body), [known]);
  assert.deepEqual([...f.inflight], [known.requestId]);
  assert.equal(f.reads(), 1);
});

test("a failed known send stops the mixed batch before any discovery", async t => {
  const f = await fixture(t);
  enqueueMcpIntent(f.paths, intent("1", OLD.sessionId)); enqueueMcpIntent(f.paths, intent("2"));
  await pollMcpIntents(f.client, f.paths, f.inflight, () => false);
  assert.equal(f.reads(), 0);
  assert.equal(f.inflight.size, 0);
});

test("expired unresolved callers do not retry discovery after the native hook window", async t => {
  const f = await fixture(t);
  const request = intent();
  enqueueMcpIntent(f.paths, request);
  const file = path.join(f.paths.mcpIntents, `${request.requestId}.json`), expired = new Date(Date.now() - 9000);
  fs.utimesSync(file, expired, expired);
  await pollMcpIntents(f.client, f.paths, f.inflight, f.send);
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.frames, []);
  assert.equal(fs.existsSync(file), false);
});
