import { describe, expect, it } from "vitest";

import { digestMcpArguments, REMOTE_MCP_CAPABILITY, type McpAssignmentNative, type McpIntentClaim } from "../../protocol-mcp.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

// Issue #965: McpRegistry refusals through the Registry RPC: a credential of
// a node that lost remote MCP, intent registration before provisioning or on
// a non-Mac node, and a Lead self-assignment from a runtime that is not Codex.
const SESSION = "77777777-7777-4777-8777-777777777777";

async function mcpNode(os = "linux", provision = true): Promise<{ nodeId: string; token?: string; version?: number }> {
  const nodeId = await enroll(await newKey(), `mcp-${crypto.randomUUID()}`);
  await registry().updateRegistration(nodeId, { ...FACTS, os }, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
  await registry().replaceSessions(nodeId, [{ sessionId: SESSION, runtime: "codex", state: "running" }]);
  if (!provision) return { nodeId };
  const credential = await registry().rotateMcpCredential(nodeId);
  if (!credential.ok) throw new Error(credential.error);
  return { nodeId, token: credential.token, version: credential.version };
}

describe("McpRegistry refusals", () => {
  it("stops authenticating a credential once the node no longer advertises remote MCP", async () => {
    const { nodeId, token, version } = await mcpNode();
    expect(await registry().authenticateMcpCredential(token!)).toEqual({ nodeId, version });
    await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], []);
    expect(await registry().authenticateMcpCredential(token!)).toBeNull();
  });

  it("refuses an intent before a credential is provisioned", async () => {
    const { nodeId } = await mcpNode("linux", false);
    expect(await registry().registerMcpIntent(nodeId, { requestId: crypto.randomUUID(), runtime: "codex", sessionId: SESSION,
      threadId: SESSION, callId: "call-1", tool: "sessions", argumentsDigest: await digestMcpArguments({}) }))
      .toEqual({ ok: false, error: "remote MCP credential is not provisioned" });
  });

  it("refuses a self-assignment intent from a node that is not an eligible Mac", async () => {
    const { nodeId } = await mcpNode("linux");
    expect(await registry().registerMcpIntent(nodeId, { requestId: crypto.randomUUID(), runtime: "codex", sessionId: SESSION,
      threadId: SESSION, callId: "call-1", tool: "assign_self", argumentsDigest: await digestMcpArguments({ slot: "codex-mac" }),
      assignment: { slot: "codex-mac", turnId: "turn-1", native: { sessionId: SESSION, chatName: "Synthetic original",
        platform: "darwin", originalMain: true } as McpAssignmentNative } }))
      .toEqual({ ok: false, error: "Codex Mac assignment requires an eligible enrolled Mac node" });
  });

  it("refuses a Lead self-assignment claimed for a runtime other than Codex", async () => {
    const { nodeId, version } = await mcpNode("darwin");
    const intent: McpIntentClaim = { nodeId, credentialVersion: version!, requestId: crypto.randomUUID(), callId: "call-1",
      tool: "assign_self", argumentsDigest: await digestMcpArguments({ slot: "kherep-lead" }), runtime: "claude-code" };
    const refused = await registry().assignMcpSlot(intent, "kherep-lead");
    expect(refused.ok).toBe(false);
    expect((await registry().listIntercomSlots()).find((row) => row.slot === "kherep-lead")?.occupant).toBeNull();
  });
});
