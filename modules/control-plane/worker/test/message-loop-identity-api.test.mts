import { expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { connectionVerdict, handleLoopIdentityCheck, isSelectedPair } from "../src/message-loop-identity-api.mts";
import { authenticate, enroll, FACTS, newKey, registry, session, until, workerFetch } from "./helpers.mts";
import { attestedRows, BRAKE_CAPS, ID_A, ID_B } from "./message-loop-fixture.mts";
import { makeEnvelope } from "../../protocol.mts";
const selectors = [{ ref: ID_A, expectedSessionId: ID_A, expectedRuntime: "codex" }, { ref: ID_B, expectedSessionId: ID_B, expectedRuntime: "codex" }];
const request = (body: unknown) => new Request("https://control.example.com/api/message-loop/identity-check", { method: "POST", body: JSON.stringify(body) });
it("D01: one current authenticated connection brackets its accepted register and two canonical matches", async () => {
  const key = await newKey(), n = await enroll(key), socket = await authenticate(n, key);
  expect(await session(n).loopCapabilityEvidence()).toMatchObject({ registered: false, capability: false });
  socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }], capabilities: BRAKE_CAPS }, 1, 0));
  await vi.waitFor(async () => expect((await session(n).loopCapabilityEvidence()).registered).toBe(true));
  socket.send(makeEnvelope("sessions.snapshot", { sessions: attestedRows(), identitySnapshot: { version: 1, generation: 1 } }, 2, 0));
  await vi.waitFor(async () => expect((await registry().selectedLoopIdentityCheck({ nodeId: n, selectors: selectors as never })).samePairEligible).toBe(true));
  const response = await handleLoopIdentityCheck(request({ nodeId: n, selectors }), env);
  const b = await response.json() as Record<string, unknown>;
  expect(b).toMatchObject({ ok: true, code: "MEASURED", registryCapability: true, currentConnectionCapability: true, samePairEligible: true,
    endpointA: { attested: true, canonicalMatch: true, availabilityUnknown: true }, newRootRequired: true });
  expect(b.workerRevision).toBeNull(); // Test build has no exact immutable revision define.
  expect(JSON.stringify(b)).not.toContain(n); expect(JSON.stringify(b)).not.toContain(ID_A);
  socket.ws.close(); await socket.closed;
});
it("D02 S02: strict two-selector request rejects extra/list/wildcard input without reflection", async () => {
  const nodeId = "00000000-0000-4000-8000-000000000001";
  for (const body of [{ nodeId, selectors: [...selectors, selectors[0]] }, { nodeId, selectors: [selectors[0]] }, { nodeId, selectors, profile: "/synthetic/private-CANARY" },
    { nodeId, selectors: [{ ...selectors[0], ref: "*" }, selectors[1]] }, { nodeId: "CANARY", selectors }]) {
    expect(isSelectedPair(body)).toBe(false);
    const response = await handleLoopIdentityCheck(request(body), env); expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toMatch(/CANARY|profile|synthetic|selectors/);
  }
  const denied = await workerFetch("/api/message-loop/identity-check", { method: "POST", body: JSON.stringify({ nodeId, selectors }) });
  expect(denied.status).toBe(403);
});
it("D03: absent/unregistered/switched connection is UNKNOWN, never an inherited Hello", async () => {
  const n = await enroll(await newKey());
  await registry().updateRegistration(n, FACTS, [{ name: "codex", kind: "cli" }], BRAKE_CAPS);
  await registry().replaceSessions(n, attestedRows(), { version: 1, generation: 1 });
  const response = await handleLoopIdentityCheck(request({ nodeId: n, selectors }), env);
  expect(await response.json()).toMatchObject({ ok: false, code: "CONNECTION_UNPROVEN", currentConnectionCapability: "UNKNOWN", samePairEligible: false });
  const a = { token: "synthetic-a", registered: true, capability: true }, b = { ...a, token: "synthetic-b" };
  expect(connectionVerdict(a, b, a.token)).toBe("CONNECTION_CHANGED");
  expect(connectionVerdict(a, a, b.token)).toBe("CONNECTION_UNPROVEN");
  const first = await registry().selectedLoopIdentityCheck({ nodeId: n, selectors: selectors as never });
  await registry().replaceSessions(n, attestedRows(), { version: 1, generation: 2 });
  expect(await registry().selectedLoopIdentityUnchanged({ nodeId: n, selectors: selectors as never }, first.stamp)).toBe(false);
});
it("D04: nonexistent selected identities are measured false, not a full-inventory claim", async () => {
  const n = await enroll(await newKey());
  const result = await registry().selectedLoopIdentityCheck({ nodeId: n, selectors: selectors as never });
  expect(result.endpointA).toMatchObject({ canonicalMatch: false, attested: false, code: "MISSING" });
  expect(result.samePairEligible).toBe(false);
});
it("D03 D04 S02: context change and accessor exceptions return only fixed safe failures", async () => {
  const nodeId = "00000000-0000-4000-8000-000000000001";
  const endpoint = { canonicalMatch: true, attested: true, availabilityUnknown: true, code: "ATTESTED" };
  const selected = { stamp: "synthetic-stamp", registrationToken: "synthetic-token", registryCapability: true, endpointA: endpoint, endpointB: endpoint, samePairEligible: true };
  for (const mode of ["changed", "failed", "connection"] as const) {
    let evidenceReads = 0;
    const fake = {
      REGISTRY: { idFromName: () => "synthetic", get: () => ({ selectedLoopIdentityCheck: async () => { if (mode === "failed") throw new Error("/synthetic/PRIVATE_CANARY"); return selected; }, selectedLoopIdentityUnchanged: async () => mode === "connection" }) },
      NODE_SESSION: { idFromName: () => "synthetic", get: () => ({ loopCapabilityEvidence: async () => ({ token: mode === "connection" && evidenceReads++ > 0 ? "synthetic-new-token" : "synthetic-token", registered: true, capability: true }) }) },
    };
    const response = await handleLoopIdentityCheck(request({ nodeId, selectors }), fake as never);
    const b = await response.json(); expect(b).toMatchObject({ ok: false, code: mode === "changed" ? "CONTEXT_CHANGED" : mode === "connection" ? "CONNECTION_CHANGED" : "EVIDENCE_UNAVAILABLE", currentConnectionCapability: "UNKNOWN" });
    expect(JSON.stringify(b)).not.toMatch(/CANARY|synthetic|token|stamp|selectors/);
  }
});
