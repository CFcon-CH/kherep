import fs from "node:fs";
import path from "node:path";
import type { McpRegistry } from "../src/mcp-registry.mts";
import { type NativeNode, startNativeNode } from "./mcp-two-chat-fixture.mts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CodexActivityRegistration, type McpIntentReceiptBody, digestMcpArguments, REMOTE_MCP_CAPABILITY } from "../../protocol-mcp.mts";
import { FACTS, newKey, registry, authenticate, until } from "./helpers.mts";
import { type SessionInfo, makeEnvelope, parseEnvelope } from "../../protocol.mts";
import type { McpAssignmentNative } from "../../protocol-mcp.mts";
import type { TestSocket } from "./helpers.mts";
import { handleMcp } from "../src/mcp-http.mts";
import type { Env } from "../src/env.mts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
async function sdk(token: string) {
  const client = new Client({ name: "synthetic-original", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://control.example.invalid/mcp"), {
    authProvider: { token: async () => token },
    fetch: (input, init) => handleMcp(new Request(input, init), { ...env, REMOTE_MCP_ENABLED: "true" } as Env),
  }));
  return client;
}
async function source(sessionId = SESSION, title = "Synthetic original A") {
  const key = await newKey(), { code } = await registry().createEnrollment("synthetic");
  const facts = { ...FACTS, os: "darwin" };
  const enrolled = await registry().redeemEnrollment({ code, publicKey: key.publicKey, name: "Synthetic node", facts,
    runtimes: [{ name: "codex", kind: "cli" }] });
  if (!enrolled.ok) throw Error("synthetic enrollment failed");
  const nodeId = enrolled.nodeId;
  await registry().updateRegistration(nodeId, facts, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY]);
  await registry().replaceSessions(nodeId, [{ sessionId, runtime: "codex", state: "running" }]);
  const credential = await registry().rotateMcpCredential(nodeId);
  if (!credential.ok) throw Error("synthetic credential failed");
  const credentialVersion = credential.version;
  let socket: TestSocket | undefined, sequence = 0, challenges = 0, allowLead = true;
  let responseMode: "normal" | "wrong-nonce" | "silent" = "normal";
  let onChallenge: ((nonce: string) => Promise<void>) | undefined;
  const connectLead = async () => {
    if (socket) return;
    socket = await authenticate(nodeId, key);
    socket.send(makeEnvelope("register", { facts, runtimes: [{ name: "codex", kind: "cli" }], capabilities: [REMOTE_MCP_CAPABILITY] }, ++sequence, 0));
    await vi.waitFor(async () => {
      const ready = await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("SELECT registration_token,message_connection_token FROM nodes WHERE id=?", nodeId).one());
      expect(typeof ready.registration_token).toBe("string");expect(ready.registration_token).toBe(ready.message_connection_token);
    });
    socket.ws.addEventListener("message", event => {
      const parsed = parseEnvelope(event.data as string);
      if (!parsed.ok || parsed.envelope.type !== "mcp.lead.confirm.request") return;
      challenges++;
      const body = parsed.envelope.body as { nonce: string };
      void (async () => {
        if (onChallenge) await onChallenge(body.nonce);
        if (socket!.ws.readyState === 1 && responseMode !== "silent") socket!.send(makeEnvelope("mcp.lead.confirm.response", {
          nonce: responseMode === "wrong-nonce" ? crypto.randomUUID() : body.nonce, allowed: allowLead }, ++sequence, 0));
      })();
    });
  };
  async function registration(slot: "codex-mac" | "kherep-lead") {
    const requestId = crypto.randomUUID(), callId = crypto.randomUUID(), argumentsDigest = await digestMcpArguments({ slot });
    return { requestId, runtime: "codex" as const, sessionId, threadId: sessionId, callId,
      tool: "assign_self" as const, argumentsDigest,
      assignment: { slot, turnId: TURN, native: { sessionId, chatName: title, platform: "darwin", originalMain: true,
        ...(slot === "kherep-lead" ? { leadGuardVersion: 1 } : {}) } as McpAssignmentNative } };
  }
  async function intent(slot: "codex-mac" | "kherep-lead") {
    if (slot === "kherep-lead") await connectLead();
    const value = await registration(slot);
    const accepted = await registry().registerMcpIntent(nodeId, value);
    expect(accepted.ok).toBe(true);
    return { nodeId, credentialVersion, requestId: value.requestId, runtime: "codex" as const,
      sessionId, threadId: sessionId, callId: value.callId, tool: "assign_self" as const, argumentsDigest: value.argumentsDigest };
  }
  return { nodeId, sessionId, title, intent, registration, credential, key, challenges: () => challenges,
    allowLead: (allow: boolean) => { allowLead = allow; }, onChallenge: (fn: (nonce: string) => Promise<void>) => { onChallenge = fn; },
    responseMode: (mode: typeof responseMode) => { responseMode = mode; },
    socket: () => socket, close: () => socket?.ws.close() };
}

