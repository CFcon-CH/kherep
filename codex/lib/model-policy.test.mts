import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseModelPolicy, resolveModels, resolveCapabilities, validateCatalog } from "./model-policy.mts";

import { fixtureModels, fixtureResolution, policyText } from "./model-policy.fixture.mts";

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
