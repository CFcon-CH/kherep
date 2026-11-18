import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { makeEnvelope, parseEnvelope, type Envelope } from "../../protocol.mts";
import { isResolveRequest, SELECTED_BINDING_CAPABILITY, type ResolveRequest, type SelectedResult } from "../../protocol-message-binding.mts";
import { authenticate, enroll, FACTS, newKey, registry, session, type TestSocket } from "./helpers.mts";
import { attestedPair, attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";

// Issue #961: a register frame awaits the Registry before it marks the
// connection registered. Frames and RPC calls that arrive in that window must
// see the registration, not a pending one. The seam holds the Registry's
// updateRegistration transaction (registry.mts tx), before or after its commit,
// with a non-storage await, so the NodeSession's own await stays open meanwhile.
// The test only polls and calls into the Registry: a promise resolved inside
// the Registry and awaited by the test made the test's next socket call fail
// with "Cannot perform I/O on behalf of a different Durable Object".
type Seam = { tx: (path: string, run: () => unknown) => unknown; seam?: { reached: boolean; release: () => void } };
async function holdRegistration(at: "before" | "after" | "throw") {
  const original = await runInDurableObject(registry(), instance => {
    const target = instance as unknown as Seam, method = target.tx;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seam: NonNullable<Seam["seam"]> = target.seam = { reached: false, release };
    target.tx = function (this: unknown, path, run) {
      if (path !== "updateRegistration" || seam.reached) return method.call(this, path, run);
      seam.reached = true;
      if (at === "throw") throw new Error("synthetic registration storage failure");
      if (at === "before") return held.then(() => method.call(this, path, run));
      const result = method.call(this, path, run);
      return held.then(() => result);
    };
    return method;
  });
  const inRegistry = <T,>(run: (s: Seam) => T) => runInDurableObject(registry(), instance => run(instance as unknown as Seam));
  return {
    reached: () => vi.waitFor(async () => expect(await inRegistry(s => s.seam?.reached)).toBe(true), { timeout: 3_000, interval: 10 }),
    release: () => inRegistry(s => s.seam?.release()),
    restore: () => inRegistry(s => { s.seam?.release(); s.tx = original; delete s.seam; }),
  };
}

// Waits up to `ms` for `done`, then returns either way. Gives a race the time
// to show itself without making the passing order depend on it.
async function settle(done: () => boolean, ms = 750): Promise<void> {
  try { await vi.waitFor(() => { if (!done()) throw new Error("synthetic wait"); }, { timeout: ms, interval: 10 }); }
  catch { /* the race did not show itself in time */ }
}

// Answers the NodeSession's message.resolve.request frames from the attested rows.
function answerResolves(socket: TestSocket): Envelope[] {
  const frames: Envelope[] = [];
  socket.ws.addEventListener("message", event => {
    const parsed = parseEnvelope(event.data as string);
    if (!parsed.ok) return;
    frames.push(parsed.envelope);
    if (parsed.envelope.type !== "message.resolve.request" || !isResolveRequest(parsed.envelope.body)) return;
    const request = parsed.envelope.body;
    const results = request.selections.map((selection): SelectedResult => {
      const row = attestedRows().find(r => r.sessionId === selection.ref);
      return row ? { role: selection.role, code: "BOUND", match: "exact", owner: { sessionId: row.sessionId, runtime: row.runtime },
        localGeneration: null, lifecycleGeneration: null, selectionStamp: crypto.randomUUID(), leaseId: crypto.randomUUID() }
        : { role: selection.role, code: "MISSING" };
    });
    socket.send(makeEnvelope("message.resolve.response", { version: 1, requestId: request.requestId, messageId: request.messageId, results }, 0, 0));
  });
  return frames;
}

const token = (nodeId: string) => runInDurableObject(registry(), (_i, state) =>
  state.storage.sql.exec("SELECT message_connection_token AS t FROM nodes WHERE id=?", nodeId).one().t);
const register = (socket: TestSocket, capabilities = [...BRAKE_CAPS, SELECTED_BINDING_CAPABILITY]) =>
  socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }], capabilities }, 0, 0));

// A registered, attested node that reconnects: the new connection is not yet registered.
async function reconnected() {
  const f = await attestedPair();
  f.socket.ws.close();
  await vi.waitFor(async () => expect(await token(f.nodeId)).toBeNull());
  const socket = await authenticate(f.nodeId, f.key);
  const frames = answerResolves(socket);
  const close = async () => { socket.ws.close(); await vi.waitFor(async () => expect(await token(f.nodeId)).toBeNull()); };
  return { nodeId: f.nodeId, socket, frames, close };
}

for (const at of ["before", "after"] as const) {
  it(`a message.send behind an in-flight register (held ${at} commit) is admitted, not refused`, async () => {
    const r = await reconnected(), messageId = crypto.randomUUID();
    const hold = await holdRegistration(at);
    try {
      register(r.socket);
      await hold.reached();
      r.socket.send(makeEnvelope("message.send", { messageId, fromSession: ID_A, to: { nodeId: r.nodeId, session: ID_B }, text: "Synthetic send behind register" }, 0, 0));
      const status = () => r.frames.find(f => (f.type === "message.status" || f.type === "error") && (f.body as { messageId?: string }).messageId === messageId);
      await settle(() => status() !== undefined);
      await hold.release();
      await vi.waitFor(() => expect(status()).toBeDefined(), { timeout: 5_000 });
      const body = status()!.body as { state?: string; reason?: string };
      expect([status()!.type, body.state, body.reason]).toEqual(["message.status", "queued", undefined]);
      expect((await session(r.nodeId).loopCapabilityEvidence()).registered).toBe(true);
    } finally { await hold.restore(); await r.close(); }
  });
}