describe("native self-assignment transaction", () => {
  const pending = (requestId: string) => runInDurableObject(registry(), (_instance, state) =>
    state.storage.sql.exec("SELECT claimed_at,outcome,assignment_result FROM mcp_intents WHERE request_id=?", requestId).one());
  const messageCount = () => runInDurableObject(registry(), (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n);
  // The current Worker has no heartbeat subsystem. Inspect metadata only,
  // rather than pretending an absent legacy table provides an attempt count.
  const heartbeatTables = () => runInDurableObject(registry(), (_instance, state) =>
    state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='intercom_heartbeat_attempts'").toArray());
  // Native producer attestation is synthetic, otherwise this is the complete
  // registered original/current credential path, including the real RPC/SDK.
  it("Codex Lead policy refuses an eligible RPC caller before confirmation or mutations", async () => {
    const a = await source(), request = await a.intent("kherep-lead");
    const before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    const messages = await messageCount();expect(await heartbeatTables()).toEqual([]);
    try {
      expect(await registry().assignMcpSlot(request, "kherep-lead")).toEqual({ ok: false, error: "Codex cannot self-assign kherep-lead" });
      expect(a.challenges()).toBe(0);
      expect(await registry().listIntercomSlots()).toEqual(before);
      expect(await pending(request.requestId)).toEqual(row);
      expect(await pending(request.requestId)).toEqual({ claimed_at: null, outcome: null, assignment_result: null });
      expect(await messageCount()).toBe(messages);
      expect(await heartbeatTables()).toEqual([]);
    } finally { a.close(); }
  });

  it("Codex Lead policy refuses the actual HTTP SDK and retry with no successful receipt", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), client = await sdk(a.credential.token);
    const before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    const messages = await messageCount();expect(await heartbeatTables()).toEqual([]);
    try {
      const args = { slot: "kherep-lead", requestId: request.requestId };
      const meta = { sessionId: a.sessionId, threadId: a.sessionId, callId: request.callId };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.callTool({ name: "assign_self", arguments: args, _meta: meta });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("Codex cannot self-assign kherep-lead");
        expect(result.structuredContent).toEqual({ ok: false, error: "Codex cannot self-assign kherep-lead" });
        expect(result._meta?.["kherep.dev/heartbeatJoin"]).toBeUndefined();
        expect(a.challenges()).toBe(0);
        expect(await pending(request.requestId)).toEqual(row);
        expect(await pending(request.requestId)).toEqual({ claimed_at: null, outcome: null, assignment_result: null });
        expect(await registry().listIntercomSlots()).toEqual(before);
        expect(await messageCount()).toBe(messages);
        expect(await heartbeatTables()).toEqual([]);
      }
    } finally { await client.close(); a.close(); }
  });

  it("refuses legacy unstamped Lead registration without changing roster or consuming an intent", async () => {
    const a = await source(), value = await a.registration("kherep-lead");
    delete value.assignment.native.leadGuardVersion;
    const before = await registry().listIntercomSlots();
    expect((await registry().registerMcpIntent(a.nodeId, value)).ok).toBe(false);
    expect(await registry().listIntercomSlots()).toEqual(before);
    await runInDurableObject(registry(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT request_id FROM mcp_intents WHERE request_id=?", value.requestId).toArray()).toEqual([]);
    });
  });
  beforeEach(async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE intercom_slots SET revision=0,node_id=NULL,runtime=NULL,session_id=NULL,chat_name=NULL");
    });
  });
  it("assigns automatic original identity/title and replaces its platform slot without the former holder", async () => {
    const a = await source(), b = await source("33333333-3333-4333-8333-333333333333", "Synthetic original B");
    const before = await registry().listIntercomSlots();
    const first = await a.intent("codex-mac");
    expect(await registry().assignMcpSlot(first, "codex-mac")).toEqual({ ok: true, slot: "codex-mac", revision: 1 });
    expect(a.challenges()).toBe(0);
    const second = await b.intent("codex-mac");
    expect(await registry().assignMcpSlot(second, "codex-mac")).toEqual({ ok: true, slot: "codex-mac", revision: 2 });
    expect(await registry().assignMcpSlot(first, "codex-mac")).toEqual({ ok: true, slot: "codex-mac", revision: 1 });
    expect(a.challenges()).toBe(0);
    const after = await registry().listIntercomSlots();
    expect(after.find(row => row.slot === "codex-mac")).toEqual({ slot: "codex-mac", revision: 2, occupant: {
      nodeId: b.nodeId, runtime: "codex", sessionId: b.sessionId, chatName: b.title } });
    expect(after.filter(row => row.slot !== "codex-mac")).toEqual(before.filter(row => row.slot !== "codex-mac"));
    await runInDurableObject(registry(), (_instance, state) => {
      expect(JSON.stringify(state.storage.sql.exec("SELECT * FROM mcp_intents WHERE request_id=?", first.requestId).one()))
        .not.toContain("prompt");
    });
  });

  it("captures platform first-registration revision, keeps contender conflict and applied replay immutable", async () => {
    const a = await source(), b = await source("33333333-3333-4333-8333-333333333333", "Synthetic B");
    const first = await a.intent("codex-mac"), contender = await b.intent("codex-mac");
    expect(await registry().assignMcpSlot(first, "codex-mac")).toMatchObject({ ok: true, revision: 1 });
    const conflict = { ok: false, error: "Intercom slot revision conflict", conflict: true };
    expect(await registry().assignMcpSlot(contender, "codex-mac")).toEqual(conflict);
    const fresh = await b.intent("codex-mac");
    expect(await registry().assignMcpSlot(fresh, "codex-mac")).toMatchObject({ ok: true, revision: 2 });
    expect(await registry().assignMcpSlot(contender, "codex-mac")).toEqual(conflict);
    expect(await registry().assignMcpSlot(first, "codex-mac")).toMatchObject({ ok: true, revision: 1 });
    expect((await registry().listIntercomSlots()).find(row => row.slot === "codex-mac")?.revision).toBe(2);
  });

  it("denies a changed latest input during the intent TTL without consuming or changing any roster row", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    a.allowLead(false);
    expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
    expect(a.challenges()).toBe(0);expect(await pending(request.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);
    a.close();
  });

  it("denies legacy unapplied and recorded Codex Lead assignments while preserving historical outcomes", async () => {
    const a = await source(), stale = await a.intent("kherep-lead");
    // A pre-policy occupant and its endpoint rights are retained, not retired
    // by a new denied appointment. This seed is synthetic historical state.
    await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec(
      "UPDATE intercom_slots SET revision=17,node_id=?,runtime='codex',session_id=?,chat_name=? WHERE slot='kherep-lead'",
      a.nodeId, a.sessionId, a.title));
    const before = await registry().listIntercomSlots();
    try {
      await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_intents SET lead_guard_version=NULL WHERE request_id=?", stale.requestId); });
      const row = await pending(stale.requestId);
      expect((await registry().assignMcpSlot(stale, "kherep-lead")).ok).toBe(false);
      expect(a.challenges()).toBe(0); expect(await pending(stale.requestId)).toEqual(row);
      const historical = await a.intent("kherep-lead");
      // Synthetic pre-policy success: the new policy may not erase or rewrite it.
      await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec(
        "UPDATE mcp_intents SET lead_guard_version=NULL,claimed_at=?,outcome='succeeded',assignment_result=? WHERE request_id=?",
        Date.now(), JSON.stringify({ ok: true, slot: "kherep-lead", revision: 7 }), historical.requestId));
      const recorded = await pending(historical.requestId);
      expect(await registry().assignMcpSlot(historical, "kherep-lead")).toEqual({ ok: false, error: "Codex cannot self-assign kherep-lead" });
      expect(await pending(historical.requestId)).toEqual(recorded);
      expect(a.challenges()).toBe(0); expect(await registry().listIntercomSlots()).toEqual(before);
    } finally { a.close(); }
  });

  it("denies Lead before any credential, session, registration, proof, revision or expiry challenge callback", async () => {
    for (const fault of ["credential", "session", "registration", "version", "revision", "expiry"] as const) {
      const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots();
      a.onChallenge(async () => {
        await runInDurableObject(registry(), (_instance, state) => {
          if (fault === "credential") state.storage.sql.exec("UPDATE mcp_credentials SET version=version+1 WHERE node_id=?", a.nodeId);
          if (fault === "session") state.storage.sql.exec("DELETE FROM sessions WHERE node_id=?", a.nodeId);
          if (fault === "registration") state.storage.sql.exec("UPDATE nodes SET registration_token=NULL WHERE id=?", a.nodeId);
          if (fault === "version") state.storage.sql.exec("UPDATE mcp_intents SET lead_guard_version=NULL WHERE request_id=?", request.requestId);
          if (fault === "revision") state.storage.sql.exec("UPDATE mcp_intents SET assignment_revision=assignment_revision+1 WHERE request_id=?", request.requestId);
          if (fault === "expiry") state.storage.sql.exec("UPDATE mcp_intents SET expires_at=0 WHERE request_id=?", request.requestId);
        });
      });
      expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
      expect(await pending(request.requestId)).toEqual({ claimed_at: null, outcome: null, assignment_result: null });
      expect(a.challenges()).toBe(0);expect(await registry().listIntercomSlots()).toEqual(before);a.close();
    }
  });

  it("denies concurrent exact Lead calls without confirmation, mutation or receipt", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    const results = await Promise.all([registry().assignMcpSlot(request, "kherep-lead"), registry().assignMcpSlot(request, "kherep-lead")]);
    expect(results).toEqual([{ ok: false, error: "Codex cannot self-assign kherep-lead" }, { ok: false, error: "Codex cannot self-assign kherep-lead" }]);
    expect(a.challenges()).toBe(0);expect(await registry().listIntercomSlots()).toEqual(before);expect(await pending(request.requestId)).toEqual(row);a.close();
  });

  for (const mode of ["wrong-nonce", "silent"] as const) it(`refuses Lead before a ${mode} source can be asked for confirmation`, async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    a.responseMode(mode);
    expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
    expect(a.challenges()).toBe(0);expect(await pending(request.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);a.close();
  });

  it("denies Lead without contacting a source that would close during confirmation", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    a.onChallenge(async () => { a.close(); });
    expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
    expect(a.challenges()).toBe(0);expect(await pending(request.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);a.close();
  });

  it("denies Lead after socket replacement without requesting a new confirmation", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    const replacement = await authenticate(a.nodeId, a.key);
    try {
      expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
      expect(a.challenges()).toBe(0);
      expect(await pending(request.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);
    } finally { replacement.ws.close();a.close(); }
  });

  it("HTTP platform assignment succeeds and replays without any Lead challenge", async () => {
    const a = await source(), request = await a.intent("codex-mac"), client = await sdk(a.credential.token);
    try {
      const args = { slot: "codex-mac", requestId: request.requestId }, meta = { sessionId: a.sessionId, threadId: a.sessionId, callId: request.callId };
      const result = await client.callTool({ name: "assign_self", arguments: args, _meta: meta });expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ ok: true, slot: "codex-mac", revision: 1 });expect(a.challenges()).toBe(0);
      a.allowLead(false);expect((await client.callTool({ name: "assign_self", arguments: args, _meta: meta })).structuredContent).toEqual(result.structuredContent);
      expect(a.challenges()).toBe(0);
    } finally { await client.close();a.close(); }
  });

  it("rejects foreign thread/call/credential/slot and missing current registration without consuming intent", async () => {
    const a = await source(), request = await a.intent("codex-mac"), before = await registry().listIntercomSlots();
    for (const claim of [{ ...request, threadId: "33333333-3333-4333-8333-333333333333" },
      { ...request, callId: "foreign-call" }, { ...request, credentialVersion: request.credentialVersion + 1 },
      { ...request, sessionId: "33333333-3333-4333-8333-333333333333" }]) {
      expect((await registry().assignMcpSlot(claim, "codex-mac")).ok).toBe(false);
      expect(await registry().listIntercomSlots()).toEqual(before);
    }
    expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
    await registry().replaceSessions(a.nodeId, []);
    expect((await registry().assignMcpSlot(request, "codex-mac")).ok).toBe(false);
    await runInDurableObject(registry(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT claimed_at,assignment_result FROM mcp_intents WHERE request_id=?", request.requestId).one())
        .toEqual({ claimed_at: null, assignment_result: null });
    });
    expect(await registry().listIntercomSlots()).toEqual(before);
  });

  it("requires daemon-enriched original proof, exact title, digest and prebound thread at registration", async () => {
    const a = await source(), value = await a.registration("codex-mac"), before = await registry().listIntercomSlots();
    const invalid = [
      { ...value, assignment: { slot: value.assignment.slot, turnId: TURN } },
      { ...value, assignment: { ...value.assignment, native: { ...value.assignment.native, chatName: "" } } },
      { ...value, assignment: { ...value.assignment, native: { ...value.assignment.native, originalMain: false } } },
      { ...value, threadId: "33333333-3333-4333-8333-333333333333" },
      { ...value, argumentsDigest: await digestMcpArguments({ slot: "kherep-lead" }) },
    ];
    for (const input of invalid) expect((await registry().registerMcpIntent(a.nodeId, input as typeof value)).ok).toBe(false);
    expect(await registry().listIntercomSlots()).toEqual(before);
  });

  it("rolls back slot and consumption together on transient storage failure, then retries once", async () => {
    const a = await source(), request = await a.intent("codex-mac");
    await runInDurableObject(registry(), (instance, state) => {
      state.storage.sql.exec(`CREATE TRIGGER synthetic_assignment_failure BEFORE UPDATE OF assignment_result ON mcp_intents
        BEGIN SELECT RAISE(ABORT, 'synthetic result failure'); END`);
      // The public method has an await before its synchronous transaction.
      return instance.assignMcpSlot(request, "codex-mac").then(() => { throw Error("expected failure"); }, () => {
        expect(instance.listIntercomSlots().every(row => row.revision === 0)).toBe(true);
        expect(state.storage.sql.exec("SELECT claimed_at,assignment_result FROM mcp_intents WHERE request_id=?", request.requestId).one())
          .toEqual({ claimed_at: null, assignment_result: null });
        state.storage.sql.exec("DROP TRIGGER synthetic_assignment_failure");
      });
    });
    expect(await registry().assignMcpSlot(request, "codex-mac")).toEqual({ ok: true, slot: "codex-mac", revision: 1 });
  });

  it("refuses expired, rotated and revoked callers and unsupported enrolled platform", async () => {
    for (const fault of ["expired", "rotated", "revoked", "windows"] as const) {
      const a = await source(), request = await a.intent("codex-mac"), before = await registry().listIntercomSlots();
      if (fault === "expired") await runInDurableObject(registry(), (_instance, state) => {
        state.storage.sql.exec("UPDATE mcp_intents SET expires_at=0 WHERE request_id=?", request.requestId);
      });
      if (fault === "rotated") await registry().rotateMcpCredential(a.nodeId);
      if (fault === "revoked") await registry().revoke(a.nodeId, "synthetic");
      if (fault === "windows") await runInDurableObject(registry(), (_instance, state) => {
        state.storage.sql.exec("UPDATE nodes SET os='win32' WHERE id=?", a.nodeId);
      });
      expect((await registry().assignMcpSlot(request, "codex-mac")).ok).toBe(false);
      expect(await registry().listIntercomSlots()).toEqual(before);
    }
  });

  it("SDK binds bearer/native call, refuses child and supplied identity, then assigns the original", async () => {
    const a = await source(), b = await source("33333333-3333-4333-8333-333333333333", "Synthetic B");
    const request = await a.intent("codex-mac"), client = await sdk(a.credential.token), other = await sdk(b.credential.token);
    const args = { requestId: request.requestId, slot: "codex-mac" };
    const meta = { sessionId: a.sessionId, threadId: a.sessionId, callId: request.callId };
    try {
      const before = await registry().listIntercomSlots();
      for (const result of [
        await client.callTool({ name: "assign_self", arguments: args, _meta: { ...meta, threadId: b.sessionId } }),
        await client.callTool({ name: "assign_self", arguments: { ...args, nodeId: a.nodeId }, _meta: meta }),
        await client.callTool({ name: "assign_self", arguments: { ...args, slot: "codex-windows" }, _meta: meta }),
        await client.callTool({ name: "assign_self", arguments: args }),
        await other.callTool({ name: "assign_self", arguments: args, _meta: meta }),
      ]) expect(result.isError).toBe(true);
      expect(await registry().listIntercomSlots()).toEqual(before);
      const assigned = await client.callTool({ name: "assign_self", arguments: args, _meta: meta });
      expect(assigned.isError).not.toBe(true);
      expect(assigned.structuredContent).toEqual({ ok: true, slot: "codex-mac", revision: 1 });
      expect((await registry().listIntercomSlots()).find(row => row.slot === "codex-mac")?.occupant)
        .toEqual({ nodeId: a.nodeId, sessionId: a.sessionId, runtime: "codex", chatName: a.title });
    } finally { await client.close();await other.close(); }
  });

  it("admits a fresh original only after current node registration and complete snapshot, preserving companions", async () => {
    const a = await source();await registry().replaceSessions(a.nodeId, []);
    const value = await a.registration("codex-mac"), socket = await authenticate(a.nodeId, a.key);
    const client = await sdk(a.credential.token);
    try {
      socket.send(makeEnvelope("mcp.intent.register", value, 1, 0));
      const refused = await until(socket, "mcp.intent.receipt", { requestId: value.requestId });
      expect((refused.at(-1)?.body as { ok: boolean }).ok).toBe(false);
      socket.send(makeEnvelope("register", { facts: { ...FACTS, os: "darwin" },
        runtimes: [{ name: "codex", kind: "cli" }], capabilities: [REMOTE_MCP_CAPABILITY] }, 2, 0));
      const companion = { sessionId: "44444444-4444-4444-8444-444444444444", runtime: "codex", state: "running" };
      const original = { sessionId: a.sessionId, runtime: "codex", state: "running" };
      socket.send(makeEnvelope("sessions.snapshot", { sessions: [companion, original] }, 3, 0));
      socket.send(makeEnvelope("mcp.intent.register", value, 4, 0));
      const admitted = await until(socket, "mcp.intent.receipt", { requestId: value.requestId });
      expect((admitted.at(-1)?.body as { ok: boolean }).ok).toBe(true);
      const assigned = await client.callTool({ name: "assign_self", arguments: { slot: "codex-mac", requestId: value.requestId },
        _meta: { sessionId: a.sessionId, threadId: a.sessionId, callId: value.callId } });
      expect(assigned.isError).not.toBe(true);
      expect((await registry().listSessions()).filter(row => row.nodeId === a.nodeId).map(row => row.sessionId).sort())
        .toEqual([companion.sessionId, original.sessionId].sort());
      expect((await registry().listIntercomSlots()).find(row => row.slot === "codex-mac")?.occupant?.chatName).toBe(a.title);
    } finally { await client.close();socket.ws.close(); }
  });
});


