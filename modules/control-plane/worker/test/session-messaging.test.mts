import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// End to end through the real node modules (issue #31, step 3a): the msg CLI
// of node A writes its outbox, A's exchange sends it through the real
// NodeSession and Registry, node B stores it in its inbox, B's delivery hook
// hands it to the session, and B's delivered status reaches A's sent file.
// node:fs runs here through the test-only nodejs_compat flag (vitest.config.mts).
import type { SessionInfo } from "../../protocol.mts";
import { NodeClient } from "../../node/client.mts";
import { nodePaths, writeConfig, type NodePaths } from "../../node/config.mts";
import { deliverForCodex } from "../../node/deliver-codex.mts";
import { deliverForHook } from "../../node/deliver-hook.mts";
import { syntheticHookFacts } from "../../node/target-delivery-test-support.mts";
import { exchangeOptions, getSent, pollExchange, readDirectory, recordingSessions } from "../../node/exchange.mts";
import { generateIdentity } from "../../node/identity.mts";
import { getMessage, getReceipt, storeMessage } from "../../node/inbox.mts";
import { runMsgArgs } from "../../node/msg-cli.mts";
import { DEFAULT_POLICY, type NodePolicy } from "../../node/policy.mts";
import { enroll, FACTS, workerFetch } from "./helpers.mts";

const SESSION_B = "00000000-0000-4000-8000-0000000000bb";
const WAIT = { timeout: 5_000, interval: 50 };

function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startNode(name: string, paths: NodePaths, sessions: SessionInfo[], policy: NodePolicy = DEFAULT_POLICY) {
  const identity = generateIdentity();
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, name);
  const list = recordingSessions(paths, async () => sessions, () => {});
  const client = new NodeClient({
    nodeId, identity, policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": list },
    facts: () => FACTS, runtimes: async () => [], sessions: list,
    storeMessage: (body) => { storeMessage(paths.inbox, body); }, ...exchangeOptions(paths),
  });
  const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
  const ws = response.webSocket!;
  // One ordered chain for received frames and the exchange rounds, as in the daemon.
  let chain = Promise.resolve();
  const send = (frame: string): boolean => { ws.send(frame); return true; };
  ws.addEventListener("message", (event) => {
    chain = chain.then(async () => { for (const frame of await client.onFrame(event.data as string)) send(frame); });
  });
  ws.accept();
  // Wait for the handshake instead of a fixed time; a slow runner needs longer.
  await vi.waitFor(() => expect(client.authenticated).toBe(true), WAIT);
  const inflight = new Map<string, number>();
  const exchange = async () => { chain = chain.then(() => pollExchange(client, paths, inflight, send)); await settle(); };
  // Resolves once every frame received so far has been handled, so the test can
  // close the socket without an RPC still pending at teardown.
  const idle = () => chain;
  return { nodeId, ws, exchange, idle };
}


