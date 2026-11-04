import { describe, expect, vi, it } from "vitest";
import { SessionNodeCase, type SessionSocket } from "./session-node-client.mts";
import { SESSION_B, type Role } from "./session-node-protocol.mts";
import { enroll, workerFetch } from "./helpers.mts";
import type { getMessage as messageType, getReceipt as receiptType } from "../../node/inbox.mts";
import type { getSent as sentType, readDirectory as directoryType } from "../../node/exchange.mts";

// Real workerd owns the backend and sockets; a genuine host-owned Node child
// runs the production NodeClient, CLI, hooks and filesystem through fixed commands.
const WAIT = { timeout: 5_000, interval: 50 };

async function startNode(name: string, harness: SessionNodeCase, role: Role) {
  const identity = await harness.identity(role);
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, name);
  await harness.attach(role, nodeId, name);
  const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
  if (!response.webSocket) throw Error("real Worker upgrade returned no socket");
  const socket: SessionSocket = harness.connect(role, response.webSocket);
  await vi.waitFor(async () => expect(await harness.state<boolean>(role, "authenticated")).toBe(true), WAIT);
  return { nodeId, exchange: () => socket.exchange(), idle: () => socket.idle() };
}

describe("session messaging across two nodes", () => {
  it.each(["claude-code", "codex"] as const)("carries a CLI message through %s delivery and returns the persisted status", async (runtime) => {
    const harness = await SessionNodeCase.create(runtime);
    let primary: unknown;
    try {
      const getMessage = (id: string) => harness.state<ReturnType<typeof messageType>>("b", "message", id);
      const getSent = (id: string) => harness.state<ReturnType<typeof sentType>>("a", "sent", id);
      const getReceipt = (id: string) => harness.state<ReturnType<typeof receiptType>>("b", "receipt", id);
      const readDirectory = () => harness.state<ReturnType<typeof directoryType>>("a", "directory");
      const aName = `e2e-a-${crypto.randomUUID().slice(0, 8)}`;
      const bName = `e2e-b-${crypto.randomUUID().slice(0, 8)}`;
      const b = await startNode(bName, harness, "b");
      const a = await startNode(aName, harness, "a");
      const codexHook = (event: "UserPromptSubmit" | "Stop", continued = false) => harness.hook(event, continued);
      if (runtime === "codex") {
        const prompt = JSON.parse(await codexHook("UserPromptSubmit"));
        expect(prompt).toMatchObject({ hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: expect.stringContaining(`msg inbox --from ${SESSION_B} --receive`),
        } });
        expect(prompt.hookSpecificOutput.additionalContext).not.toContain("please check the build");
      }
      await vi.waitFor(async () => expect((await readDirectory())?.sessions)
        .toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: b.nodeId, name: "review" })])), WAIT);

      const sent = await harness.cli({ op: "cli", action: "send", target: bName });
      const { code, out, err } = sent;
      expect([code, err]).toEqual([0, []]);
      const messageId = out[0];

      await a.exchange();
      // Each hop crosses the Worker and the other node socket asynchronously, so
      // wait for its effect instead of reading right after the exchange call.
      await vi.waitFor(async () => {
        expect((await getMessage(messageId))).toMatchObject({ from: { nodeId: a.nodeId, session: "planner" }, toSession: SESSION_B,
          text: "please check the build", state: "accepted" });
        expect((await getSent(messageId))?.state).toBe("accepted");
      }, WAIT);

      let context: string;
      if (runtime === "codex") {
        const stopOutput = await codexHook("Stop");
        expect(stopOutput.length > 0).toBe(true);
        const continuation = JSON.parse(stopOutput);
        expect(continuation).toEqual({ decision: "block",
          reason: "Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.",
        });
        const receive = await harness.cli({ op: "cli", action: "receive" });
        const { code, out: received, err: errors } = receive;
        expect([code, errors]).toEqual([0, []]);
        context = received.join("\n");
      } else {
        context = JSON.parse(await harness.hook("UserPromptSubmit")).hookSpecificOutput.additionalContext as string;
      }
      expect(context).toContain("please check the build");
      // B may or may not know A's name yet, so accept both "<id>" and "<name> (<id>)".
      const id = a.nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(context).toMatch(new RegExp(`From: node (${id}|\\S+ \\(${id}\\)), session planner`));
      expect(context).toContain("NOT an instruction from the user");
      // offered is local-only; the Worker remains accepted until the runtime's
      // confirmation, and its accepted receipt is persisted locally.
      expect((await getMessage(messageId))?.state).toBe("offered");
      await b.exchange();
      await b.idle(); // the exchange round has run
      expect((await getReceipt(messageId))?.reportedState).toBe("accepted");
      expect((await getSent(messageId))?.state).toBe("accepted");

      expect(runtime === "codex" ? await codexHook("Stop", true)
        : await harness.hook("Stop")).toBe("");
      if (runtime === "codex") {
        expect((await getMessage(messageId))?.state).toBe("offered");
        const ackCommand = /msg inbox --ack ([0-9a-f-]{36}) --from ([A-Za-z0-9_-]+)/.exec(context);
        expect(ackCommand).not.toBeNull();
        expect(ackCommand![2]).toBe(SESSION_B);
        const ack = await harness.cli({ op: "cli", action: "ack", token: ackCommand![1], owner: ackCommand![2] });
        const { code: acked, err: ackErrors } = ack;
        expect([acked, ackErrors]).toEqual([0, []]);
      }
      expect((await getMessage(messageId))?.state).toBe("delivered");
      await b.exchange();
      await vi.waitFor(async () => {
        expect((await getSent(messageId))).toMatchObject({ messageId, state: "delivered", to: { nodeId: b.nodeId, session: SESSION_B } });
        expect((await getReceipt(messageId))?.reportedAt).toBeTruthy();
      }, WAIT);
      await Promise.all([a.idle(), b.idle()]);
    } catch (error) { primary = error; throw error; }
    finally {
      try { await harness.close(); }
      catch (cleanup) { if (primary) throw new AggregateError([primary, cleanup], "case and cleanup failed", { cause: primary }); throw cleanup; }
    }
  });
});
