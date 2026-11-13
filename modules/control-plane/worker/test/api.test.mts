import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { INTERCOM_SLOTS, replaceIntercomSlot } from "../src/intercom-slots.mts";
import { initializeRegistrySchema } from "../src/registry-schema.mts";
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

  // Issue #761: only the Worker writes as operator/control-plane.
  it("refuses the reserved control-plane actor before any message is written", async () => {
    const jwt = await token({ email: "control-plane" }), nodeId = await enroll(await newKey(), "synthetic-reserved-target");
    await registry().updateRegistration(nodeId, FACTS, [], ["messaging.v1"]);
    const count = () => runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n);
    const before = await count();
    const response = await api(`/api/nodes/${nodeId}/messages`, { method: "POST", body: JSON.stringify({ session: "s", text: "x" }) }, jwt);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "reserved actor" });
    expect(await count()).toBe(before);
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


describe("operator Intercom roster", () => {
  const path = "/api/intercom/slots";
  it("requires Access before reading storage and exposes no anonymous health roster", async () => {
    expect((await api(path)).status).toBe(403);
    expect((await api(path, {}, "not.a.jwt")).status).toBe(403);
    expect((await api(path, {}, await token({ aud: "other" }))).status).toBe(403);
    const request = new Request(`${BASE}${path}`, { headers: { "cf-access-jwt-assertion": await token() } });
    expect((await worker.fetch(request, { ...env, ACCESS_AUD: "" })).status).toBe(503);
    expect(await (await workerFetch("/health")).json()).not.toHaveProperty("slots");
    expect((await workerFetch("/health/intercom/slots")).status).toBe(404);
  });

  it("returns only the authoritative tuple and revisions without caching or public writes", async () => {
    const jwt = await token();
    const occupant = { nodeId: "11111111-1111-4111-8111-111111111111", runtime: "codex" as const,
      sessionId: "22222222-2222-4222-8222-222222222222", chatName: "  Synthetic roster chat  " };
    const empty = INTERCOM_SLOTS.map(slot => ({ slot, revision: 0, occupant: null }));
    expect(await (await api(path, {}, jwt)).json()).toEqual({ slots: empty });
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO nodes (id, name, public_key, os, enrolled_at) VALUES (?, ?, ?, ?, 1)",
        occupant.nodeId, "Synthetic roster enrollment", "synthetic-bound-key", "darwin");
      replaceIntercomSlot(sql, "kherep-lead", 0, occupant);
      sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600)
        INSERT INTO sessions (node_id, session_id, runtime, state, updated_at, name, cwd, kind, title)
        SELECT 'synthetic-api-history', 'historic-' || i, 'codex', 'unknown', 1, 'Synthetic unrelated chat', '/synthetic/private', 'subagent', 'Synthetic unrelated title' FROM n`);
      expect(sql.exec("SELECT 1 FROM sessions WHERE session_id=?", occupant.sessionId).toArray()).toEqual([]);
    });
    try {
      const expected = { slots: [{ slot: "kherep-lead", revision: 1, occupant }, ...empty.slice(1)] };
      const response = await api(path, {}, jwt);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(expected);
      for (const method of ["POST", "PUT", "DELETE"]) {
        expect((await api(path, { method, body: JSON.stringify({ slot: "kherep-lead", occupant: null }) }, jwt)).status).toBe(404);
      }
      expect(await (await api(path, {}, jwt)).json()).toEqual(expected);
      expect((await api(`${path}/`, {}, jwt)).status).toBe(404);
    } finally {
      await runInDurableObject(registry(), (_instance, state) => {
        state.storage.sql.exec("UPDATE intercom_slots SET node_id=NULL,runtime=NULL,session_id=NULL,chat_name=NULL,revision=0");
        state.storage.sql.exec("DELETE FROM sessions WHERE node_id='synthetic-api-history'");
        state.storage.sql.exec("DELETE FROM nodes WHERE id=?", occupant.nodeId);
      });
    }
  });

  it.each(["missing-row", "missing-table"])("returns generic 503 for %s without storage detail", async fault => {
    const jwt = await token();
    await runInDurableObject(registry(), (_instance, state) => {
      if (fault === "missing-row") state.storage.sql.exec("DELETE FROM intercom_slots WHERE slot='kherep-lead'");
      else state.storage.sql.exec("ALTER TABLE intercom_slots RENAME TO hidden_intercom_slots");
    });
    try {
      // Auth refusal precedes even an unavailable roster read.
      expect((await api(path)).status).toBe(403);
      const response = await api(path, {}, jwt);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Intercom roster unavailable" });
    } finally {
      await runInDurableObject(registry(), (_instance, state) => {
        if (fault === "missing-table") state.storage.sql.exec("ALTER TABLE hidden_intercom_slots RENAME TO intercom_slots");
        else state.storage.sql.exec("INSERT INTO intercom_slots (slot) VALUES ('kherep-lead')");
      });
    }
  });
});


describe("Intercom roster across real Registry eviction", () => {
  const path = "/api/intercom/slots";
  const occupant = { nodeId: "11111111-1111-4111-8111-111111111111", runtime: "codex" as const,
    sessionId: "22222222-2222-4222-8222-222222222222", chatName: "Synthetic persisted lead" };
  const sentinel = { ...occupant, sessionId: "33333333-3333-4333-8333-333333333333", chatName: "Synthetic sentinel" };

  it.each(["one-row", "all-rows", "intact", "absent-table"])("preserves durable roster integrity after %s eviction", async fault => {
    const stub = registry(), jwt = await token(), instances = new WeakSet<object>();
    await runInDurableObject(stub, (instance, state) => {
      instances.add(instance);
      state.storage.sql.exec("INSERT INTO nodes (id, name, public_key, os, enrolled_at) VALUES (?, ?, ?, ?, 1)",
        occupant.nodeId, "Synthetic persisted enrollment", "synthetic-bound-key", "darwin");
      replaceIntercomSlot(state.storage.sql, "kherep-lead", 0, occupant);
      replaceIntercomSlot(state.storage.sql, "codex-mac", 0, sentinel);
      state.storage.sql.exec(`INSERT INTO sessions (node_id, session_id, runtime, state, updated_at, name)
        VALUES ('synthetic-restart', 'sentinel-session', 'codex', 'unknown', 1, 'Synthetic unrelated sentinel')`);
    });
    expect(await (await api(path, {}, jwt)).json()).toEqual({ slots: INTERCOM_SLOTS.map(slot => ({
      slot, revision: slot === "kherep-lead" || slot === "codex-mac" ? 1 : 0,
      occupant: slot === "kherep-lead" ? occupant : slot === "codex-mac" ? sentinel : null,
    })) });
    await runInDurableObject(stub, (_instance, state) => {
      if (fault === "one-row") state.storage.sql.exec("DELETE FROM intercom_slots WHERE slot='kherep-lead'");
      if (fault === "all-rows") state.storage.sql.exec("DELETE FROM intercom_slots");
      if (fault === "absent-table") state.storage.sql.exec("DROP TABLE intercom_slots");
    });
    try {
      await evictDurableObject(stub);
      // The authenticated public GET is the first call to activate the replacement.
      const response = await api(path, {}, jwt);
      const persisted = await runInDurableObject(stub, (instance, state) => ({
        fresh: !instances.has(instance),
        rows: state.storage.sql.exec("SELECT * FROM intercom_slots ORDER BY slot").toArray(),
        unrelated: state.storage.sql.exec("SELECT name FROM sessions WHERE node_id='synthetic-restart'").one(),
      }));
      expect(persisted.fresh).toBe(true);
      expect(persisted.unrelated).toEqual({ name: "Synthetic unrelated sentinel" });
      if (fault === "one-row" || fault === "all-rows") {
        expect({ status: response.status, rows: persisted.rows.length,
          leadPresent: persisted.rows.some(row => row.slot === "kherep-lead") })
          .toEqual({ status: 503, rows: fault === "one-row" ? 4 : 0, leadPresent: false });
        expect(await response.json()).toEqual({ error: "Intercom roster unavailable" });
        if (fault === "one-row") expect(persisted.rows.find(row => row.slot === "codex-mac")).toEqual({
          slot: "codex-mac", revision: 1, node_id: sentinel.nodeId, runtime: sentinel.runtime,
          session_id: sentinel.sessionId, chat_name: sentinel.chatName,
        });
      } else {
        expect(response.status).toBe(200);
        const empty = INTERCOM_SLOTS.map(slot => ({ slot, revision: 0, occupant: null }));
        const expected = fault === "absent-table" ? empty : empty.map(row => row.slot === "kherep-lead"
          ? { ...row, revision: 1, occupant } : row.slot === "codex-mac" ? { ...row, revision: 1, occupant: sentinel } : row);
        expect(await response.json()).toEqual({ slots: expected });
        expect(persisted.rows).toHaveLength(5);
      }
    } finally {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("DROP TABLE intercom_slots");
        initializeRegistrySchema(state.storage);
        state.storage.sql.exec("DELETE FROM sessions WHERE node_id='synthetic-restart'");
        state.storage.sql.exec("DELETE FROM nodes WHERE id=?", occupant.nodeId);
      });
    }
  });
});
