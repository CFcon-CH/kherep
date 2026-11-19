import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { REMOTE_MCP_CAPABILITY } from "../../protocol-mcp.mts";
import type { Env } from "../src/env.mts";
import { handleMcp } from "../src/mcp-http.mts";
import { BASE, enroll, FACTS, newKey, registry, workerFetch } from "./helpers.mts";

// Issue #965: refusals on the node-facing routes: enrollment input, MCP bearer
// shape, and an MCP reply without native call metadata.
const enabledEnv = { ...env, REMOTE_MCP_ENABLED: "true" } as Env;

describe("enrollment refusals", () => {
  const enrollWith = (body: unknown, method = "POST") => workerFetch("/node/enroll", { method,
    headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });

  it("refuses a wrong method, an unreadable body and each invalid field", async () => {
    const key = await newKey();
    const valid = { code: "C".repeat(22), publicKey: key.publicKey, name: "node-a", facts: FACTS, runtimes: [] };
    expect((await enrollWith(undefined, "GET")).status).toBe(405);
    const cases: [unknown, string][] = [
      ["not json", "invalid body"],
      [{ ...valid, code: "short" }, "invalid code"],
      [{ ...valid, name: "has space" }, "invalid name"],
      [{ ...valid, facts: { hostname: "x" } }, "invalid facts"],
      [{ ...valid, runtimes: "codex" }, "invalid runtimes"],
    ];
    for (const [body, error] of cases) {
      const response = await enrollWith(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error });
    }
  });

  it("accepts an enrollment that omits the runtime list", async () => {
    const key = await newKey(), { code } = await registry().createEnrollment("test");
    const response = await enrollWith({ code, publicKey: key.publicKey, name: "node-no-runtimes", facts: FACTS });
    expect(response.status).toBe(201);
    const { nodeId } = await response.json() as { nodeId: string };
    expect((await registry().getNode(nodeId))?.runtimes).toEqual([]);
  });
});

describe("MCP route refusals", () => {
  it("refuses a bearer token outside the accepted length", async () => {
    for (const token of ["x".repeat(31), "x".repeat(257)]) {
      const response = await handleMcp(new Request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}` } }), enabledEnv);
      expect(response.status).toBe(401);
    }
  });

  it("refuses an MCP reply without verified native call metadata", async () => {
    const nodeId = await enroll(await newKey(), "mcp-reply-source");
    await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
    const credential = await registry().rotateMcpCredential(nodeId);
    if (!credential.ok) throw new Error(credential.error);
    const client = new Client({ name: "synthetic-reply", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      authProvider: { token: async () => credential.token },
      fetch: (input, init) => handleMcp(new Request(input, init), enabledEnv),
    }));
    try {
      const result = await client.callTool({ name: "reply", arguments: { requestId: crypto.randomUUID(), inReplyTo: crypto.randomUUID(), text: "synthetic" } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ ok: false, error: "verified native call metadata is required" });
    } finally {
      await client.close();
    }
  });
});
