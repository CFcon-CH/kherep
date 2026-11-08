import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestMcpArguments, REMOTE_MCP_CAPABILITY } from "../../protocol-mcp.mts";
import { FACTS, newKey, registry, authenticate, until } from "./helpers.mts";
import { makeEnvelope, parseEnvelope } from "../../protocol.mts";
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
  it("assigns automatic original identity/title and replaces lead without the former holder", async () => {
    const a = await source(), b = await source("33333333-3333-4333-8333-333333333333", "Synthetic original B");
    const before = await registry().listIntercomSlots();
    const first = await a.intent("kherep-lead");
    expect(await registry().assignMcpSlot(first, "kherep-lead")).toEqual({ ok: true, slot: "kherep-lead", revision: 1 });
    expect(a.challenges()).toBe(1);
    const second = await b.intent("kherep-lead");
    expect(await registry().assignMcpSlot(second, "kherep-lead")).toEqual({ ok: true, slot: "kherep-lead", revision: 2 });
    expect(await registry().assignMcpSlot(first, "kherep-lead")).toEqual({ ok: true, slot: "kherep-lead", revision: 1 });
    expect(a.challenges()).toBe(1);
    const after = await registry().listIntercomSlots();
    expect(after[0]).toEqual({ slot: "kherep-lead", revision: 2, occupant: {
      nodeId: b.nodeId, runtime: "codex", sessionId: b.sessionId, chatName: b.title } });
    expect(after.slice(1)).toEqual(before.slice(1));
    await runInDurableObject(registry(), (_instance, state) => {
      expect(JSON.stringify(state.storage.sql.exec("SELECT * FROM mcp_intents WHERE request_id=?", first.requestId).one()))
        .not.toContain("prompt");
    });
  });

  it("captures first-registration revision, keeps contender conflict and applied replay immutable", async () => {
    const a = await source(), b = await source("33333333-3333-4333-8333-333333333333", "Synthetic B");
    const first = await a.intent("kherep-lead"), contender = await b.intent("kherep-lead");
    expect(await registry().assignMcpSlot(first, "kherep-lead")).toMatchObject({ ok: true, revision: 1 });
    const conflict = { ok: false, error: "Intercom slot revision conflict", conflict: true };
    expect(await registry().assignMcpSlot(contender, "kherep-lead")).toEqual(conflict);
    const fresh = await b.intent("kherep-lead");
    expect(await registry().assignMcpSlot(fresh, "kherep-lead")).toMatchObject({ ok: true, revision: 2 });
    expect(await registry().assignMcpSlot(contender, "kherep-lead")).toEqual(conflict);
    expect(await registry().assignMcpSlot(first, "kherep-lead")).toMatchObject({ ok: true, revision: 1 });
    expect((await registry().listIntercomSlots())[0]?.revision).toBe(2);
  });

  it("denies a changed latest input during the intent TTL without consuming or changing any roster row", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    a.allowLead(false);
    expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
    expect(a.challenges()).toBe(1);expect(await pending(request.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);
    a.close();
  });

  it("refuses an old unapplied SQL row but replays an already recorded old outcome without a challenge", async () => {
    const a = await source(), stale = await a.intent("kherep-lead"), before = await registry().listIntercomSlots();
    await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_intents SET lead_guard_version=NULL WHERE request_id=?", stale.requestId); });
    const row = await pending(stale.requestId);
    expect((await registry().assignMcpSlot(stale, "kherep-lead")).ok).toBe(false);
    expect(a.challenges()).toBe(0);expect(await pending(stale.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);
    const valid = await a.intent("kherep-lead"), applied = await registry().assignMcpSlot(valid, "kherep-lead");expect(applied.ok).toBe(true);
    await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_intents SET lead_guard_version=NULL WHERE request_id=?", valid.requestId); });
    expect(await registry().assignMcpSlot(valid, "kherep-lead")).toEqual(applied);expect(a.challenges()).toBe(1);a.close();
  });

  it("revalidates credentials, session, registration, proof version, saved revision and expiry after the await", async () => {
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
      expect(await registry().listIntercomSlots()).toEqual(before);a.close();
    }
  });

  it("coalesces concurrent exact Lead calls and records one mutation and one historical result", async () => {
    const a = await source(), request = await a.intent("kherep-lead");
    const results = await Promise.all([registry().assignMcpSlot(request, "kherep-lead"), registry().assignMcpSlot(request, "kherep-lead")]);
    expect(results).toEqual([{ ok: true, slot: "kherep-lead", revision: 1 }, { ok: true, slot: "kherep-lead", revision: 1 }]);
    expect(a.challenges()).toBe(1);expect((await registry().listIntercomSlots())[0]?.revision).toBe(1);a.close();
  });

  for (const mode of ["wrong-nonce", "silent"] as const) it(`refuses ${mode} confirmation at timeout with no consumption`, async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    a.responseMode(mode);
    expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
    expect(await pending(request.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);a.close();
  });

  it("refuses a socket that closes during confirmation", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    a.onChallenge(async () => { a.close(); });
    expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
    expect(await pending(request.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);
  });

  it("refuses a nonce response sent by a replacement socket", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots(), row = await pending(request.requestId);
    let replacement: TestSocket | undefined;
    a.onChallenge(async nonce => { replacement = await authenticate(a.nodeId, a.key);replacement.send(makeEnvelope("mcp.lead.confirm.response", { nonce, allowed: true }, 1, 0)); });
    expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
    expect(await pending(request.requestId)).toEqual(row);expect(await registry().listIntercomSlots()).toEqual(before);
    replacement?.ws.close();a.close();
  });

  it("HTTP Lead tool succeeds only after an authenticated final challenge and replays without a second one", async () => {
    const a = await source(), request = await a.intent("kherep-lead"), client = await sdk(a.credential.token);
    try {
      const args = { slot: "kherep-lead", requestId: request.requestId }, meta = { sessionId: a.sessionId, threadId: a.sessionId, callId: request.callId };
      const result = await client.callTool({ name: "assign_self", arguments: args, _meta: meta });expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ ok: true, slot: "kherep-lead", revision: 1 });expect(a.challenges()).toBe(1);
      a.allowLead(false);expect((await client.callTool({ name: "assign_self", arguments: args, _meta: meta })).structuredContent).toEqual(result.structuredContent);
      expect(a.challenges()).toBe(1);
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
      const a = await source(), request = await a.intent("kherep-lead"), before = await registry().listIntercomSlots();
      if (fault === "expired") await runInDurableObject(registry(), (_instance, state) => {
        state.storage.sql.exec("UPDATE mcp_intents SET expires_at=0 WHERE request_id=?", request.requestId);
      });
      if (fault === "rotated") await registry().rotateMcpCredential(a.nodeId);
      if (fault === "revoked") await registry().revoke(a.nodeId, "synthetic");
      if (fault === "windows") await runInDurableObject(registry(), (_instance, state) => {
        state.storage.sql.exec("UPDATE nodes SET os='win32' WHERE id=?", a.nodeId);
      });
      expect((await registry().assignMcpSlot(request, "kherep-lead")).ok).toBe(false);
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
