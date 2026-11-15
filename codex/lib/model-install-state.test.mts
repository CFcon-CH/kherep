import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelPolicy, resolveModels } from "./model-policy.mts";
import { selectModelResolution, planModelSelection, assertModelSelectionPreconditions } from "./model-install-state.mts";
import { buildAgentInventory } from "./model-agent-inventory.mts";
import { buildCatalogSupport } from "./model-policy.mts";
import { parseUserModelPolicy } from "./model-policy-user.mts";
import { createModelResolutionReceipt, dispatchModelSelection, verifyInstalledModelState, type ReceiptEvidence } from "./model-resolution-receipt.mts";
import { createHash } from "node:crypto";
import { fixtureModels, fixtureResolution, policyText } from "./model-policy.fixture.mts";
const digestV2 = "a".repeat(64), sourceV2 = "1".repeat(40);
const inventoryV2 = buildAgentInventory([{ sourcePath: "codex/agents/codex-obs.md", sourceProvider: "kherep", installedName: "codex-obs",
  role: "observer", securityPolicyDigest: digestV2, sourceSha256: digestV2, codeBound: false }]);
const catalogV2 = () => buildCatalogSupport({ complete: true, models: fixtureModels });
const renderV2 = (resolution: import("./model-policy.mts").EffectiveResolutionV2, id: string) => [
  ...resolution.agents.map(agent => ({ target: `agents/${agent.installedName}.toml`, kind: "agent-toml" as const, sourceBinding: agent.bindingId,
    content: `name = ${JSON.stringify(agent.installedName)}\nmodel = ${JSON.stringify(agent.effective.model)}\nmodel_reasoning_effort = ${JSON.stringify(agent.effective.effort)}\n` })),
  { target: "hooks/parity/capabilities.json", kind: "dispatch-snapshot" as const, sourceBinding: "dispatch", content: JSON.stringify(dispatchModelSelection(resolution, id)) }];
function installedV2() {
  const low = policyText.replace(/(\[roles\.observer\][\s\S]*?reasoning = )"medium"/, '$1"low"');
  const fresh = planModelSelection({ intent: "install", policyText: low, inventory: inventoryV2, userText: undefined,
    sourceRevision: sourceV2, catalog: catalogV2(), supportSource: "fresh-catalog", capturedAt: "2026-01-01T00:00:00Z",
    runtimeVersion: null, collectorVersion: null, renderOutputs: renderV2 });
  const text = JSON.stringify(fresh.receipt);
  const evidence: ReceiptEvidence = { context: { sourceRevision: sourceV2, previousSelectionId: null, supportSource: "fresh-catalog" },
    policyText: low, inventory: inventoryV2, user: parseUserModelPolicy(undefined, inventoryV2), catalog: catalogV2(),
    capturedAt: "2026-01-01T00:00:00Z", runtimeVersion: null, collectorVersion: null };
  const outputs = fresh.writes.map(row => ({ target: row.target, kind: row.kind, sourceBinding: row.sourceBinding, content: row.content }));
  return { state: verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: createHash("sha256").update(text).digest("hex"), evidence, actualOutputs: outputs }), outputs };
}

test("V2 planner retains managed pair, applies explicit same-default effort and refreshes only deliberately", () => {
  const { state, outputs } = installedV2();
  const input = { intent: "install" as const, policyText, inventory: inventoryV2, sourceRevision: "2".repeat(40),
    existing: state, currentOutputs: outputs, userText: undefined, capturedAt: "2026-02-01T00:00:00Z", runtimeVersion: null, collectorVersion: null, renderOutputs: renderV2 };
  const retained = planModelSelection(input);
  assert.equal(retained.receipt.resolution.agents[0]!.effective.effort, "low");
  assert.throws(() => planModelSelection({ ...input, userText: '{"roles":{"observer":{"effort":"medium"}}}' }), /fresh-catalog-required/);
  const applied = planModelSelection({ ...input, intent: "apply", catalog: catalogV2(), supportSource: "fresh-catalog", userText: '{"roles":{"observer":{"effort":"medium"}}}' });
  assert.equal(applied.receipt.resolution.roles.observer.effective.effort, "medium");
  assert.equal(applied.receipt.resolution.roles.observer.defaultRealization.effort, "low");
  const refreshed = planModelSelection({ ...input, intent: "refresh", catalog: catalogV2(), supportSource: "fresh-catalog" });
  assert.equal(refreshed.receipt.resolution.roles.observer.defaultRealization.effort, "medium");
});