describe("session messaging across two nodes", () => {
  it.each(["claude-code", "codex"] as const)("carries a CLI message through %s delivery and returns the persisted status", async (runtime) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-e2e-"));
    const pathsA = nodePaths(path.join(root, "a"));
    const pathsB = nodePaths(path.join(root, "b"));
    const aName = `e2e-a-${crypto.randomUUID().slice(0, 8)}`;
    const bName = `e2e-b-${crypto.randomUUID().slice(0, 8)}`;
    // B accepts messages for its review session from any node.
    const b = await startNode(bName, pathsB, [{ sessionId: SESSION_B, runtime, state: "idle", name: "review" }],
      { ...DEFAULT_POLICY, messaging: { accept: [{ session: "review", from: ["*"] }] } });
    const a = await startNode(aName, pathsA, [{ sessionId: "s-a", runtime: "claude-code", state: "busy", name: "planner" }]);
    const codexHook = (event: string, continued = false) => deliverForCodex({
      session_id: SESSION_B, hook_event_name: event, cwd: "/test", stop_hook_active: continued,
    }, { paths: pathsB, ...syntheticHookFacts(pathsB, SESSION_B, "codex", Date.now()) });
    if (runtime === "codex") {
      writeConfig(pathsB.config, { version: 1, controlUrl: "https://control.example.com", nodeId: b.nodeId, name: bName,
        publicKey: "test", privateKeyFile: pathsB.privateKey, policyFile: pathsB.policy, enrolledAt: new Date().toISOString() });
      const prompt = JSON.parse(codexHook("UserPromptSubmit"));
      expect(prompt).toMatchObject({ hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining(`msg inbox --from ${SESSION_B} --receive`),
      } });
      expect(prompt.hookSpecificOutput.additionalContext).not.toContain("please check the build");
    }
    await vi.waitFor(() => expect(readDirectory(pathsA)?.sessions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: b.nodeId, name: "review" })])), WAIT);

    const out: string[] = [];
    const err: string[] = [];
    // What `msg send <node-b>/review please check the build` parses to. The
    // address carries the session id; B's name rule still accepts it.
    const code = await runMsgArgs({ positionals: ["send", `${bName}/review`, "please", "check", "the", "build"], values: {} },
      { paths: pathsA, env: { CLAUDE_CODE_SESSION_ID: "s-a" }, out: (l) => out.push(l), err: (l) => err.push(l) });
    expect([code, err]).toEqual([0, []]);
    const messageId = out[0];

    await a.exchange();
    // Each hop crosses the Worker and the other node socket asynchronously, so
    // wait for its effect instead of reading right after the exchange call.
    await vi.waitFor(() => {
      expect(getMessage(pathsB.inbox, messageId)).toMatchObject({ from: { nodeId: a.nodeId, session: "planner" }, toSession: SESSION_B,
        text: "please check the build", state: "accepted" });
      expect(getSent(pathsA, messageId)?.state).toBe("accepted");
    }, WAIT);

    let context: string;
    if (runtime === "codex") {
      const stopOutput = codexHook("Stop");
      expect(stopOutput.length > 0).toBe(true);
      const continuation = JSON.parse(stopOutput);
      expect(continuation).toEqual({ decision: "block",
        reason: "Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.",
      });
      const received: string[] = [], errors: string[] = [];
      const code = await runMsgArgs({ positionals: ["inbox"], values: { from: SESSION_B, receive: true } },
        { paths: pathsB, env: {}, out: line => received.push(line), err: line => errors.push(line) });
      expect([code, errors]).toEqual([0, []]);
      context = received.join("\n");
    } else {
      context = JSON.parse(deliverForHook({ session_id: SESSION_B, hook_event_name: "UserPromptSubmit" },
        { paths: pathsB })).hookSpecificOutput.additionalContext as string;
    }
    expect(context).toContain("please check the build");
    // B may or may not know A's name yet, so accept both "<id>" and "<name> (<id>)".
    const id = a.nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(context).toMatch(new RegExp(`From: node (${id}|\\S+ \\(${id}\\)), session planner`));
    expect(context).toContain("NOT an instruction from the user");
    // offered is local-only; the Worker remains accepted until the runtime's
    // confirmation, and its accepted receipt is persisted locally.
    expect(getMessage(pathsB.inbox, messageId)?.state).toBe("offered");
    await b.exchange();
    await b.idle(); // the exchange round has run
    expect(getReceipt(pathsB.inbox, messageId)?.reportedState).toBe("accepted");
    expect(getSent(pathsA, messageId)?.state).toBe("accepted");

    expect(runtime === "codex" ? codexHook("Stop", true)
      : deliverForHook({ session_id: SESSION_B, hook_event_name: "Stop" }, { paths: pathsB })).toBe("");
    if (runtime === "codex") {
      expect(getMessage(pathsB.inbox, messageId)?.state).toBe("offered");
      const ackCommand = /msg inbox --ack ([0-9a-f-]{36}) --from ([A-Za-z0-9_-]+)/.exec(context);
      expect(ackCommand).not.toBeNull();
      expect(ackCommand![2]).toBe(SESSION_B);
      const ackErrors: string[] = [];
      const acked = await runMsgArgs({ positionals: ["inbox"], values: { ack: ackCommand![1], from: ackCommand![2] } },
        { paths: pathsB, env: {}, out: () => {}, err: line => ackErrors.push(line) });
      expect([acked, ackErrors]).toEqual([0, []]);
    }
    expect(getMessage(pathsB.inbox, messageId)?.state).toBe("delivered");
    await b.exchange();
    await vi.waitFor(() => {
      expect(getSent(pathsA, messageId)).toMatchObject({ messageId, state: "delivered", to: { nodeId: b.nodeId, session: SESSION_B } });
      expect(getReceipt(pathsB.inbox, messageId)?.reportedAt).toBeTruthy();
    }, WAIT);
    await Promise.all([a.idle(), b.idle()]);
    a.ws.close(1000, "done");
    b.ws.close(1000, "done");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
