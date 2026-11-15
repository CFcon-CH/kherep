import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseModelPolicy, resolveModels, resolveCapabilities, validateCatalog } from "./model-policy.mts";

import { fixtureModels, fixtureResolution, policyText } from "./model-policy.fixture.mts";
import { buildAgentInventory } from "./model-agent-inventory.mts";
import { parseUserModelPolicy } from "./model-policy-user.mts";
import { buildCatalogSupport, resolveEffectiveSelections } from "./model-policy.mts";

const identityHash = "a".repeat(64);
const inventoryV2 = buildAgentInventory([{ sourcePath: "codex/agents/codex-obs.md", sourceProvider: "kherep",
  installedName: "custom-observer", role: "observer", sourceSha256: identityHash, securityPolicyDigest: identityHash,
  codeBound: false, capabilityKey: "claude-obs" }]);
const outside = { id: "runtime-alias", model: "visible-other", hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] };
const supportV2 = () => buildCatalogSupport({ complete: true, models: [...fixtureModels, outside] });

test("V2 permits visible out-of-family aliases and resolves role/agent fields independently", () => {
  const user = parseUserModelPolicy('{"roles":{"observer":{"model":"runtime-alias"}},"agents":{"codex-obs":{"effort":"high"}}}', inventoryV2);
  const result = resolveEffectiveSelections({ policy: parseModelPolicy(policyText), inventory: inventoryV2, user, catalog: supportV2() });
  assert.deepEqual(result.roles.observer.effective, { model: "visible-other", effort: "medium" });
  assert.deepEqual(result.agents[0]!.effective, { model: "visible-other", effort: "high" });
  assert.equal(result.agents[0]!.installedName, "custom-observer");
  assert.equal(result.agents[0]!.provenance.model.origin, "user-role");
  assert.equal(result.agents[0]!.provenance.effort.origin, "user-agent");
  assert.equal(result.agents[0]!.defaultRealization.model, "gpt-6-luna");
  assert.ok(result.supportedModels["visible-other"]);
});

