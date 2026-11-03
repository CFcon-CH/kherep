import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import worker from "../src/index.mts";
import { buildCommit } from "../src/health.mts";
import rootPackage from "../../../../package.json" with { type: "json" };
import { makeEnvelope } from "../../protocol.mts";
import { authenticate, BASE, enroll, FACTS, newKey, nextMessageStatus, registry, workerFetch } from "./helpers.mts";

const TEAM = "https://team.example.com";
const AUD = "test-audience";
let signingKey: JoseKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
  // Stand-in for <team domain>/cdn-cgi/access/certs; nothing leaves the test.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
    return new Response("unexpected fetch", { status: 599 });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function token(claims: { iss?: string; aud?: string; email?: string } = {}): Promise<string> {
  return new SignJWT({ email: claims.email ?? "operator@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function api(path: string, init: RequestInit = {}, jwt?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jwt) headers.set("cf-access-jwt-assertion", jwt);
  return workerFetch(path, { ...init, headers });
}

describe("health", () => {
  it("answers without authentication", async () => {
    expect((await workerFetch("/health")).status).toBe(200);
  });

  // Issue #215: the build it runs and whether remote MCP is on, nothing else.
  it("reports the bundled product version and the remote MCP switch", async () => {
    const body = await (await workerFetch("/health")).json();
    expect(body).toEqual({ ok: true, service: "kherep-control", version: rootPackage.version, commit: null, remoteMcp: false });
    const enabled = await worker.fetch(new Request(`${BASE}/health`), { ...env, REMOTE_MCP_ENABLED: "true" });
    expect(await enabled.json()).toMatchObject({ ok: true, remoteMcp: true });
  });

  it("reports a source commit only when one was defined in a valid form", () => {
    expect(buildCommit("0123abc")).toBe("0123abc");
    expect(buildCommit(undefined)).toBeNull();
    expect(buildCommit("not a commit")).toBeNull();
  });
});

describe("Access JWT on /api/*", () => {
  it("rejects a request without the Access header", async () => {
    expect((await api("/api/nodes")).status).toBe(403);
  });

  it("rejects a malformed token", async () => {
    expect((await api("/api/nodes", {}, "not.a.jwt")).status).toBe(403);
  });

  it("rejects a token for another audience or issuer", async () => {
    expect((await api("/api/nodes", {}, await token({ aud: "other" }))).status).toBe(403);
    expect((await api("/api/nodes", {}, await token({ iss: "https://other.example.com" }))).status).toBe(403);
  });

  it("fails closed when the Access configuration is missing", async () => {
    const request = new Request(`${BASE}/api/nodes`, { headers: { "cf-access-jwt-assertion": await token() } });
    expect((await worker.fetch(request, { ...env, ACCESS_AUD: "" })).status).toBe(503);
    expect((await worker.fetch(request.clone(), { ...env, ACCESS_TEAM_DOMAIN: "" })).status).toBe(503);
  });

  it("accepts a valid token", async () => {
    const response = await api("/api/nodes", {}, await token());
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("nodes");
  });

  it("does not require Access on the node endpoints", async () => {
    expect((await workerFetch("/node/enroll", { method: "POST", body: "{}" })).status).toBe(400);
  });
});

describe("operator API", () => {
  it("S28: operator message fields cannot inject binding or loop authority", async () => {
    const jwt = await token(), nodeId = await enroll(await newKey(), "synthetic-injection-target");
    await registry().updateRegistration(nodeId, FACTS, [], ["messaging.v1"]);
    const post = (body: unknown) => api(`/api/nodes/${nodeId}/messages`, { method: "POST", body: JSON.stringify(body) }, jwt);
    const counts = () => runInDurableObject(registry(), (_i, state) => ({
      messages: state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n,
      pairs: state.storage.sql.exec("SELECT COUNT(*) AS n FROM message_loop_pairs").one().n,
    }));
    const before = await counts();
    for (const field of ["binding", "denyPairKey", "delivery_binding", "delivery_pair", "loop", "loop_identity"]) {
      expect((await post({ session: "synthetic-target", text: "Synthetic operator body", [field]: "injected" })).status).toBe(400);
      expect(await counts()).toEqual(before);
    }
    expect((await post({ session: "synthetic-target", text: "Synthetic operator body" })).status).toBe(202);
    expect(await counts()).toEqual({ messages: Number(before.messages) + 1, pairs: before.pairs });
  });
  it("creates enrollment codes and lists enrolled nodes", async () => {
    const jwt = await token();
    const created = await api("/api/enrollments", { method: "POST", body: JSON.stringify({ ttlSeconds: 120 }) }, jwt);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ code: expect.any(String), expiresAt: expect.any(Number) });
    const nodeId = await enroll(await newKey(), "listed-node");
    const detail = await api(`/api/nodes/${nodeId}`, {}, jwt);
    expect(await detail.json()).toMatchObject({ node: { id: nodeId, name: "listed-node" }, commands: [] });
    expect((await api("/api/sessions", {}, jwt)).status).toBe(200);
  });

  it("only dispatches the three Phase 1 commands", async () => {
    const jwt = await token();
    const nodeId = await enroll(await newKey());
    const post = (command: string) => api(`/api/nodes/${nodeId}/commands`, { method: "POST", body: JSON.stringify({ command }) }, jwt);
    for (const command of ["node.status", "runtime.list", "session.list"]) expect((await post(command)).status).toBe(202);
    for (const command of ["session.start", "shell.exec", "", "NODE.STATUS"]) {
      const refused = await post(command);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "command not allowed" });
    }
  });

  it("sends an operator message and lists message metadata without text", async () => {
    const jwt = await token();
    const nodeId = await enroll(await newKey(), "inbox-node");
    await registry().updateRegistration(nodeId, FACTS, [], ["messaging.v1"]);
    const post = (body: unknown) => api(`/api/nodes/${nodeId}/messages`, { method: "POST", body: JSON.stringify(body) }, jwt);
    const sent = await post({ session: "build", text: "operator secret" });
    expect(sent.status).toBe(202);
    const { messageId, state } = await sent.json() as { messageId: string; state: string };
    expect(state).toBe("queued");
    for (const bad of [{ session: "", text: "x" }, { session: "s", text: "" }, { session: "s", text: "x", inReplyTo: "nope" }]) {
      expect((await post(bad)).status).toBe(400);
    }

    const listed = await api(`/api/messages?node=${nodeId}&limit=10`, {}, jwt);
    expect(listed.status).toBe(200);
    const raw = await listed.text();
    expect(raw).not.toContain("operator secret");
    const { messages } = JSON.parse(raw) as { messages: Record<string, unknown>[] };
    expect(messages).toEqual([expect.objectContaining({
      messageId, fromNode: "operator", fromSession: "operator@example.com", toNode: nodeId, toSession: "build", state: "queued" })]);
    expect(messages[0]).not.toHaveProperty("text");
    expect((await api("/api/messages?limit=0", {}, jwt)).status).toBe(400);
    expect((await api("/api/messages?node=bad", {}, jwt)).status).toBe(400);

    const audit = await runInDurableObject(registry(), (_i, state) =>
      state.storage.sql.exec("SELECT actor, action, detail FROM audit WHERE detail LIKE ?", `%${messageId}%`).toArray());
    expect(audit).toEqual([expect.objectContaining({ actor: "operator@example.com", action: "message.send" })]);
    expect(String(audit[0].detail)).not.toContain("operator secret");
  });

  it("refuses operator messages to unknown or revoked nodes like the commands endpoint", async () => {
    const jwt = await token();
    const post = (id: string) => api(`/api/nodes/${id}/messages`, { method: "POST", body: JSON.stringify({ session: "s", text: "x" }) }, jwt);
    const unknown = await post(crypto.randomUUID());
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown node" });
    const nodeId = await enroll(await newKey());
    expect((await api(`/api/nodes/${nodeId}`, { method: "DELETE" }, jwt)).status).toBe(200);
    const revoked = await post(nodeId);
    expect(revoked.status).toBe(409);
    expect(await revoked.json()).toEqual({ error: "node revoked" });
  });

  it("refuses the queued messages of a revoked node and tells their senders", async () => {
    const jwt = await token();
    const senderKey = await newKey();
    const senderId = await enroll(senderKey, "sender");
    const targetId = await enroll(await newKey(), "target");
    await registry().updateRegistration(targetId, FACTS, [], ["messaging.v1"]);
    const sender = await authenticate(senderId, senderKey);
    const messageId = crypto.randomUUID();
    sender.send(makeEnvelope("message.send", { messageId, fromSession: "s-a", to: { nodeId: targetId, session: "s-b" }, text: "queued secret" }, 0, 0));
    expect(await nextMessageStatus(sender, { messageId, state: "queued" })).toEqual({ messageId, state: "queued" });

    expect((await api(`/api/nodes/${targetId}`, { method: "DELETE" }, jwt)).status).toBe(200);
    expect(await nextMessageStatus(sender, { messageId, state: "refused", reason: "target node revoked" }))
      .toEqual({ messageId, state: "refused", reason: "target node revoked" });
    const row = await runInDurableObject(registry(), (_i, state) =>
      state.storage.sql.exec("SELECT state, text FROM messages WHERE id = ?", messageId).one());
    expect(row).toEqual({ state: "refused", text: null });
    const audit = await runInDurableObject(registry(), (_i, state) => state.storage.sql
      .exec("SELECT actor, detail FROM audit WHERE action = 'message.state' AND detail LIKE ?", `%${messageId}%`).toArray());
    expect(audit).toEqual([expect.objectContaining({ actor: "operator@example.com" })]);
    expect(String(audit[0].detail)).not.toContain("queued secret");
    sender.ws.close(1000, "done");
  });

  it("revokes a node and refuses further commands", async () => {
    const jwt = await token();
    const nodeId = await enroll(await newKey());
    expect((await api(`/api/nodes/${nodeId}`, { method: "DELETE" }, jwt)).status).toBe(200);
    expect((await api(`/api/nodes/${nodeId}`, { method: "DELETE" }, jwt)).status).toBe(404);
    const refused = await api(`/api/nodes/${nodeId}/commands`, { method: "POST", body: JSON.stringify({ command: "node.status" }) }, jwt);
    expect(refused.status).toBe(409);
  });
});