describe("fresh Codex original activity", () => {
    it("UNKNOWN original crosses real hook, enrolled WS, SQLite and SDK exactly once", async () => {
        const companion = "44444444-4444-4444-8444-444444444444";
        const node = await startNativeNode("synthetic-codex", [
            { sessionId: SESSION, runtime: "codex", kind: "codex", state: "unknown", title: "Synthetic original A" },
            { sessionId: companion, runtime: "codex", kind: "codex", state: "unknown", title: "Synthetic companion B" },
        ], true);
        try {
            await node.publishSessions();
            const rows = () => runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("SELECT * FROM sessions WHERE node_id=? ORDER BY session_id", node.nodeId).toArray());
            const initialRows = await rows();
            expect(initialRows.map(row => row.state)).toEqual(["unknown", "unknown"]);
            const roster = await registry().listIntercomSlots();
            expect(await registry().registerMcpIntent(node.nodeId, { requestId: crypto.randomUUID(), runtime: "codex", sessionId: SESSION, callId: "ordinary-unknown", tool: "status", argumentsDigest: "a".repeat(64) }))
                .toEqual({ ok: false, error: "native session is not registered on this node" });
            const output = await node.nativeHook({ hook_event_name: "PreToolUse", session_id: SESSION, turn_id: TURN,
                tool_use_id: "synthetic-original-call", tool_name: "mcp__kherep_messaging__assign_self", tool_input: { slot: "codex-mac" } }, "codex");
            const hook = output?.hookSpecificOutput;
            if (!hook?.updatedInput) {
                const sent = node.sent.findLast(f => f.type === "mcp.intent.register");
                const received = node.received.findLast(f => f.type === "mcp.intent.receipt");
                expect((sent?.body as {
                    assignment?: {
                        native?: {
                            originalMain?: boolean;
                        };
                    };
                })?.assignment?.native?.originalMain).toBe(true);
                expect(received?.body).toMatchObject({ ok: false, error: "native session is not registered on this node" });
                expect(hook?.permissionDecisionReason).toBe("remote_mcp_intent_rejected_worker_session");
                expect(await registry().listIntercomSlots()).toEqual(roster);
            }
            expect(hook?.updatedInput, `actual hook decision: ${hook?.permissionDecisionReason}`).toMatchObject({ slot: "codex-mac", requestId: expect.any(String) });
            const stamped = node.sent.findLast(f => f.type === "mcp.intent.register")!.body as CodexActivityRegistration;
            const ledger = JSON.parse(fs.readFileSync(path.join(node.paths.dir, "session-liveness.json"), "utf8")) as {
                sessions: {
                    sessionId: string;
                    observedAt: number;
                }[];
            };
            expect(ledger.sessions.find(row => row.sessionId === SESSION)!.observedAt).toBe(stamped.observedAt);
            const persisted = await runInDurableObject(registry(), (_instance, state) => ({
                header: state.storage.sql.exec("SELECT identity_generation FROM nodes WHERE id=?", node.nodeId).one(),
                intent: state.storage.sql.exec("SELECT * FROM mcp_intents WHERE request_id=?", stamped.intent.requestId).one(),
            }));
            expect(persisted.header.identity_generation).toBe(stamped.identitySnapshot.generation);
            expect(persisted.intent).toMatchObject({ session_id: SESSION, call_id: stamped.intent.callId,
                arguments_digest: stamped.intent.argumentsDigest, expires_at: stamped.observedAt + 60000, claimed_at: null,
                assignment_revision: roster.find(row => row.slot === "codex-mac")!.revision });
            const committed = await rows();
            expect(committed.map(row => row.state)).toEqual(["reachable-probable", "unknown"]);
            expect(committed.find(row => row.session_id === companion)).toEqual(initialRows.find(row => row.session_id === companion));
            expect(await registry().listIntercomSlots()).toEqual(roster);
            const client = await node.mcp();
            const call = { name: "assign_self", arguments: hook!.updatedInput!, _meta: { sessionId: SESSION, threadId: SESSION, callId: "synthetic-original-call" } };
            const result = await client.callTool(call);
            expect(result.isError).not.toBe(true);
            const revision = roster.find(row => row.slot === "codex-mac")!.revision + 1;
            expect(result.structuredContent).toEqual({ ok: true, slot: "codex-mac", revision });
            expect((await client.callTool(call)).structuredContent).toEqual(result.structuredContent);
            const after = await registry().listIntercomSlots();
            expect(after.find(row => row.slot === "codex-mac")).toEqual({ slot: "codex-mac", revision, occupant: {
                    nodeId: node.nodeId, runtime: "codex", sessionId: SESSION, chatName: "Synthetic original A"
                } });
            expect(after.filter(row => row.slot !== "codex-mac")).toEqual(roster.filter(row => row.slot !== "codex-mac"));
        }
        finally {
            await node.close();
        }
    });
});
const B = "44444444-4444-4444-8444-444444444444";
const C = "55555555-5555-4555-8555-555555555555";
const S = "66666666-6666-4666-8666-666666666666";
const originalRow = (state = "unknown"): SessionInfo => ({ sessionId: SESSION, runtime: "codex", kind: "codex", state, title: "Synthetic original A" });
const companionRow = (id = B): SessionInfo => ({ sessionId: id, runtime: "codex", kind: "codex", state: "unknown", title: `Synthetic companion ${id === B ? "B" : "C"}` });
async function activityNode() {
    const node = await startNativeNode("synthetic-atomic", [originalRow(), companionRow()], true);
    await node.publishSessions();
    return node;
}
async function completeState(nodeId: string) {
    return runInDurableObject(registry(), (instance, state) => {
        const directory = instance.directory();
        expect(directory.truncated).not.toBe(true);
        return {
            directory: directory.sessions.filter(row => row.nodeId === nodeId).sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
            sessions: state.storage.sql.exec("SELECT * FROM sessions WHERE node_id=? ORDER BY session_id", nodeId).toArray(),
            watermark: state.storage.sql.exec("SELECT identity_generation,identity_digest FROM nodes WHERE id=?", nodeId).one(),
            intents: state.storage.sql.exec("SELECT * FROM mcp_intents WHERE node_id=? ORDER BY request_id", nodeId).toArray(),
            slots: state.storage.sql.exec("SELECT * FROM intercom_slots ORDER BY slot").toArray(),
        };
    });
}
async function activityBody(node: NativeNode, generation: number, sessions: SessionInfo[], observedAt = Date.now()): Promise<CodexActivityRegistration> {
    const native = await node.nativeAssignment(SESSION);
    expect(native).not.toBeNull();
    return { kind: "codex-activity-v1", observedAt, identitySnapshot: { version: 1, generation }, sessions,
        intent: { requestId: crypto.randomUUID(), runtime: "codex", sessionId: SESSION, threadId: SESSION, callId: crypto.randomUUID(),
            tool: "assign_self", argumentsDigest: await digestMcpArguments({ slot: "codex-mac" }),
            assignment: { slot: "codex-mac", turnId: crypto.randomUUID(), native: native! } } };
}
async function sendActivity(node: NativeNode, body: CodexActivityRegistration): Promise<McpIntentReceiptBody> {
    const start = node.received.length;
    node.sendFrame("mcp.intent.register", { ...body });
    let receipt: McpIntentReceiptBody | undefined;
    await vi.waitFor(() => {
        receipt = node.received.slice(start).filter(frame => frame.type === "mcp.intent.receipt")
            .map(frame => frame.body as McpIntentReceiptBody).find(value => value.requestId === body.intent.requestId);
        expect(receipt).toBeDefined();
    });
    return receipt!;
}
async function claimActivity(node: NativeNode, body: CodexActivityRegistration) {
    const client = await node.mcp();
    return client.callTool({ name: "assign_self", arguments: { slot: "codex-mac", requestId: body.intent.requestId },
        _meta: { sessionId: SESSION, threadId: SESSION, callId: body.intent.callId } });
}
describe("atomic Codex full-population registration", () => {
    it("retains historical retry after legacy snapshot, refuses new identical same-generation call, then commits a newer generation", async () => {
        const node = await activityNode();
        try {
            const before = await completeState(node.nodeId), generation = Number(before.watermark.identity_generation) + 1;
            const first = await activityBody(node, generation, [originalRow("reachable-probable"), companionRow()]);
            const accepted = await sendActivity(node, first);
            expect(accepted).toMatchObject({ ok: true, expiresAt: first.observedAt + 60000 });
            const registered = await completeState(node.nodeId);
            expect(registered.slots).toEqual(before.slots);
            expect(registered.watermark.identity_digest).toBe(JSON.stringify([
                [SESSION, "codex", "reachable-probable", null, null, null, "codex", null, "Synthetic original A", null],
                [B, "codex", "unknown", null, null, null, "codex", null, "Synthetic companion B", null],
            ]));
            expect(registered.sessions.map(row => [row.session_id, row.state, row.title])).toEqual(first.sessions.map(row => [row.sessionId, row.state, row.title]));
            const claimed = await claimActivity(node, first);
            expect(claimed.isError).not.toBe(true);
            const applied = await completeState(node.nodeId);
            expect(applied.intents[0]).toMatchObject({ outcome: "succeeded", assignment_result: JSON.stringify(claimed.structuredContent) });
            // Actual headerless publication keeps the watermark/digest while changing physical rows.
            const legacy = [originalRow("reachable-probable"), companionRow(C)];
            node.sendFrame("sessions.snapshot", { sessions: legacy });
            await vi.waitFor(async () => expect((await completeState(node.nodeId)).sessions.map(row => row.session_id)).toEqual([SESSION, C]));
            const intervening = await completeState(node.nodeId);
            expect(intervening.watermark).toEqual(applied.watermark);
            expect(intervening.intents).toEqual(applied.intents);
            expect(intervening.slots).toEqual(applied.slots);
            expect(intervening.sessions).not.toEqual(applied.sessions);
            expect(await sendActivity(node, first)).toEqual(accepted);
            expect(await completeState(node.nodeId)).toEqual(intervening);
            expect((await claimActivity(node, first)).structuredContent).toEqual(claimed.structuredContent);
            expect(await completeState(node.nodeId)).toEqual(intervening);
            const second = await activityBody(node, generation, first.sessions);
            expect(await sendActivity(node, second)).toMatchObject({ ok: false });
            expect((await claimActivity(node, second)).isError).toBe(true);
            expect(await completeState(node.nodeId)).toEqual(intervening);
            const conflict = await activityBody(node, generation, [originalRow("reachable-probable"), companionRow(C)]);
            expect(await sendActivity(node, conflict)).toMatchObject({ ok: false });
            expect(await completeState(node.nodeId)).toEqual(intervening);
            const third = await activityBody(node, generation + 1, [originalRow("reachable-probable"), { ...companionRow(C), title: "Synthetic newer companion" }]);
            expect(await sendActivity(node, third)).toMatchObject({ ok: true, expiresAt: third.observedAt + 60000 });
            const newer = await completeState(node.nodeId);
            expect(newer.watermark.identity_generation).toBe(generation + 1);
            expect(newer.watermark.identity_digest).toBe(JSON.stringify([
                [SESSION, "codex", "reachable-probable", null, null, null, "codex", null, "Synthetic original A", null],
                [C, "codex", "unknown", null, null, null, "codex", null, "Synthetic newer companion", null],
            ]));
            expect(newer.sessions.map(row => row.title)).toEqual(third.sessions.map(row => row.title));
            expect(newer.directory.map(row => row.title)).toEqual(third.sessions.map(row => row.title));
            expect(newer.slots).toEqual(intervening.slots);
            expect(newer.intents.find(row => row.request_id === first.intent.requestId)).toEqual(intervening.intents[0]);
            expect(newer.intents.find(row => row.request_id === third.intent.requestId)).toMatchObject({ claimed_at: null, outcome: null });
            const thirdClaim = await claimActivity(node, third);
            expect(thirdClaim.isError).not.toBe(true);
            expect(Number((thirdClaim.structuredContent as {
                revision: number;
            }).revision)).toBe(Number((claimed.structuredContent as {
                revision: number;
            }).revision) + 1);
            expect((await claimActivity(node, third)).structuredContent).toEqual(thirdClaim.structuredContent);
        }
        finally {
            await node.close();
        }
    });
    for (const fault of ["capacity", "insert-abort"] as const)
        it(`rolls back full SQL and warmed directory after real post-snapshot ${fault}`, async () => {
            const node = await activityNode();
            try {
                if (fault === "capacity") {
                    node.sendFrame("sessions.snapshot", { sessions: [originalRow(), companionRow(), { sessionId: S, runtime: "codex", state: "running", title: "Independent sender" }] });
                    await vi.waitFor(async () => expect((await completeState(node.nodeId)).sessions.length).toBe(3));
                    for (let i = 0; i < 128; i++)
                        expect((await registry().registerMcpIntent(node.nodeId, {
                            requestId: crypto.randomUUID(), runtime: "codex", sessionId: S, callId: `synthetic-capacity-${i}`, tool: "status", argumentsDigest: "a".repeat(64),
                        })).ok).toBe(true);
                }
                const baseline = await completeState(node.nodeId), generation = Number(baseline.watermark.identity_generation) + 1;
                const population = [originalRow("reachable-probable"), companionRow(C), ...(fault === "capacity" ? [{ sessionId: S, runtime: "codex", state: "running", title: "Independent sender" }] : [])];
                const body = await activityBody(node, generation, population);
                let witnessed = false, actualError = "";
                const result = await runInDurableObject(registry(), async (instance, state) => {
                    const mcp = (instance as unknown as {
                        mcp: McpRegistry;
                    }).mcp;
                    const original = mcp.register;
                    const spy = vi.spyOn(mcp, "register").mockImplementation(function (...args) {
                        expect(state.storage.sql.exec("SELECT identity_generation FROM nodes WHERE id=?", node.nodeId).one().identity_generation).toBe(generation);
                        expect(state.storage.sql.exec("SELECT session_id,state FROM sessions WHERE node_id=? ORDER BY session_id", node.nodeId).toArray())
                            .toEqual(population.map(row => ({ session_id: row.sessionId, state: row.state })));
                        expect(state.storage.sql.exec("SELECT request_id FROM mcp_intents WHERE request_id=?", body.intent.requestId).toArray()).toEqual([]);
                        witnessed = true;
                        try {
                            const returned = original.apply(mcp, args);
                            if (!returned.ok)
                                actualError = returned.error;
                            return returned;
                        }
                        catch (error) {
                            actualError = String(error);
                            throw error;
                        }
                    });
                    if (fault === "insert-abort")
                        state.storage.sql.exec(`CREATE TRIGGER synthetic_activity_insert_failure BEFORE INSERT ON mcp_intents
          WHEN NEW.request_id='${body.intent.requestId}'
            AND (SELECT identity_generation FROM nodes WHERE id='${node.nodeId}')=${generation}
            AND EXISTS(SELECT 1 FROM sessions WHERE node_id='${node.nodeId}' AND session_id='${SESSION}' AND state='reachable-probable')
            AND EXISTS(SELECT 1 FROM sessions WHERE node_id='${node.nodeId}' AND session_id='${C}')
            AND NOT EXISTS(SELECT 1 FROM sessions WHERE node_id='${node.nodeId}' AND session_id='${B}')
          BEGIN SELECT RAISE(ABORT, 'synthetic activity insert abort'); END`);
                    try {
                        const token = String(state.storage.sql.exec("SELECT registration_token FROM nodes WHERE id=?", node.nodeId).one().registration_token);
                        const result = await instance.registerCodexActivity(node.nodeId, body, token);
                        // Read the actual warmed cache before removing the test trigger/spy.
                        expect(instance.directory().sessions.filter(row => row.nodeId === node.nodeId).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual(baseline.directory);
                        expect(state.storage.sql.exec("SELECT * FROM sessions WHERE node_id=? ORDER BY session_id", node.nodeId).toArray()).toEqual(baseline.sessions);
                        expect(state.storage.sql.exec("SELECT identity_generation,identity_digest FROM nodes WHERE id=?", node.nodeId).one()).toEqual(baseline.watermark);
                        expect(state.storage.sql.exec("SELECT * FROM mcp_intents WHERE node_id=? ORDER BY request_id", node.nodeId).toArray()).toEqual(baseline.intents);
                        expect(state.storage.sql.exec("SELECT * FROM intercom_slots ORDER BY slot").toArray()).toEqual(baseline.slots);
                        return result;
                    }
                    finally {
                        spy.mockRestore();
                        if (fault === "insert-abort")
                            state.storage.sql.exec("DROP TRIGGER synthetic_activity_insert_failure");
                    }
                });
                expect(witnessed).toBe(true);
                expect(result.ok).toBe(false);
                if (fault === "capacity") {
                    expect(await sendActivity(node, body)).toEqual({ requestId: body.intent.requestId, ok: false, error: "too many unexpired MCP intents" });
                }
                expect(actualError).toContain(fault === "capacity" ? "too many unexpired MCP intents" : "synthetic activity insert abort");
                expect(await completeState(node.nodeId)).toEqual(baseline);
                expect((await claimActivity(node, body)).isError).toBe(true);
                expect(await completeState(node.nodeId)).toEqual(baseline);
                if (fault === "insert-abort") {
                    const control = await activityBody(node, generation, population);
                    expect(await sendActivity(node, control)).toMatchObject({ ok: true });
                    const committed = await completeState(node.nodeId);
                    expect(committed.slots).toEqual(baseline.slots);
                    expect(committed.sessions.map(row => row.session_id)).toEqual([SESSION, C]);
                    expect(committed.directory.map(row => row.sessionId)).toEqual([SESSION, C]);
                    expect((await claimActivity(node, control)).isError).not.toBe(true);
                }
            }
            finally {
                await node.close();
            }
        });
});
describe("Codex activity final authority after the real digest", () => {
    for (const change of ["unchanged", "connection-token", "deadline", "newer-generation"] as const) {
        it(`rechecks ${change} after the actual digest await without leaked population, intent or cache`, async () => {
            const node = await activityNode();
            try {
                const before = await completeState(node.nodeId), generation = Number(before.watermark.identity_generation) + 1;
                const body = await activityBody(node, generation, [originalRow("reachable-probable"), companionRow(C)]);
                const read = await runInDurableObject(registry(), async (instance, state) => {
                    const token = String(state.storage.sql.exec("SELECT registration_token FROM nodes WHERE id=?", node.nodeId).one().registration_token);
                    const original = crypto.subtle.digest.bind(crypto.subtle);
                    let release!: () => void, began!: () => void, gated = false;
                    const hold = new Promise<void>(resolve => { release = resolve; });
                    const started = new Promise<void>(resolve => { began = resolve; });
                    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
                        // Forward the real digest unchanged; only its resolution is delayed.
                        const digest = await original(...args);
                        gated = true;
                        began();
                        await hold;
                        return digest;
                    });
                    const clock = vi.spyOn(Date, "now");
                    const snapshot = () => {
                        const directory = instance.directory();
                        expect(directory.truncated).not.toBe(true);
                        return { sessions: state.storage.sql.exec("SELECT * FROM sessions WHERE node_id=? ORDER BY session_id", node.nodeId).toArray(),
                            watermark: state.storage.sql.exec("SELECT identity_generation,identity_digest FROM nodes WHERE id=?", node.nodeId).one(),
                            intents: state.storage.sql.exec("SELECT * FROM mcp_intents WHERE node_id=? ORDER BY request_id", node.nodeId).toArray(),
                            slots: state.storage.sql.exec("SELECT * FROM intercom_slots ORDER BY slot").toArray(),
                            directory: directory.sessions.filter(row => row.nodeId === node.nodeId).sort((a, b) => a.sessionId.localeCompare(b.sessionId)) };
                    };
                    try {
                        const pending = instance.registerCodexActivity(node.nodeId, body, token);
                        await started;
                        expect(gated).toBe(true);
                        if (change === "connection-token") {
                            expect(instance.beginMessageConnection(node.nodeId, "synthetic-replacement-token")).toBe(true);
                            expect(instance.updateRegistration(node.nodeId, { ...FACTS, os: "darwin" }, [{ name: "codex", kind: "cli" }], [REMOTE_MCP_CAPABILITY], "synthetic-replacement-token")).toBe(true);
                        }
                        if (change === "deadline")
                            clock.mockReturnValue(body.observedAt + 8000);
                        if (change === "newer-generation")
                            expect(instance.replaceSessions(node.nodeId, [originalRow(), { ...companionRow(C), title: "Synthetic intervening generation" }], { version: 1, generation: generation + 1 }, token)).toEqual({ ok: true });
                        const baseline = snapshot();
                        release();
                        const result = await pending;
                        if (change === "unchanged") {
                            expect(result.ok).toBe(true);
                            expect(snapshot().slots).toEqual(baseline.slots);
                            expect(snapshot().sessions.map(row => row.session_id)).toEqual([SESSION, C]);
                        }
                        else {
                            expect(result.ok).toBe(false);
                            expect(snapshot()).toEqual(baseline);
                        }
                        return result;
                    }
                    finally {
                        release();
                        spy.mockRestore();
                        clock.mockRestore();
                    }
                });
                if (change === "unchanged")
                    expect((await claimActivity(node, body)).isError).not.toBe(true);
                else {
                    expect(read.ok).toBe(false);
                    const baseline = await completeState(node.nodeId);
                    expect((await claimActivity(node, body)).isError).toBe(true);
                    expect(await completeState(node.nodeId)).toEqual(baseline);
                }
            }
            finally {
                await node.close();
            }
        });
    }
    it("retained native call and ingress cannot be rebound, and a replacement passive connection revokes claim eligibility", async () => {
        const node = await activityNode();
        try {
            const initial = await completeState(node.nodeId), body = await activityBody(node, Number(initial.watermark.identity_generation) + 1, [originalRow("reachable-probable"), companionRow()]);
            const accepted = await sendActivity(node, body);
            expect(accepted.ok).toBe(true);
            const baseline = await completeState(node.nodeId);
            for (const changed of [{ ...body, observedAt: body.observedAt + 1 }, { ...body, intent: { ...body.intent, requestId: crypto.randomUUID() } },
                { ...body, intent: { ...body.intent, callId: "synthetic-rebound-call" } },
                { ...body, intent: { ...body.intent, assignment: { ...body.intent.assignment!, native: { ...body.intent.assignment!.native!, chatName: "Synthetic changed title" } } } }]) {
                expect(await sendActivity(node, changed)).toMatchObject({ ok: false });
                expect(await completeState(node.nodeId)).toEqual(baseline);
            }
            await node.restart();
            await node.publishSessions();
            const replaced = await completeState(node.nodeId);
            expect(replaced.sessions.map(row => row.state)).toEqual(["unknown", "unknown"]);
            expect((await claimActivity(node, body)).isError).toBe(true);
            expect(await completeState(node.nodeId)).toEqual(replaced);
            expect(replaced.slots).toEqual(initial.slots);
        }
        finally {
            await node.close();
        }
    });
    it("old eligible actor cannot substitute for a failed fresh full snapshot", async () => {
        const node = await activityNode();
        try {
            node.sendFrame("sessions.snapshot", { sessions: [originalRow("reachable-probable"), companionRow()] });
            await vi.waitFor(async () => expect((await completeState(node.nodeId)).sessions[0].state).toBe("reachable-probable"));
            const before = await completeState(node.nodeId), body = await activityBody(node, Number(before.watermark.identity_generation) + 1, [originalRow("reachable-probable"), companionRow(C)]);
            await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec(`CREATE TRIGGER synthetic_activity_snapshot_failure BEFORE INSERT ON sessions
        WHEN NEW.node_id='${node.nodeId}' AND NEW.session_id='${C}' BEGIN SELECT RAISE(ABORT,'synthetic snapshot abort'); END`));
            try {
                expect(await sendActivity(node, body)).toMatchObject({ ok: false });
                expect(await completeState(node.nodeId)).toEqual(before);
                expect((await claimActivity(node, body)).isError).toBe(true);
                expect(await completeState(node.nodeId)).toEqual(before);
            }
            finally {
                await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("DROP TRIGGER synthetic_activity_snapshot_failure"));
            }
        }
        finally {
            await node.close();
        }
    });
});