test("V2 never substitutes inherited effort when an explicit model does not support it", () => {
  const user = parseUserModelPolicy('{"roles":{"builder":{"model":"visible-other"}}}', inventoryV2);
  const catalog = buildCatalogSupport({ complete: true, models: [...fixtureModels, { ...outside, supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] });
  assert.throws(() => resolveEffectiveSelections({ policy: parseModelPolicy(policyText), inventory: inventoryV2, user, catalog }), /unsupported-effort/);
  assert.throws(() => buildCatalogSupport({ complete: true, models: [...fixtureModels, { ...outside, id: fixtureModels[0]!.model }] }), /ambiguous-catalog-identity|duplicate/);
});

test("V2 retains both managed fields and separate defaults until refresh; explicit same-old fields stay explicit", () => {
  const binding = inventoryV2.agents[0]!;
  const previous = { selectionId: identityHash, roles: new Map([["observer" as const, { model: "gpt-6-luna", effort: "low" }]]),
    agents: new Map([[binding.bindingId, { ...binding, defaultRealization: { model: "gpt-6-luna", effort: "low" } }]]) };
  const user = parseUserModelPolicy('{"roles":{"observer":{"effort":"medium"}}}', inventoryV2);
  const input = { policy: parseModelPolicy(policyText), inventory: inventoryV2, user, catalog: supportV2(), retained: previous };
  const normal = resolveEffectiveSelections(input);
  assert.equal(normal.roles.observer.defaultRealization.effort, "low");
  assert.equal(normal.roles.observer.effective.effort, "medium");
  assert.equal(normal.roles.observer.provenance.effort.origin, "user-role");
  const deleted = resolveEffectiveSelections({ ...input, user: parseUserModelPolicy(undefined, inventoryV2) });
  assert.equal(deleted.agents[0]!.effective.effort, "low");
  assert.equal(resolveEffectiveSelections({ ...input, refresh: true }).roles.observer.defaultRealization.effort, "medium");
  assert.throws(() => resolveEffectiveSelections({ ...input, retained: { ...previous, agents: new Map([[binding.bindingId,
    { ...binding, role: "builder", defaultRealization: { model: "gpt-6-luna", effort: "low" } }]]) } }), /retained-binding-conflict/);
});

test("V2 metadata narrows eligibility but cannot manufacture catalog support", () => {
  const input = { policy: parseModelPolicy(policyText), inventory: inventoryV2, catalog: supportV2() };
  for (const text of ['{"models":{"not-visible":{"dispatchable":true}}}',
    '{"roles":{"observer":{"model":"visible-other"}},"models":{"visible-other":{"dispatchable":false}}}',
    '{"models":{"visible-other":{"efforts":["ultra"]}}}']) assert.throws(
    () => resolveEffectiveSelections({ ...input, user: parseUserModelPolicy(text, inventoryV2) }), /model-resolution:/);
});

test("V2 alias renames preserve source-bound retention and new agents use current defaults", () => {
  const original = inventoryV2.agents[0]!;
  const { sourceAgentId: _sourceAgentId, bindingId: _bindingId, ...source } = original;
  const inventory = buildAgentInventory([{ ...source, installedName: "renamed-observer" },
    { sourcePath: "codex/agents/new-observer.md", sourceProvider: "kherep", installedName: "new-observer",
      role: "observer", sourceSha256: identityHash, securityPolicyDigest: identityHash, codeBound: false }]);
  const retained = { selectionId: identityHash, roles: new Map([["observer" as const, { model: "gpt-6-luna", effort: "low" }]]),
    agents: new Map([[original.bindingId, { ...original, defaultRealization: { model: "gpt-6-luna", effort: "low" } }]]) };
  const result = resolveEffectiveSelections({ policy: parseModelPolicy(policyText), inventory, retained, catalog: supportV2(), user: parseUserModelPolicy(undefined, inventory) });
  assert.equal(result.agents.find(row => row.sourceAgentId === "codex-obs")!.effective.effort, "low");
  assert.equal(result.agents.find(row => row.sourceAgentId === "new-observer")!.effective.effort, "medium");
});

test("V2 explicit choices need no family default and unresolved masked defaults remain unresolved", () => {
  const roles = Object.fromEntries(["root", "designer", "builder", "support", "researcher", "observer", "broker"]
    .map(role => [role, { model: "runtime-alias", effort: "medium" }]));
  const user = parseUserModelPolicy(JSON.stringify({ roles }), inventoryV2);
  const result = resolveEffectiveSelections({ policy: parseModelPolicy(policyText), inventory: inventoryV2, user,
    catalog: buildCatalogSupport({ complete: true, models: [outside] }) });
  assert.equal(result.roles.observer.effective.model, "visible-other");
  assert.equal(result.roles.observer.defaultRealization.model, null);
  const retained = { selectionId: identityHash, roles: new Map([["observer" as const, { model: null, effort: "medium" }]]), agents: new Map() };
  assert.equal(resolveEffectiveSelections({ policy: parseModelPolicy(policyText), inventory: inventoryV2, user, catalog: supportV2(), retained }).roles.observer.defaultRealization.model, null);
  assert.throws(() => resolveEffectiveSelections({ policy: parseModelPolicy(policyText), inventory: inventoryV2,
    user: parseUserModelPolicy(undefined, inventoryV2), catalog: supportV2(), retained }), /unresolved-default-model/);
});

test("V2 never follows a reused catalog alias for a retained concrete model", () => {
  const retained = { selectionId: identityHash,
    roles: new Map([["observer" as const, { model: "retired-concrete", effort: "medium" }]]), agents: new Map() };
  const input = { policy: parseModelPolicy(policyText), inventory: inventoryV2, retained,
    catalog: buildCatalogSupport({ complete: true, models: [...fixtureModels, { ...outside, id: "retired-concrete" }] }) };
  assert.throws(() => resolveEffectiveSelections({ ...input, user: parseUserModelPolicy(undefined, inventoryV2) }), /retained-model-not-visible/);
  const explicit = parseUserModelPolicy('{"roles":{"observer":{"model":"retired-concrete"}}}', inventoryV2);
  assert.equal(resolveEffectiveSelections({ ...input, user: explicit }).roles.observer.effective.model, "visible-other");
});

test("V2 shipped-agent alias defaults record a canonical model, with user role precedence above agent defaults", () => {
  const binding = inventoryV2.agents[0]!.bindingId;
  const input = { policy: parseModelPolicy(policyText), inventory: inventoryV2, catalog: supportV2(),
    agentDefaults: new Map([[binding, { model: "runtime-alias", effort: "high" }]]) };
  const base = resolveEffectiveSelections({ ...input, user: parseUserModelPolicy(undefined, inventoryV2) });
  assert.equal(base.agents[0]!.defaultRealization.model, "visible-other");
  assert.equal(base.agents[0]!.provenance.model.origin, "shipped-agent");
  const user = parseUserModelPolicy('{"roles":{"observer":{"model":"gpt-6-luna","effort":"medium"}}}', inventoryV2);
  const actual = resolveEffectiveSelections({ ...input, user }).agents[0]!;
  assert.deepEqual(actual.effective, { model: "gpt-6-luna", effort: "medium" });
  assert.equal(actual.defaultRealization.effort, "high");
});

test("versionless role policy chooses available exact families and numerically newest generations", () => {
  const resolved = fixtureResolution();
  assert.equal(resolved.roles.designer.model, "gpt-6-astra");
  assert.equal(resolved.roles.builder.model, "gpt-6.10-sol");
  assert.equal(resolved.roles.observer.model, "gpt-6-luna");
  assert.deepEqual(resolved.roles.broker, { model: "gpt-6-luna", reasoning: "medium" });
  assert.equal(resolved.roles.root.reasoning, "xhigh");
  assert.match(resolved.policySha256, /^[a-f0-9]{64}$/);
  assert.equal(resolved.policySha256, createHash("sha256").update(policyText).digest("hex"));
  assert.match(resolved.catalogSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(policyText, /gpt-|\d+\.\d+/);
});

test("selects the newest generation supporting the requested effort without reducing that effort", () => {
  const catalog = fixtureModels.map((entry) => entry.model === "gpt-6.10-sol"
    ? { ...entry, supportedReasoningEfforts: [{ reasoningEffort: "low" }] } : entry);
  const resolved = resolveModels(parseModelPolicy(policyText), { complete: true, models: catalog });
  assert.equal(resolved.roles.builder.model, "gpt-6.9-sol");
  assert.equal(resolved.roles.builder.reasoning, "high");
  assert.equal(resolved.roles.root.reasoning, "xhigh");
});

test("support snapshot includes every measured visible exact configured-family member independently of defaults", () => {
  const row = (model: string, hidden = false) => ({ id: model, model, hidden,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }] });
  const older = { ...fixtureModels[1], id: "gpt-5.6-sol", model: "gpt-5.6-sol" };
  const resolution = resolveModels(parseModelPolicy(policyText), { complete: true, models: [...fixtureModels, older,
    row("gpt-5-sol"), row("gpt-4-sol", true), row("gpt-8-unknown"), row("gpt-8-sol-preview"),
  ] });
  assert.equal(resolution.roles.builder.model, "gpt-6.10-sol");
  assert.deepEqual(resolution.supportedModels[older.model], older.supportedReasoningEfforts.map((entry) => entry.reasoningEffort));
  assert.deepEqual(resolution.supportedModels["gpt-5-sol"], ["low"]);
  for (const model of ["gpt-4-sol", "gpt-8-unknown", "gpt-8-sol-preview", "gpt-99-sol"]) assert.equal(resolution.supportedModels[model], undefined);
});

