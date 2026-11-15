import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentInventory } from "./model-agent-inventory.mts";
import { parseUserModelPolicy } from "./model-policy-user.mts";
const digest = "a".repeat(64);
const row = { sourcePath: "codex/agents/codex-obs.md", sourceProvider: "kherep", installedName: "installed-observer",
  capabilityKey: "claude-obs", role: "observer" as const, sourceSha256: digest, securityPolicyDigest: digest, codeBound: false };
const inventory = buildAgentInventory([row]);

test("missing and present empty layers retain distinct byte identity but identical empty semantics", () => {
  const absent = parseUserModelPolicy(undefined, inventory), empty = parseUserModelPolicy("{}", inventory);
  assert.equal(absent.present, false); assert.equal(absent.byteSha256, null);
  assert.equal(empty.present, true); assert.match(empty.byteSha256!, /^[a-f0-9]{64}$/);
  assert.equal(absent.semanticSha256, empty.semanticSha256);
  assert.throws(() => parseUserModelPolicy("", inventory), /invalid-json/);
});

test("fieldwise choices use source IDs and preserve exact bytes while semantic order is canonical", () => {
  const text = '{ "agents": {"codex-obs":{"effort":"high"}}, "roles":{"observer":{"model":"visible-other"}}, "models":{"visible-other":{"dispatchable":true,"efforts":["high","medium"]}} }';
  const before = text.slice();
  const parsed = parseUserModelPolicy(text, inventory);
  assert.deepEqual(parsed.agents.get("codex-obs"), { effort: "high" });
  assert.deepEqual(parsed.roles.get("observer"), { model: "visible-other" });
  assert.deepEqual(parsed.models.get("visible-other"), { dispatchable: true, efforts: ["high", "medium"] });
  assert.equal(text, before);
  const reordered = JSON.stringify({ models: { "visible-other": { efforts: ["medium", "high"], dispatchable: true } },
    roles: { observer: { model: "visible-other" } }, agents: { "codex-obs": { effort: "high" } }, schema_version: 1 });
  assert.equal(parsed.semanticSha256, parseUserModelPolicy(reordered, inventory).semanticSha256);
  assert.notEqual(parsed.byteSha256, parseUserModelPolicy(reordered, inventory).byteSha256);
  for (const key of ["installed-observer", "claude-obs", "removed-agent"]) assert.throws(
    () => parseUserModelPolicy(JSON.stringify({ agents: { [key]: { effort: "low" } } }), inventory), /unknown-source-agent/);
});

test("decoded duplicate keys, prototypes and authority fields fail with non-echoing diagnostics", () => {
  const bad = ['{"roles":{},"roles":{}}', String.raw`{"roles":{"observer":{"effort":"low","\u0065ffort":"high"}}}`,
    '{"__proto__":{}}', '{"roles":{"constructor":{}}}',
    ...["role", "source", "as", "tools", "sandbox", "permissions", "publication", "authority"].map(field =>
      JSON.stringify({ roles: { observer: { [field]: "SYNTHETIC_PRIVATE" } } }))];
  for (const text of bad) assert.throws(() => parseUserModelPolicy(text, inventory), error => {
    assert.match(String(error), /model-policy-user:/);
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE/);
    return true;
  });
});

test("invalid versions, types, names, effort metadata and bounded input fail closed", () => {
  for (const value of [null, [], false, 1, { schema_version: 2 }, { schema_version: "1" }, { unknown: 1 },
    { roles: [] }, { roles: { observer: null } }, { roles: { unknown: {} } },
    { roles: { observer: { model: "inherit" } } }, { roles: { observer: { model: "two tokens" } } },
    { roles: { observer: { effort: "extreme" } } }, { models: { x: { efforts: ["high", "high"] } } },
    { models: { x: { efforts: ["extreme"] } } }, { models: { x: { dispatchable: "yes" } } },
    { models: { x: { alias: "other" } } }]) assert.throws(() => parseUserModelPolicy(JSON.stringify(value), inventory), /model-policy-user:/);
  assert.throws(() => parseUserModelPolicy(" ".repeat(65_537), inventory), /input-size/);
  assert.throws(() => parseUserModelPolicy("[".repeat(20) + "0" + "]".repeat(20), inventory), /depth/);
});

test("same-basename providers make only that explicit agent override ambiguous", () => {
  const ambiguous = buildAgentInventory([row, { ...row, sourcePath: "plugins/other/agents/codex-obs.md", sourceProvider: "other@plugins", installedName: "other-observer" }]);
  assert.equal(parseUserModelPolicy('{"roles":{"observer":{"effort":"low"}}}', ambiguous).roles.get("observer")!.effort, "low");
  assert.throws(() => parseUserModelPolicy('{"agents":{"codex-obs":{"effort":"low"}}}', ambiguous), /ambiguous-source-agent-id/);
});