it("real ordinary ACK precedes an expired stamped pickup with no registered intent or SDK/CAS effect",async()=>{
  const node=await activityNode();let release:()=>void=()=>{};let clock:ReturnType<typeof vi.spyOn>|undefined;
  try{
    node.sendFrame("sessions.snapshot",{sessions:[originalRow(),{...companionRow(),state:"running"}]});
    await vi.waitFor(async()=>expect((await completeState(node.nodeId)).sessions.find(row=>row.session_id===B)?.state).toBe("running"));
    const before=await completeState(node.nodeId),gate=node.holdAssignment();release=gate.release;
    const pending=node.nativeHook({hook_event_name:"PreToolUse",session_id:SESSION,turn_id:TURN,tool_use_id:"synthetic-expired-stamp",tool_name:"mcp__kherep_messaging__assign_self",tool_input:{slot:"codex-mac"}},"codex");
    await vi.waitFor(()=>expect(gate.entered()).toBe(true));
    const name=fs.readdirSync(node.paths.mcpIntents).find(name=>name.endsWith(".json"))!;
    const stamp=JSON.parse(fs.readFileSync(path.join(node.paths.mcpIntents,name),"utf8")) as {observedAt:number;intent:{requestId:string}};
    const ordinary=await node.nativeHook({hook_event_name:"PreToolUse",session_id:B,tool_use_id:"synthetic-ordinary-ack",tool_name:"mcp__kherep_messaging__status",tool_input:{messageId:crypto.randomUUID()}},"codex");
    expect(ordinary?.hookSpecificOutput.updatedInput).toHaveProperty("requestId");
    clock=vi.spyOn(Date,"now").mockReturnValue(stamp.observedAt+8000);release();
    expect((await pending)?.hookSpecificOutput.updatedInput).toBeUndefined();
    await vi.waitFor(()=>expect(node.activityIdle()).toBe(true));
    expect(node.sent.filter(frame=>frame.type==="mcp.intent.register"&&(frame.body as {kind?:string}).kind==="codex-activity-v1")).toEqual([]);
    const state=await completeState(node.nodeId);expect(state.intents.find(row=>row.request_id===stamp.intent.requestId)).toBeUndefined();
    expect(state.sessions.find(row=>row.session_id===SESSION)?.state).toBe("unknown");expect(state.slots).toEqual(before.slots);
    const client=await node.mcp();const claim=await client.callTool({name:"assign_self",arguments:{slot:"codex-mac",requestId:stamp.intent.requestId},_meta:{sessionId:SESSION,threadId:SESSION,callId:"synthetic-expired-stamp"}});
    expect(claim.isError).toBe(true);expect((await completeState(node.nodeId)).slots).toEqual(before.slots);
  }finally{release();clock?.mockRestore();await node.close();}
});