test("visible exact members of families absent from the configured policy are excluded", () => {
  const policy = parseModelPolicy(policyText);
  policy.roles.support.family = "sol";
  policy.roles.researcher.family = "sol";
  const resolution = resolveModels(policy, { complete: true, models: fixtureModels });
  assert.equal(resolution.supportedModels["gpt-5.6-terra"], undefined);
  assert.ok(resolution.supportedModels["gpt-6.9-sol"]);
});

test("policy parser refuses unknown, duplicate, incomplete and invalid role settings", () => {
  for (const text of [policyText + '\nunknown = "x"', policyText + '\n[roles.builder]\nfamily = "sol"',
    policyText.replace('family = "astra"', 'family = "unknown"'),
    policyText.replace('reasoning = "xhigh"', 'reasoning = "extreme"'),
    policyText.replace(/\[roles\.broker\][\s\S]*$/, "")]) {
    assert.throws(() => parseModelPolicy(text), /policy/i);
  }
});

test("policy schema accepts TOML assignment whitespace without changing semantics", () => {
  assert.deepEqual(parseModelPolicy(policyText.replace("schema_version = 1", "schema_version=1")).roles,
    parseModelPolicy(policyText).roles);
});

test("catalog output and resolution hashes include only whitelisted model metadata", () => {
  const injected = { complete: true, accountDetail: "synthetic-private-top", models: fixtureModels.map((entry) => ({
    ...entry, accountDetail: "synthetic-private-entry", supportedReasoningEfforts: entry.supportedReasoningEfforts.map((effort) => ({
      ...effort, accountDetail: "synthetic-private-effort",
    })),
  })) };
  const sanitized = validateCatalog(injected);
  assert.deepEqual(sanitized, { complete: true, models: fixtureModels });
  assert.doesNotMatch(JSON.stringify(sanitized), /synthetic-private/);
  const policy = parseModelPolicy(policyText);
  assert.equal(resolveModels(policy, injected).catalogSha256, resolveModels(policy, { complete: true, models: fixtureModels }).catalogSha256);
});

