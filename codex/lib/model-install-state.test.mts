import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelPolicy, resolveModels } from "./model-policy.mts";
import { selectModelResolution } from "./model-install-state.mts";
import { fixtureModels, fixtureResolution, policyText } from "./model-policy.fixture.mts";

test("normal reinstall retains its verified resolution even when a newer catalog is supplied", () => {
  const existing = fixtureResolution();
  const catalog = { complete: true, models: [...fixtureModels, { ...fixtureModels[1], id: "gpt-7-sol", model: "gpt-7-sol" }] };
  assert.deepEqual(selectModelResolution(policyText, { existing, catalog }), existing);
  assert.equal(selectModelResolution(policyText, { existing, catalog, refresh: true }).roles.builder.model, "gpt-7-sol");
});

test("first install and refresh require complete catalog evidence before any projection writes", () => {
  assert.throws(() => selectModelResolution(policyText), /complete model catalog/);
  assert.throws(() => selectModelResolution(policyText, { existing: fixtureResolution(), refresh: true }), /complete model catalog/);
  assert.equal(selectModelResolution(policyText, { catalog: { complete: true, models: fixtureModels } }).roles.designer.model, "gpt-6-astra");
});

test("corrupt or stale persisted resolution fails closed rather than silently selecting new models", () => {
  const existing = fixtureResolution();
  for (const value of [{ ...existing, policySha256: "0".repeat(64) }, { ...existing, roles: {} },
    { ...existing, supportedModels: {} }, { ...existing, catalogSha256: "broken" }]) {
    assert.throws(() => selectModelResolution(policyText, { existing: value }), /resolution/);
  }
});

test("Observer Low policy requires explicit refresh to Medium, with reverse stale-source refusal", () => {
  assert.equal(parseModelPolicy(policyText).roles.observer.reasoning, "medium");
  const lowText = policyText.replace(/(\[roles\.observer\]\s+family = "luna"\s+reasoning = )"medium"/, '$1"low"');
  const oldPolicy = parseModelPolicy(lowText), currentPolicy = parseModelPolicy(policyText);
  assert.equal(oldPolicy.roles.observer.reasoning, "low");
  for (const role of ["root", "designer", "builder", "support", "researcher", "broker"] as const)
    assert.deepEqual(currentPolicy.roles[role], oldPolicy.roles[role]);
  const catalog = { complete: true, models: structuredClone(fixtureModels) };
  const low = resolveModels(oldPolicy, catalog);
  assert.equal(low.roles.observer.reasoning, "low");
  assert.deepEqual(selectModelResolution(lowText, { existing: low }), low);
  assert.throws(() => selectModelResolution(policyText, { existing: low, catalog }), /explicit refresh/);
  const medium = selectModelResolution(policyText, { existing: low, catalog, refresh: true });
  assert.equal(medium.roles.observer.reasoning, "medium");
  assert.equal(medium.roles.observer.model, low.roles.observer.model);
  assert.deepEqual(selectModelResolution(policyText, { existing: medium, catalog }), medium);
  assert.throws(() => selectModelResolution(lowText, { existing: medium, catalog }), /explicit refresh/);
});

test("Observer Medium is never downgraded when the visible Luna model supports only Low", () => {
  const catalog = { complete: true, models: fixtureModels.map(model => model.model.endsWith("-luna")
    ? { ...model, supportedReasoningEfforts: [{ reasoningEffort: "low" }] } : model) };
  assert.throws(() => selectModelResolution(policyText, { catalog, refresh: true }), /role observer, family luna/);
});

test("Broker Low policy requires explicit refresh and retains Medium on ordinary reinstall", () => {
  const lowText = policyText.replace(/(\[roles\.broker\]\s+family = "luna"\s+reasoning = )"medium"/, '$1"low"');
  const oldPolicy = parseModelPolicy(lowText), currentPolicy = parseModelPolicy(policyText);
  assert.equal(oldPolicy.sourceSha256, "e0ad1f9e2f1a657f27b8a9b29e9983b15cf517859cae3531276e46d3a05bd615");
  assert.equal(oldPolicy.roles.broker.reasoning, "low");
  assert.equal(currentPolicy.roles.broker.reasoning, "medium");
  const catalog = { complete: true, models: structuredClone(fixtureModels) };
  const low = resolveModels(oldPolicy, catalog);
  assert.deepEqual(selectModelResolution(lowText, { existing: low }), low);
  assert.throws(() => selectModelResolution(policyText, { existing: low, catalog }), /explicit refresh/);
  const medium = selectModelResolution(policyText, { existing: low, catalog, refresh: true });
  assert.deepEqual(medium.roles.broker, { model: low.roles.broker.model, reasoning: "medium" });
  for (const role of ["root", "designer", "builder", "support", "researcher", "observer"] as const) {
    assert.deepEqual(currentPolicy.roles[role], oldPolicy.roles[role]);
    assert.deepEqual(medium.roles[role], low.roles[role]);
  }
  assert.deepEqual(medium.supportedModels, low.supportedModels);
  assert.equal(medium.catalogSha256, low.catalogSha256);
  catalog.models.push({ ...catalog.models[4], id: "gpt-7-luna", model: "gpt-7-luna" });
  assert.equal(selectModelResolution(policyText, { existing: medium, catalog }), medium);
  assert.throws(() => selectModelResolution(lowText, { existing: medium, catalog }), /explicit refresh/);
});
