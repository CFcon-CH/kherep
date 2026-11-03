import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

// The real node-side protocol client (modules/control-plane/node), driven over
// a real WebSocket against the real NodeSession. Its node:crypto signing runs
// here through the test-only nodejs_compat flag (vitest.config.mts); the
// deployed Worker bundle does not use it.
import { isNodeId, isSessionInfo, type SessionInfo } from "../../protocol.mts";
import { MAX_DIRECTORY_NODES, MESSAGING_CAPABILITY, type MessageDeliverBody } from "../../protocol-messages.mts";
import { NodeClient, type ClientOptions } from "../../node/client.mts";
import { generateIdentity } from "../../node/identity.mts";
import { DEFAULT_POLICY } from "../../node/policy.mts";
import { directoryBody } from "../src/directory.mts";
import { routeEffects } from "../src/message-routing.mts";
import { enroll, FACTS, newKey, registry, session, workerFetch } from "./helpers.mts";

function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectClient(options: Partial<ClientOptions> = {}) {
  const identity = generateIdentity();
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey });
  const client = new NodeClient({
    nodeId, identity, policy: DEFAULT_POLICY,
    handlers: {
      "node.status": async () => ({ nodeId }),
      "runtime.list": async () => [{ name: "ollama", kind: "local-endpoint", endpoint: "http://127.0.0.1:11434" }],
      "session.list": async () => [{ sessionId: "s1", runtime: "claude", state: "running" }],
    },
    facts: () => FACTS, runtimes: async () => [{ name: "codex", kind: "cli" }], sessions: async () => [],
    storeMessage: () => { throw new Error("not enabled"); },
    ...options,
  });
  const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
  const ws = response.webSocket!;
  let chain = Promise.resolve();
  const send = (frames: Promise<string[]>) => { chain = chain.then(async () => { for (const frame of await frames) ws.send(frame); }); };
  ws.addEventListener("message", (event) => send(client.onFrame(event.data as string)));
  ws.accept();
  // Wait for the register frame to reach the Registry rather than for a fixed
  // time: on a slow runner the test can otherwise read the node after auth
  // (status online) but before register (capabilities, runtimes).
  await vi.waitFor(async () => {
    expect(client.authenticated).toBe(true);
    expect((await registry().getNode(nodeId))?.capabilities.length).toBeGreaterThan(0);
  }, { timeout: 5_000, interval: 50 });
  // Mirrors the daemon's periodic snapshot on the same ordered chain.
  return { nodeId, client, ws, snapshot: () => send(client.sessionsSnapshot()) };
}

