import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { RegistrySessionIdentity } from "../src/registry-session-identity.mts";
import { authenticate, connect, enroll, FACTS, newKey, registry, until } from "./helpers.mts";
import { attestedPair, attestedRows, ID_A, ID_B } from "./message-loop-fixture.mts";
import { makeEnvelope, type SessionInfo } from "../../protocol.mts";
const query = <T,>(run: (sql: SqlStorage) => T) => runInDurableObject(registry(), (_i, state) => run(state.storage.sql));
const resolve = (n: string, ref = ID_A) => query(sql => new RegistrySessionIdentity(sql).resolveCanonicalReference({ nodeId: n, session: ref }, Date.now()));
it("R01 R07: attested snapshot reconciles receipt, exact and alias identically without public projection", async () => {
  const { nodeId } = await attestedPair();
  const exact = await resolve(nodeId), alias = await resolve(nodeId, "alias-0");
  if (!exact.address || !alias.address) throw new Error("synthetic attestation missing");
  const { match: exactMatch, ...exactIdentity } = exact, { match: aliasMatch, ...aliasIdentity } = alias;
  expect(exactMatch).toBe("exact"); expect(aliasMatch).toBe("alias"); expect(exactIdentity).toEqual(aliasIdentity); expect(exact).toMatchObject({ code: "ATTESTED", generation: 1, unknown: true });
  const directory = await registry().directory(); expect(JSON.stringify(directory)).not.toContain("canonicalIdentity");
});
it("R02: unauthenticated snapshots and cross-node body identities never replace sessions", async () => {
  const key = await newKey(), n = await enroll(key), other = await enroll(await newKey());
  const unauthenticated = await connect(n);
  unauthenticated.socket.send(makeEnvelope("sessions.snapshot", { sessions: attestedRows(), identitySnapshot: { version: 1, generation: 1 } }, 1, 0));
  expect((await unauthenticated.socket.closed).code).toBe(4400);
  expect((await registry().listSessions()).some(s => s.nodeId === n)).toBe(false);
  const socket = await authenticate(n, key);
  socket.send(makeEnvelope("sessions.snapshot", { nodeId: other, sessions: [{ sessionId: "synthetic", runtime: "codex", state: "running" }] }, 1, 0));
  socket.send(makeEnvelope("directory.get", {}, 2, 0)); await until(socket, "directory", {});
  expect((await registry().listSessions()).some(s => s.nodeId === other)).toBe(false);
  expect((await registry().listSessions()).some(s => s.nodeId === n && s.sessionId === "synthetic")).toBe(true);
  socket.ws.close(); await socket.closed;
});
it("R03 R05: old snapshot clears authority but preserves watermark; rollback and altered replay reject atomically", async () => {
  const { nodeId } = await attestedPair();
  const rows = attestedRows();
  await registry().replaceSessions(nodeId, rows, { version: 1, generation: 2 });
  expect(await registry().replaceSessions(nodeId, [{ ...rows[0], name: "changed" }, rows[1]], { version: 1, generation: 2 })).toMatchObject({ ok: false });
  expect(await registry().replaceSessions(nodeId, rows, { version: 1, generation: 1 })).toMatchObject({ ok: false });
  await registry().replaceSessions(nodeId, rows, { version: 1, generation: 2 });
  expect(await resolve(nodeId)).toMatchObject({ code: "ATTESTED", generation: 2 });
  await registry().replaceSessions(nodeId, rows.map(({ canonicalIdentity: _proof, ...r }) => r));
  expect(await resolve(nodeId)).toMatchObject({ code: "UNPROVEN", eligible: false });
  expect(await query(sql => sql.exec("SELECT identity_generation FROM nodes WHERE id=?", nodeId).one().identity_generation)).toBe(2);
});
it("R04: duplicates, conflicting runtime IDs and malformed proofs reject before any winner or watermark", async () => {
  const { nodeId } = await attestedPair(), rows = attestedRows();
  for (const bad of [[rows[0], rows[0]], [rows[0], { ...rows[0], runtime: "claude-code" }], [{ ...rows[0], canonicalIdentity: { ...rows[0].canonicalIdentity!, version: 2 } }]]) {
    expect(await registry().replaceSessions(nodeId, bad as SessionInfo[], { version: 1, generation: 2 })).toMatchObject({ ok: false });
    expect(await resolve(nodeId)).toMatchObject({ code: "ATTESTED", generation: 1 });
  }
});
it("R06: runtime registration, explicit Claude mapping, CLI kind and revocation are separate consistency checks", async () => {
  const { nodeId } = await attestedPair();
  for (const runtimes of [[], [{ name: "claude-code", kind: "cli" as const }], [{ name: "codex", kind: "local-endpoint" as const }]]) {
    await registry().replaceRuntimes(nodeId, runtimes); expect(await resolve(nodeId)).toMatchObject({ eligible: false, code: "RUNTIME_MISMATCH" });
  }
  const rows = attestedRows().map(s => ({ ...s, runtime: "claude-code", canonicalIdentity: { ...s.canonicalIdentity!, runtime: "claude-code" as const, source: "claude-list" as const } }));
  await registry().replaceSessions(nodeId, rows, { version: 1, generation: 2 });
  await registry().replaceRuntimes(nodeId, [{ name: "claude", kind: "cli" }]);
  expect(await resolve(nodeId)).toMatchObject({ code: "ATTESTED" });
  await registry().revoke(nodeId, "test"); expect((await resolve(nodeId)).eligible).toBe(false);
});
it("R08 R09 R10: exact refusal wins over aliases and ambiguous aliases count terminal rows", async () => {
  const { nodeId } = await attestedPair();
  const rows = attestedRows(); rows[1].name = ID_A; rows[0].state = "closed";
  await registry().replaceSessions(nodeId, rows, { version: 1, generation: 2 });
  expect(await resolve(nodeId)).toMatchObject({ code: "TERMINAL" });
  rows[0].name = "shared"; rows[1].name = "shared";
  await registry().replaceSessions(nodeId, rows, { version: 1, generation: 3 });
  expect(await resolve(nodeId, "shared")).toEqual({ address: null, eligible: false, code: "AMBIGUOUS" });
  expect(await resolve(nodeId, "missing")).toMatchObject({ code: "MISSING" });
  await query(sql => sql.exec("UPDATE sessions SET canonical_identity='{}' WHERE node_id=? AND session_id=?", nodeId, ID_B));
  expect(await resolve(nodeId, ID_B)).toMatchObject({ code: "INVALID_PROOF", eligible: false });
});
it("R11: two references to one canonical endpoint are a refused self pair", async () => {
  const { send } = await attestedPair();
  for (const target of [ID_A, "alias-0"]) {
    const r = await send(ID_A, target); expect(r.ok && r.status.reason).toBe("loop-lineage-unavailable");
    expect(r.ok && r.effects.deliveries).toEqual([]);
  }
});
it("P01: 512 rows use indexed exact/alias lookups and generation-only ticks write metadata once", async () => {
  const { nodeId } = await attestedPair();
  const rows = Array.from({ length: 512 }, (_, i) => ({ sessionId: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`, runtime: "codex", state: "unknown", name: `synthetic-${i}` }));
  await registry().replaceSessions(nodeId, rows, { version: 1, generation: 2 });
  await runInDurableObject(registry(), (instance, state) => {
    const sql = state.storage.sql, changes = () => Number(sql.exec("SELECT total_changes() AS n").one().n);
    const before = changes(); instance.replaceSessions(nodeId, rows, { version: 1, generation: 3 }); expect(changes() - before).toBe(1);
    instance.replaceSessions(nodeId, [...rows].reverse(), { version: 1, generation: 3 }); expect(changes() - before).toBe(1);
    for (const column of ["session_id", "name"]) expect(String(sql.exec(`EXPLAIN QUERY PLAN SELECT session_id FROM sessions WHERE node_id=? AND ${column}=? LIMIT 2`, nodeId, "synthetic").one().detail)).toContain("INDEX");
  });
});
it("S01: source-attested UNKNOWN still cannot register or claim native MCP", async () => {
  const { nodeId } = await attestedPair();
  await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli" }], ["messaging.v1", "messaging.loop-brake.v1", "mcp.messaging.v1"]);
  const intent = { runtime: "codex" as const, sessionId: ID_A, threadId: ID_A, requestId: crypto.randomUUID(), callId: "synthetic-call", argumentsDigest: "a".repeat(64), tool: "sessions" as const };
  expect(await registry().registerMcpIntent(nodeId, intent)).toEqual({ ok: false, error: "native session is not registered on this node" });
  const credential = await registry().rotateMcpCredential(nodeId); if (!credential.ok) throw new Error("synthetic setup failed");
  await registry().replaceSessions(nodeId, attestedRows().map(r => ({ ...r, state: "running" })), { version: 1, generation: 2 });
  expect((await registry().registerMcpIntent(nodeId, intent)).ok).toBe(true);
  await registry().replaceSessions(nodeId, attestedRows(), { version: 1, generation: 3 });
  expect(await registry().claimMcpIntent({ ...intent, nodeId, credentialVersion: credential.version })).toEqual({ ok: false, error: "native session is no longer registered" });
});