it("a resolve callback for a node whose register is in flight is answered BOUND, not registration-pending", async () => {
  const r = await reconnected();
  const hold = await holdRegistration("after");
  try {
    register(r.socket);
    await hold.reached();
    const request: ResolveRequest = { version: 1, requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), purpose: "admit",
      selections: [{ role: "to", ref: ID_B }], expiresAt: Date.now() + 5_000 };
    let answered = false;
    const pending = session(r.nodeId).resolveMessageReferencesDetailed(request).finally(() => { answered = true; });
    await settle(() => answered);
    await hold.release();
    const result = await pending;
    expect(result.code).toBeUndefined();
    expect(result.answer?.results).toMatchObject([{ role: "to", code: "BOUND", owner: { sessionId: ID_B } }]);
  } finally { await hold.restore(); await r.close(); }
});

it("a second socket registers while the first, never closed by the client, is still attached", async () => {
  const key = await newKey(), nodeId = await enroll(key, "synthetic-two-socket");
  const first = await authenticate(nodeId, key);
  const second = await authenticate(nodeId, key);
  register(second, ["messaging.v1", SELECTED_BINDING_CAPABILITY]);
  await vi.waitFor(async () => expect((await session(nodeId).loopCapabilityEvidence()).registered).toBe(true), { timeout: 3_000 });
  expect(await first.closed).toMatchObject({ code: 4409 });
  second.ws.close();
  await vi.waitFor(async () => expect(await token(nodeId)).toBeNull());
});

// A throw inside blockConcurrencyWhile breaks the object (local workerd logs
// broken.inputGateBroken): seen here as a directory.get left unanswered, or a
// close that never reaches webSocketClose, so the Registry keeps the token.
it("a register whose Registry call throws leaves the connection unregistered and the object intact", async () => {
  const key = await newKey(), nodeId = await enroll(key, "synthetic-register-failure");
  const socket = await authenticate(nodeId, key), frames = answerResolves(socket);
  const before = await session(nodeId).loopCapabilityEvidence();
  const hold = await holdRegistration("throw");
  try {
    register(socket, ["messaging.v1", SELECTED_BINDING_CAPABILITY]);
    await hold.reached();
    socket.send(makeEnvelope("directory.get", {}, 0, 0));
    await vi.waitFor(() => expect(frames.some(f => f.type === "directory")).toBe(true), { timeout: 3_000 });
    expect(await session(nodeId).loopCapabilityEvidence()).toEqual({ ...before, registered: false });
    expect(socket.ws.readyState).toBe(1);
    // The same connection registers once the Registry answers again.
    register(socket, ["messaging.v1", SELECTED_BINDING_CAPABILITY]);
    await vi.waitFor(async () => expect((await session(nodeId).loopCapabilityEvidence()).registered).toBe(true), { timeout: 3_000 });
    expect(await session(nodeId).loopCapabilityEvidence()).toEqual({ ...before, registered: true });
    socket.ws.close();
    await vi.waitFor(async () => expect(await token(nodeId)).toBeNull(), { timeout: 3_000 });
  } finally { await hold.restore(); }
});

it("a register that is not overtaken sends the same frames as before", async () => {
  const key = await newKey(), nodeId = await enroll(key, "synthetic-plain-register");
  const socket = await authenticate(nodeId, key), frames = answerResolves(socket);
  register(socket, ["messaging.v1", SELECTED_BINDING_CAPABILITY]);
  await vi.waitFor(async () => expect((await session(nodeId).loopCapabilityEvidence()).registered).toBe(true));
  socket.send(makeEnvelope("directory.get", {}, 0, 0));
  await vi.waitFor(() => expect(frames.some(f => f.type === "directory")).toBe(true));
  expect(frames.map(f => f.type)).toEqual(["directory"]);
  socket.ws.close();
  await vi.waitFor(async () => expect(await token(nodeId)).toBeNull());
});

// The Registry no longer holds this connection's token, so it refuses the
// register. A frame behind the register is answered only after the block ends.
it("a register the Registry refuses leaves the connection unregistered", async () => {
  const key = await newKey(), nodeId = await enroll(key, "synthetic-refused-register");
  const socket = await authenticate(nodeId, key), frames = answerResolves(socket);
  const before = await session(nodeId).loopCapabilityEvidence();
  await registry().invalidateMessageConnection(nodeId, before.token!);
  register(socket, ["messaging.v1", SELECTED_BINDING_CAPABILITY]);
  socket.send(makeEnvelope("directory.get", {}, 0, 0));
  await vi.waitFor(() => expect(frames.some(f => f.type === "directory")).toBe(true));
  expect(await session(nodeId).loopCapabilityEvidence()).toEqual({ ...before, registered: false });
  socket.ws.close();
  await socket.closed;
});
