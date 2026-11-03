import assert from "node:assert/strict";
import test from "node:test";
import { isSessionInfo } from "./protocol.mts";
import { currentIdentity, isCanonicalIdentity, isIdentitySnapshot, parseIdentityBinding } from "./protocol-session-identity.mts";
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const p = { version: 1, source: "codex-hook", runtime: "codex", sessionId, observedAt: 1000, lifecycleGeneration: 0 };
test("R04: strict receipt/header keys, versions, runtime, timestamp and generations", () => {
  assert.ok(isCanonicalIdentity(p));
  for (const v of [{ ...p, extra: true }, { ...p, version: 2 }, { ...p, source: "arbitrary" }, { ...p, runtime: "claude-code" }, { ...p, sessionId: "alias" }, { ...p, observedAt: NaN }, { ...p, lifecycleGeneration: -1 }]) assert.equal(isCanonicalIdentity(v), false);
  assert.equal(currentIdentity(p, { sessionId, runtime: "codex" }, 999), false);
  assert.equal(currentIdentity(p, { sessionId, runtime: "codex" }, 43_201_001), false);
  assert.equal(isSessionInfo({ sessionId, runtime: "claude-code", state: "running", canonicalIdentity: p }), false);
  assert.equal(isIdentitySnapshot({ version: 1, generation: 0 }), false);
  assert.equal(isIdentitySnapshot({ version: 1, generation: 1, extra: true }), false);
});
test("L08 M01: binding parsing is canonical, bounded, and carries no identifiers", () => {
  assert.deepEqual(parseIdentityBinding('[1,"codex",0,"claude-code",3]'), [1, "codex", 0, "claude-code", 3]);
  for (const x of ['[1, "codex",0,"claude-code",3]', '[1,"codex",-1,"codex",0]', '[2,"codex",0,"codex",0]', '[1,"codex",0,"codex",0,"extra"]', 'bad']) assert.equal(parseIdentityBinding(x), null);
});
