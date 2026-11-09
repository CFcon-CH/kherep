import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY, isMcpInboxRequestBody, isMcpIntentClaim,
  isMcpIntentRegistration, type McpIntentRegistration,
  isCodexActivityStamp, isCodexActivityRegistration,
  isMcpLeadConfirmRequest, isMcpLeadConfirmResponse,
} from "./protocol-mcp.mts";
import { isMcpIntentRegistration as legacyRegistration } from "./test/fixtures/protocol-mcp-pre-lead.mts";

const base = {
  requestId: "30000000-0000-4000-8000-000000000001",
  sessionId: "actual-session",
  callId: "actual-call",
  tool: "sessions",
  argumentsDigest: "a".repeat(64),
} as const;

test("Lead enriched proof is exact, slot-specific and refuses both mixed-version downgrades", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const queue = { ...base, runtime: "codex", sessionId, threadId: sessionId, tool: "assign_self",
    assignment: { slot: "kherep-lead", turnId: "synthetic-turn" } };
  const native = { sessionId, chatName: "Synthetic original", platform: "darwin", originalMain: true };
  const guarded = { ...queue, assignment: { ...queue.assignment, native: { ...native, leadGuardVersion: 1 } } };
  assert.equal(isMcpIntentRegistration(queue), true);
  assert.equal(isMcpIntentRegistration(guarded), true);assert.equal(legacyRegistration(guarded), false);
  assert.equal(isMcpIntentRegistration({ ...queue, assignment: { ...queue.assignment, native } }), false);
  for (const change of [{ leadGuardVersion: 2 }, { approved: true }, { transcriptPath: "/synthetic/override.jsonl" }]) {
    assert.equal(isMcpIntentRegistration({ ...guarded, assignment: { ...guarded.assignment, native: { ...guarded.assignment.native, ...change } } }), false);
  }
  assert.equal(isMcpIntentRegistration({ ...guarded, assignment: { ...guarded.assignment, slot: "codex-mac" } }), false);
  const request = { nonce: "22222222-2222-4222-8222-222222222222", nodeId: "33333333-3333-4333-8333-333333333333",
    requestId: base.requestId, sessionId, threadId: sessionId, turnId: "synthetic-turn", callId: base.callId, slot: "kherep-lead",
    argumentsDigest: base.argumentsDigest, credentialVersion: 1, leadGuardVersion: 1, expiresAt: 1000 };
  assert.equal(isMcpLeadConfirmRequest(request), true);
  for (const change of [{ nonce: base.requestId }, { slot: "codex-mac" }, { leadGuardVersion: 2 }, { approved: true }, { transcriptPath: "/synthetic" }, { threadId: "foreign" }])
    assert.equal(isMcpLeadConfirmRequest({ ...request, ...change }), false);
  assert.equal(isMcpLeadConfirmResponse({ nonce: request.nonce, allowed: true }), true);
  assert.equal(isMcpLeadConfirmResponse({ nonce: request.nonce, allowed: true, text: "forged" }), false);
  assert.equal(isMcpLeadConfirmResponse({ nonce: request.nonce, allowed: "true" }), false);
});

test("Claude MCP has a separate capability and accepts only native identity without a thread", () => {
  assert.equal(REMOTE_MCP_CAPABILITY, "mcp.messaging.v1");
  assert.equal(CLAUDE_MCP_CAPABILITY, "mcp.messaging.claude.v1");
  assert.equal(isMcpIntentRegistration({ ...base, runtime: "claude-code" }), true);
  assert.equal(isMcpIntentRegistration({ ...base, runtime: "claude-code", threadId: "invented-thread" }), false);
  assert.equal(isMcpIntentRegistration({ ...base, runtime: "claude-code", threadId: undefined }), false);
});