test("resolution fails closed on incomplete, malformed, duplicate and missing catalog entries", () => {
  const policy = parseModelPolicy(policyText);
  for (const catalog of [{ complete: false, models: fixtureModels }, { complete: true, models: [] },
    { complete: true, models: [...fixtureModels, fixtureModels[0]] },
    { complete: true, models: fixtureModels.map((entry) => ({ ...entry, supportedReasoningEfforts: [] })) },
    { complete: true, models: fixtureModels.map((entry) => ({ ...entry, hidden: true })) },
    { complete: true, models: fixtureModels.map((entry) => ({ ...entry, model: entry.model + "-preview" })) }]) {
    assert.throws(() => resolveModels(policy, catalog), /catalog|model|reasoning/i);
  }
});

test("projection shares resolved roles and dispatch support without mutating source capabilities", () => {
  const source = { agents: { obs: { role: "observer", enforcePin: true }, builder: { role: "builder" }, "atlassian-broker": { role: "broker" } } };
  const result = resolveCapabilities(source as never, fixtureResolution());
  assert.equal(result.agents.obs.model, "gpt-6-luna");
  assert.equal(result.agents.obs.enforcePin, true);
  assert.equal(result.agents.builder.reasoning, "high");
  assert.deepEqual(result.agents["atlassian-broker"], { role: "broker", model: "gpt-6-luna", reasoning: "medium" });
  assert.deepEqual(source.agents["atlassian-broker"], { role: "broker" });
  assert.deepEqual(source.agents.obs, { role: "observer", enforcePin: true });
  assert.ok(result.modelResolution);
  assert.throws(() => resolveCapabilities({ agents: { x: { role: "missing" } } } as never, fixtureResolution()), /role/);
});

test("unsupported Luna Medium is attributed to broker when preceding roles are supported", () => {
  const policy = parseModelPolicy(policyText);
  policy.roles.observer.reasoning = "low";
  const catalog = { complete: true, models: fixtureModels.map(model => model.model.endsWith("-luna")
    ? { ...model, supportedReasoningEfforts: [{ reasoningEffort: "low" }] } : model) };
  assert.throws(() => resolveModels(policy, catalog), /role broker, family luna/);
});

// Issue #906: a trailing comment is cut from the first blank of its whitespace run.
test("trailing comments are ignored, and a lone CR inside a setting line still refuses it", () => {
  const commented = policyText.split("\n").map((line) => line === "schema_version = 1" ? `${line}   # c`
    : line.startsWith("[roles.") ? `${line} # c` : line.includes(" = ") ? `${line}\t#c` : line).join("\n");
  assert.deepEqual(parseModelPolicy(`# c\n${commented}`).roles, parseModelPolicy(policyText).roles);
  const setting = (suffix: string) => policyText.replace('family = "sol"', `family = "sol"${suffix}`);
  assert.deepEqual(parseModelPolicy(setting(" #x #y")).roles.root, { family: "sol", reasoning: "xhigh" });
  assert.throws(() => parseModelPolicy(setting(" #x\r #y")), /Invalid or duplicate model policy setting/);
  const started = performance.now();
  assert.throws(() => parseModelPolicy(`schema_version = 1\n${" ".repeat(50_000)}x\n`), /Invalid or duplicate model policy setting/);
  assert.ok(performance.now() - started < 200, "linear on a long blank run");
});