describe("node client against the Worker", () => {
  it("authenticates, registers and answers a dispatched command", async () => {
    const { nodeId, ws } = await connectClient();
    expect((await registry().getNode(nodeId))).toMatchObject({ status: "online", runtimes: [{ name: "codex", kind: "cli" }] });

    await session(nodeId).enqueue("session.list");
    await session(nodeId).enqueue("runtime.list");
    await settle();
    // RPC typing maps the `unknown` result field to never; the value is plain JSON.
    const commands = await session(nodeId).recentCommands(5) as unknown as { state: string }[];
    expect(commands.map((c) => c.state)).toEqual(["done", "done"]);
    expect(await registry().listSessions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId, sessionId: "s1", runtime: "claude" })]));
    expect((await registry().getNode(nodeId))?.runtimes).toEqual(
      [{ name: "ollama", kind: "local-endpoint", endpoint: "http://127.0.0.1:11434" }]);
    expect((await session(nodeId).status()).pending).toBe(0);
    ws.close(1000, "done");
  });

  it("keeps the last known sessions when the node's listing fails", async () => {
    const known: SessionInfo = { sessionId: "c1", runtime: "claude-code", state: "running", name: "review", cwd: "/work/repo", kind: "interactive" };
    let fail = false;
    const sessions = async () => { if (fail) throw new Error("claude agents failed: timed out"); return [known]; };
    const { nodeId, ws, snapshot } = await connectClient({
      sessions, handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": sessions },
    });
    const mine = async () => (await registry().listSessions()).filter((s) => s.nodeId === nodeId);
    expect(await mine()).toEqual([expect.objectContaining({ ...known, nodeId })]);

    fail = true;
    snapshot();
    await session(nodeId).enqueue("session.list");
    await settle();
    const [result] = await session(nodeId).recentCommands(1) as unknown as { state: string; error: string }[];
    expect(result).toMatchObject({ state: "failed", error: "claude agents failed: timed out" });
    expect(await mine()).toEqual([expect.objectContaining({ ...known, nodeId })]);
    ws.close(1000, "done");
  });

  it("delivers an operator message to a node whose policy accepts it", async () => {
    const stored: MessageDeliverBody[] = [];
    const { nodeId, ws } = await connectClient({
      policy: { ...DEFAULT_POLICY, messaging: { accept: [{ session: "review", from: ["operator"] }] } },
      storeMessage: (body) => { stored.push(body); },
    });
    expect((await registry().getNode(nodeId))?.capabilities).toContain(MESSAGING_CAPABILITY);

    const messageId = crypto.randomUUID();
    const sent = await registry().sendMessage({ messageId, from: { nodeId: "operator", session: "operator@example.com" },
      to: { nodeId, session: "review" }, text: "please review" }, "operator@example.com");
    if (!sent.ok) throw new Error(sent.error);
    await routeEffects(env, sent.effects);
    await settle();

    expect(stored).toEqual([expect.objectContaining({ messageId, toSession: "review", text: "please review" })]);
    const row = await runInDurableObject(registry(), (_i, state) =>
      state.storage.sql.exec("SELECT state, text FROM messages WHERE id = ?", messageId).one());
    expect(row).toEqual({ state: "accepted", text: null });
    ws.close(1000, "done");
  });

  it("carries sender origin through authenticated node send, Worker storage and target NodeClient intake", async () => {
    const stored: MessageDeliverBody[] = [];
    const target = await connectClient({ storeMessage: body => { stored.push(body); } });
    const sender = await connectClient();
    const messageId = crypto.randomUUID();
    const senderSentAt = new Date(Date.now() - 23 * 60 * 60_000).toISOString();
    for (const frame of sender.client.sendMessage({ messageId, fromSession: "synthetic-sender",
      to: { nodeId: target.nodeId, session: "synthetic-target" }, text: "synthetic origin", senderSentAt })) sender.ws.send(frame);
    await vi.waitFor(() => expect(stored).toHaveLength(1));
    expect(stored[0]!.senderOrigin).toEqual({ nodeId: sender.nodeId, sentAt: senderSentAt });
    expect(stored[0]!.createdAt).not.toBe(senderSentAt);
    await vi.waitFor(async () => expect((await registry().listMessages(target.nodeId, 10))[0]?.state).toBe("accepted"));
    sender.ws.close(1000, "done"); target.ws.close(1000, "done");
  });

  // Issue #441: isDirectoryBody as of 0d2c5d7, before node intake, vendored so an
  // older node's reading of the new frame is pinned here. It does not reject unknown keys.
  function isLegacyDirectoryBody(body: unknown): boolean {
    const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const isText = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
    return isObject(body) && Array.isArray(body.nodes) && body.nodes.length <= 256
      && body.nodes.every((n) => isObject(n) && isNodeId(n.nodeId) && isText(n.name, 128) && isText(n.status, 32))
      && Array.isArray(body.sessions) && body.sessions.length <= 1024
      && body.sessions.every((s) => isObject(s) && isNodeId(s.nodeId) && isSessionInfo(s) && s.startedAt === undefined)
      && typeof body.fetchedAt === "string" && !Number.isNaN(Date.parse(body.fetchedAt))
      && (body.truncated === undefined || typeof body.truncated === "boolean")
      && (body.worker === undefined || (isObject(body.worker) && Array.isArray(body.worker.capabilities)
        && body.worker.capabilities.length <= 64 && body.worker.capabilities.every((c) => isText(c, 64))));
  }

  it("emits a directory with intake that an older node still accepts (issue #441)", async () => {
    const sender = await enroll(await newKey(), "legacy-sender");
    const target = await enroll(await newKey(), "legacy-target");
    await registry().updateRegistration(target, FACTS, [], [MESSAGING_CAPABILITY]);
    await registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: sender, session: "s" },
      to: { nodeId: target, session: "t" }, text: "x" }, "test");
    const body = await registry().directory();
    expect(body.nodes.find((n) => n.nodeId === target)?.intake).toMatchObject({ queued: 1 });
    expect(isLegacyDirectoryBody(body)).toBe(true);

    const rows = Array.from({ length: MAX_DIRECTORY_NODES + 1 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, name: "n".repeat(128), status: "online" }));
    const full = { lastAcceptedAt: "2026-10-17T09:57:30.000Z", oldestQueuedAt: "2026-10-17T09:59:50.000Z", queued: 100 };
    const truncated = directoryBody(rows, [], 0, new Map(rows.map((r) => [r.id, full])));
    expect(truncated.truncated).toBe(true);
    expect(truncated.nodes.some((n) => n.intake)).toBe(true);
    expect(isLegacyDirectoryBody(truncated)).toBe(true);
  });
});