test("MCP intent registration rejects unknown runtimes and unbounded native identifiers", () => {
  assert.equal(isMcpIntentRegistration({ ...base, runtime: "other" }), false);
  for (const invalid of [
    { ...base, runtime: "claude-code", sessionId: "s".repeat(129) },
    { ...base, runtime: "claude-code", callId: "c".repeat(129) },
  ]) assert.equal(isMcpIntentRegistration(invalid), false);

  const codex: McpIntentRegistration = { ...base, runtime: "codex", threadId: "actual-thread" };
  assert.equal(isMcpIntentRegistration(codex), true);
});

test("MCP claims discriminate Codex identity from Claude call-only identity", () => {
  const common = { nodeId: "00000000-0000-4000-8000-0000000000aa", credentialVersion: 1,
    requestId: base.requestId, callId: base.callId, tool: base.tool, argumentsDigest: base.argumentsDigest };
  assert.equal(isMcpIntentClaim({ ...common, runtime: "claude-code" }), true);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "claude-code", sessionId: "forged" }), false);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "claude-code", threadId: "forged" }), false);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "codex", sessionId: base.sessionId, threadId: "actual-thread" }), true);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "codex", sessionId: base.sessionId }), false);
  assert.equal(isMcpIntentClaim({ ...common, runtime: "other" }), false);
});

test("MCP inbox requests default old frames to Codex and accept only known explicit runtimes", () => {
  const request = { requestId: base.requestId, sessionId: base.sessionId, limit: 10 };
  assert.equal(isMcpInboxRequestBody(request), true);
  assert.equal(isMcpInboxRequestBody({ ...request, runtime: "codex" }), true);
  assert.equal(isMcpInboxRequestBody({ ...request, runtime: "claude-code" }), true);
  assert.equal(isMcpInboxRequestBody({ ...request, runtime: "other" }), false);
});


test("Codex activity has strict disjoint local and enrolled full-population forms", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const intent = { ...base, runtime: "codex", sessionId, threadId: sessionId, tool: "assign_self", assignment: { slot: "codex-mac", turnId: "synthetic-turn" } };
    const local = { kind: "codex-activity-v1", observedAt: 1000, intent };
    assert.equal(isCodexActivityStamp(local), true);
    assert.equal(isMcpIntentRegistration(local), false);
    const enriched = { ...intent, assignment: { ...intent.assignment, native: { sessionId, chatName: "Synthetic original", platform: "darwin", originalMain: true } } };
    const wire = { ...local, intent: enriched, sessions: [{ sessionId, runtime: "codex", kind: "codex", state: "reachable-probable" }], identitySnapshot: { version: 1, generation: 2 } };
    assert.equal(isCodexActivityRegistration(wire), true);
    assert.equal(isCodexActivityStamp(wire), false);
    assert.equal(isMcpIntentRegistration(wire), false);
    assert.equal(legacyRegistration(wire), false);
    for (const changed of [{ ...wire, observedAt: -1 }, { ...wire, observedAt: 1.1 }, { ...wire, observedAt: Number.MAX_SAFE_INTEGER },
        { ...wire, kind: "codex-activity-v2" }, { ...wire, identitySnapshot: undefined }, { ...wire, identitySnapshot: { version: 1, generation: 0 } },
        { ...wire, identitySnapshot: { version: 1, generation: 2, complete: true } }, { ...wire, intent },
        { ...wire, intent: { ...enriched, ttlMs: 60000 } }, { ...wire, intent: { ...enriched, threadId: "foreign" } },
        { ...wire, intent: { ...enriched, assignment: { ...enriched.assignment, slot: "kherep-lead" } } },
        { ...wire, sessions: [...wire.sessions, ...wire.sessions] }, { ...wire, sessions: Array(513).fill(wire.sessions[0]) },
        { ...wire, requestId: base.requestId }, { ...wire, approved: true }])
        assert.equal(isCodexActivityRegistration(changed), false);
    for (const changed of [{ ...local, intent: enriched }, { ...local, observedAt: NaN }, { ...local, native: enriched.assignment.native },
        { ...local, intent: { ...intent, assignment: { ...intent.assignment, native: undefined } } }])
        assert.equal(isCodexActivityStamp(changed), false);
});