test("V2 planner preserves input bytes, detects concurrent edits and plans rollback only for managed outputs", () => {
  const { state, outputs } = installedV2();
  const userText = '{ "agents": {"codex-obs":{"effort":"high"}} }', before = userText.slice();
  const input = { intent: "apply" as const, policyText, inventory: inventoryV2, sourceRevision: sourceV2, existing: state,
    currentOutputs: outputs, userText, catalog: catalogV2(), supportSource: "fresh-catalog" as const,
    capturedAt: "2026-02-01T00:00:00Z", runtimeVersion: null, collectorVersion: null, renderOutputs: renderV2 };
  const plan = planModelSelection(input);
  assert.equal(userText, before);
  assertModelSelectionPreconditions(plan, userText, outputs);
  assert.throws(() => assertModelSelectionPreconditions(plan, userText + " ", outputs), /user-input-changed/);
  assert.throws(() => assertModelSelectionPreconditions(plan, userText, outputs.map(row => ({ ...row, content: "edited" }))), /output-precondition-conflict/);
  assert.equal(plan.rollback.userFile, "never-write");
  assert.ok(plan.rollback.restore.every(row => !row.target.includes("model-policy.user")));
  assert.throws(() => planModelSelection({ ...input, renderOutputs: () => { throw new Error("SYNTHETIC_PRIVATE"); } }), /render-failed/);
});

test("V2 unchanged offline install is a no-op and never invokes a renderer", () => {
  const { state, outputs } = installedV2();
  const oldText = policyText.replace(/(\[roles\.observer\][\s\S]*?reasoning = )"medium"/, '$1"low"');
  const plan = planModelSelection({ intent: "install", policyText: oldText, inventory: inventoryV2, sourceRevision: sourceV2,
    userText: undefined, existing: state, currentOutputs: outputs, capturedAt: "2026-01-01T00:00:00Z", runtimeVersion: null, collectorVersion: null,
    renderOutputs: () => { throw new Error("must not render"); } });
  assert.equal(plan.selectionId, state.selectionId);
  assert.equal(plan.writes.length, 0); assert.equal(plan.deletions.length, 0);
});

test("V2 override deletion returns the recorded default and drift never substitutes a pair", () => {
  const { state, outputs } = installedV2();
  const userText = '{"agents":{"codex-obs":{"effort":"high"}}}';
  const input = { intent: "apply" as const, policyText, inventory: inventoryV2, sourceRevision: sourceV2, existing: state,
    currentOutputs: outputs, userText, catalog: catalogV2(), supportSource: "fresh-catalog" as const,
    capturedAt: "2026-02-01T00:00:00Z", runtimeVersion: null, collectorVersion: null, renderOutputs: renderV2 };
  const applied = planModelSelection(input);
  const current = applied.writes.map(({ target, kind, sourceBinding, content }) => ({ target, kind, sourceBinding, content }));
  const text = JSON.stringify(applied.receipt), evidence: ReceiptEvidence = {
    context: { sourceRevision: sourceV2, previousSelectionId: state.selectionId, supportSource: "fresh-catalog" },
    policyText, inventory: inventoryV2, user: parseUserModelPolicy(userText, inventoryV2), catalog: catalogV2(), retained: state.retained, predecessor: state,
    capturedAt: input.capturedAt, runtimeVersion: null, collectorVersion: null };
  const updated = verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: createHash("sha256").update(text).digest("hex"), evidence, actualOutputs: current });
  assert.equal(planModelSelection({ ...input, existing: updated, currentOutputs: current, userText: undefined }).receipt.resolution.agents[0]!.effective.effort, "low");
  const drift = buildCatalogSupport({ complete: true, models: fixtureModels.map(row => row.model.endsWith("-luna")
    ? { ...row, supportedReasoningEfforts: [{ reasoningEffort: "medium" }] } : row) });
  assert.throws(() => planModelSelection({ ...input, catalog: drift, userText: undefined }), /unsupported-effort/);
  const changed = buildAgentInventory([{ sourcePath: "codex/agents/codex-obs.md", sourceProvider: "kherep", installedName: "codex-obs",
    role: "observer", securityPolicyDigest: "b".repeat(64), sourceSha256: digestV2, codeBound: false }]);
  assert.throws(() => planModelSelection({ ...input, inventory: changed }), /retained-binding-conflict/);
});

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
