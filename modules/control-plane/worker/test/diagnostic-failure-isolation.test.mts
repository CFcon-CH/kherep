import { expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { attestedPair, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";
import { MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY, digestMcpArguments } from "../../protocol-mcp.mts";
import type { Env } from "../src/env.mts";
import type { LoopSigner } from "../src/message-loop-signals.mts";
it("throwing observational sender push preserves null blocked egress and later delivery candidates", async () => {
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), first = await f.send(), second = await f.send();
  if (!first.ok || !second.ok) throw new Error("synthetic admission failed");
  await runInDurableObject(registry(), async (instance, s) => {
    s.storage.sql.exec("UPDATE messages SET delivery_binding=NULL,delivery_pair=NULL WHERE id=?", first.status.messageId);
    const internal = instance as unknown as { env: Env }, original = internal.env;
    let pushes = 0;
    const namespace = original.NODE_SESSION;
    internal.env = { ...original, NODE_SESSION: {
      idFromName: namespace.idFromName.bind(namespace), get: (id: DurableObjectId) => {
        const stub = namespace.get(id);
        return { resolveMessageReferencesDetailed: (request: import("../../protocol-message-binding.mts").ResolveRequest) => stub.resolveMessageReferencesDetailed(request), pushFrame: async () => { pushes++; throw new Error("synthetic sender push failure"); } };
      },
    } as unknown as Env["NODE_SESSION"] };
    try {
      expect(await instance.prepareMessageDelivery(first.status.messageId)).toBeNull();
      expect(await instance.prepareMessageDelivery(second.status.messageId)).toMatchObject({ messageId: second.status.messageId });
      expect(pushes).toBe(1);
    } finally { internal.env = original; }
  });
});
for (const tool of ["send", "reply"] as const) for (const signerFailure of [false, true]) it(`MCP ${tool} changed claimant reports owner only when identity refusal takes precedence, signerFailure=${signerFailure}`, async () => {
  const nodeId = await enroll(await newKey());
  await registry().updateRegistration(nodeId, FACTS, [{ name: "claude", kind: "cli" }], ["messaging.v1", CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY]);
  await registry().replaceSessions(nodeId, [ID_A, ID_B].map(sessionId => ({ sessionId, runtime: "claude-code", state: "running" })));
  const credential = await registry().rotateMcpCredential(nodeId); if (!credential.ok) throw new Error(credential.error);
  const id = crypto.randomUUID(), text = "synthetic error precedence", parent = crypto.randomUUID();
  if (tool === "reply") {
    await registry().sendMessage({ messageId: parent, from: { nodeId, session: ID_B }, to: { nodeId, session: ID_A }, text: "synthetic parent" }, "test");
    await registry().reportMessageStatus(nodeId, { messageId: parent, state: "delivered" });
  }
  const args = tool === "send" ? { to: { nodeId, session: ID_B }, text } : { inReplyTo: parent, text }, digest = await digestMcpArguments(args);
  expect((await registry().registerMcpIntent(nodeId, { requestId: id, runtime: "claude-code", sessionId: ID_A, callId: "synthetic-call", tool, argumentsDigest: digest })).ok).toBe(true);
  await runInDurableObject(registry(), async (instance, s) => {
    const internal = instance as unknown as { loopSigner: Promise<LoopSigner> }, original = internal.loopSigner;
    internal.loopSigner = Promise.resolve(async (domain, value) => {
      s.storage.sql.exec("UPDATE mcp_intents SET session_id=? WHERE request_id=?", ID_B, id);
      if (signerFailure) throw new Error("synthetic signer unavailable");
      return (await original)(domain, value);
    });
    const claim = { nodeId, credentialVersion: credential.version, requestId: id, runtime: "claude-code" as const, callId: "synthetic-call", tool, argumentsDigest: digest };
    try {
      const result = tool === "send" ? await instance.sendMcpMessage(claim, { nodeId, session: ID_B }, text) : await instance.replyMcpMessage(claim, parent, text);
      if (signerFailure) expect(result).toEqual({ ok: false, error: "loop-crypto-unavailable" });
      else expect(result).toMatchObject({ ok: false, error: "loop-context-changed", diagnostic: { kind: "identity-change", stage: "mcp-claim", dimensions: ["owner"] } });
      expect(s.storage.sql.exec("SELECT claimed_at,outcome FROM mcp_intents WHERE request_id=?", id).one()).toEqual({ claimed_at: null, outcome: null });
    } finally { internal.loopSigner = original; }
  });
});
it("diagnostic-only observation neither reads nor rearms the existing expiry alarm", async () => {
  const { vi } = await import("vitest");
  const { blockerDiagnostic } = await import("../../protocol-diagnostics.mts");
  const f = await attestedPair([...BRAKE_CAPS, MESSAGING_DIAGNOSTICS_CAPABILITY]), sent = await f.send();
  if (!sent.ok) throw new Error(sent.error);
  await runInDurableObject(registry(), async (instance, s) => {
    const get = vi.spyOn(s.storage, "getAlarm"), set = vi.spyOn(s.storage, "setAlarm"), remove = vi.spyOn(s.storage, "deleteAlarm");
    try {
      await instance.observeMessageDiagnostic(sent.status.messageId, f.nodeId, blockerDiagnostic("acceptance-unconfirmed", Date.now(), "upstream-egress"));
      expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    } finally { get.mockRestore(); set.mockRestore(); remove.mockRestore(); }
  });
});
