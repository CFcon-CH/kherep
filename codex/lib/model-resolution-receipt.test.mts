import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentInventory } from "./model-agent-inventory.mts";
import { parseUserModelPolicy } from "./model-policy-user.mts";
import { buildCatalogSupport, parseModelPolicy, resolveModels, resolveEffectiveSelections } from "./model-policy.mts";
import { modelSelectionId, createModelOutputManifest, verifyModelOutputManifest, createModelResolutionReceipt,
  verifyInstalledModelState, dispatchModelSelection, assertVerifiedModelState, type ReceiptEvidence } from "./model-resolution-receipt.mts";
import { createObserverModelOverlay, observerOverlaySnapshot, verifyObserverModelOverlay, type ObserverOverlayAuthority } from "./model-resolution-receipt.mts";
import { createHash } from "node:crypto";
import { fixtureModels, policyText } from "./model-policy.fixture.mts";
import { renderAgent } from "./component-render.mts";
import { planModelSelection } from "./model-install-state.mts";
const h = "a".repeat(64);
const inventory = buildAgentInventory([{ sourcePath: "codex/agents/codex-obs.md", sourceProvider: "kherep", installedName: "observer-alias",
  role: "observer", securityPolicyDigest: h, sourceSha256: h, codeBound: false }]);
const resolution = resolveEffectiveSelections({ policy: parseModelPolicy(policyText), inventory,
  catalog: buildCatalogSupport({ complete: true, models: fixtureModels }), user: parseUserModelPolicy(undefined, inventory) });
const context = { sourceRevision: "1".repeat(40), previousSelectionId: null, supportSource: "fresh-catalog" as const };
const outputs = [{ target: "agents/observer-alias.toml", kind: "agent-toml" as const, sourceBinding: inventory.agents[0]!.bindingId, content: "synthetic agent bytes\n" },
  { target: "hooks/parity/capabilities.json", kind: "dispatch-snapshot" as const, sourceBinding: "dispatch", content: "synthetic snapshot bytes\n" }];
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function evidence(): ReceiptEvidence {
  return { context, policyText, inventory, catalog: buildCatalogSupport({ complete: true, models: fixtureModels }),
    user: parseUserModelPolicy(undefined, inventory), capturedAt: "2026-01-01T00:00:00.000Z", runtimeVersion: null, collectorVersion: null };
}
function rendered(e = evidence()) {
  const current = resolveEffectiveSelections({ policy: parseModelPolicy(e.policyText), inventory: e.inventory, catalog: e.catalog, user: e.user,
    retained: e.retained, agentDefaults: e.agentDefaults, refresh: e.refresh });
  const id = modelSelectionId(current, e.context);
  return [...current.agents.map(agent => ({ target: `agents/${agent.installedName}.toml`, kind: "agent-toml" as const,
    sourceBinding: agent.bindingId, content: `name = ${JSON.stringify(agent.installedName)}\nmodel = ${JSON.stringify(agent.effective.model)}\nmodel_reasoning_effort = ${JSON.stringify(agent.effective.effort)}\n` })),
  { target: "hooks/parity/capabilities.json", kind: "dispatch-snapshot" as const, sourceBinding: "dispatch", content: JSON.stringify(dispatchModelSelection(current, id)) }];
}

test("canonical selection identity excludes output bytes and cannot acquire a hash cycle", () => {
  const id = modelSelectionId(resolution, context);
  const first = createModelOutputManifest(outputs, id, inventory);
  const second = createModelOutputManifest(outputs.map(row => ({ ...row, content: row.content + "changed" })), id, inventory);
  assert.notEqual(first[0]!.sha256, second[0]!.sha256);
  assert.equal(first[0]!.selectionId, id);
  assert.equal(modelSelectionId(resolution, context), id);
  const reordered = Object.fromEntries(Object.entries(resolution).reverse());
  assert.equal(modelSelectionId(reordered as typeof resolution, context), id);
  const changed = structuredClone(resolution); changed.roles.observer.effective.effort = "high";
  assert.notEqual(modelSelectionId(changed, context), id);
  assert.throws(() => modelSelectionId(resolution, { ...context, capturedAt: "synthetic" } as typeof context), /unknown-identity-field/);
});

test("exact output evidence detects manual edits, conflicting bindings and partial generations without writes", () => {
  const id = modelSelectionId(resolution, context), before = structuredClone(outputs);
  const expected = createModelOutputManifest(outputs, id, inventory);
  verifyModelOutputManifest(expected, outputs, id, inventory);
  assert.deepEqual(outputs, before);
  assert.throws(() => verifyModelOutputManifest(expected, outputs.map((row, i) => i ? row : { ...row, content: "manual edit" }), id, inventory), /output-conflict/);
  assert.throws(() => createModelOutputManifest(outputs.slice(1), id, inventory), /incomplete-output-generation/);
  assert.throws(() => createModelOutputManifest([...outputs, outputs[0]!], id, inventory), /duplicate-output-target/);
  assert.throws(() => createModelOutputManifest([{ ...outputs[0]!, target: "agents/other.toml" }, outputs[1]!], id, inventory), /output-binding-conflict/);
  assert.throws(() => createModelOutputManifest([{ ...outputs[0]!, target: "../outside" }, outputs[1]!], id, inventory), /invalid-output-target/);
  assert.throws(() => verifyModelOutputManifest(expected.map(row => ({ ...row, sha256: "0".repeat(64) })), outputs, id, inventory), /output-conflict/);
});

test("dispatch outputs cannot certify user-owned or arbitrary targets, even without agents", () => {
  const empty = buildAgentInventory([]), id = "a".repeat(64);
  const proper = [{ target: "hooks/parity/capabilities.json", kind: "dispatch-snapshot" as const, sourceBinding: "dispatch", content: "synthetic" }];
  const expected = createModelOutputManifest(proper, id, empty);
  verifyModelOutputManifest(expected, proper, id, empty);
  for (const target of ["kherep/model-policy.user.json", "orchestra/unrelated.json", "agents/unowned.toml"]) {
    const wrong = [{ ...proper[0]!, target }];
    assert.throws(() => createModelOutputManifest(wrong, id, empty), /output-binding-conflict/);
    assert.throws(() => verifyModelOutputManifest([{ ...expected[0]!, target }], wrong, id, empty), /output-binding-conflict/);
  }
});

test("V2 receipt replays committed selections without reading a current user layer", () => {
  const e = evidence(), actual = rendered(e), receipt = createModelResolutionReceipt(e, actual);
  assert.deepEqual(receipt.migration, { kind: "fresh", status: "not-required" });
  const text = JSON.stringify(receipt), before = structuredClone(actual);
  const state = verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text), evidence: { ...e, user: undefined }, actualOutputs: actual });
  assert.equal(state.selectionId, receipt.selectionId);
  assert.equal(state.retained.roles.get("observer")!.effort, "medium");
  assert.equal(receipt.catalog.runtimeVersion.status, "UNKNOWN");
  assert.deepEqual(actual, before);
  const later = createModelResolutionReceipt({ ...e, capturedAt: "2026-02-01T00:00:00.000Z" }, actual);
  assert.equal(later.selectionId, receipt.selectionId);
});

test("V2 rejects forged generations, duplicated JSON fields and mismatched independent evidence", () => {
  const e = evidence(), actual = rendered(e), receipt = createModelResolutionReceipt(e, actual);
  const verify = (value: unknown, rows = actual) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text), evidence: e, actualOutputs: rows });
  };
  for (const mutate of [
    (copy: typeof receipt) => { copy.resolution.roles.observer.effective.effort = "unsupported"; },
    (copy: typeof receipt) => { copy.resolution.agents[0]!.securityPolicyDigest = "0".repeat(64); },
    (copy: typeof receipt) => { copy.inputs.sourceRevision = "2".repeat(40); },
    (copy: typeof receipt) => { copy.catalog.digest = "0".repeat(64); },
    (copy: typeof receipt) => { copy.migration = { kind: "fresh", status: "unverified" } as unknown as typeof copy.migration; },
  ]) { const copy = structuredClone(receipt); mutate(copy); assert.throws(() => verify(copy), /model-receipt:/); }
  assert.throws(() => verify(JSON.stringify(receipt).replace('"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2')), /duplicate-key/);
  assert.throws(() => verify({ ...receipt, permissions: ["all"] }), /model-receipt:/);
  assert.throws(() => verify(receipt, actual.map((row, i) => i ? row : { ...row, content: row.content.replace('"medium"', '"low"') })), /model-receipt:/);
  const mixed = actual.map(row => row.kind === "dispatch-snapshot" ? { ...row, content: row.content.replace(receipt.selectionId, "0".repeat(64)) } : row);
  assert.throws(() => createModelResolutionReceipt(e, mixed), /snapshot-generation-conflict/);
});

test("managed agent fields must be real root TOML assignments in the exact safe renderer grammar", () => {
  const e = evidence(), actual = rendered(e), good = actual[0]!;
  const bad = [
    good.content.replace(/^model =/m, "[other]\nmodel ="),
    good.content.replace(/^model =/m, "  model ="),
    good.content.replace(/^model =/m, '"model" ='),
    good.content + 'model = "gpt-6-luna"\n',
    good.content + '[other]\nunknown = "value"\n',
    `developer_instructions = '''\n${good.content}'''\n`,
    good.content + 'invalid TOML\n',
    good.content.replace(/^name =/m, "# name ="),
  ];
  for (const content of bad) assert.throws(() => createModelResolutionReceipt(e, [{ ...good, content }, actual[1]!]), /agent-generation-conflict/);
  const text = JSON.stringify(createModelResolutionReceipt(e, actual));
  assert.throws(() => verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text), evidence: e,
    actualOutputs: [{ ...good, content: bad[0]! }, actual[1]!] }), /agent-generation-conflict/);
  const harmless = { ...good, content: good.content + `developer_instructions = ${JSON.stringify('example: model = "unrelated"\n[other]')}\n` };
  // A JSON-quoted instruction is one root string, never executable TOML fields.
  assert.doesNotThrow(() => createModelResolutionReceipt(e, [harmless, actual[1]!]));
  const agent = resolution.agents[0]!;
  const native = renderAgent(agent.installedName, '---\ndescription: "Unicode café and model text"\n---\nInstructions: model = "example"\n[other]\nUnicode: Grüße 😀\n',
    { model: agent.effective.model, reasoning: agent.effective.effort, sandbox: "read-only" });
  assert.doesNotThrow(() => createModelResolutionReceipt(e, [{ ...good, content: native }, actual[1]!]));
});

test("V1 migration requires independently pinned old evidence and never renders historical bytes", () => {
  const oldText = policyText.replace(/(\[roles\.observer\][\s\S]*?reasoning = )"medium"/, '$1"low"');
  const old = { ...resolveModels(parseModelPolicy(oldText), { complete: true, models: fixtureModels }), resolvedAt: "2025-01-01T00:00:00Z" };
  const resolutionText = JSON.stringify(old);
  // These are captured synthetic predecessor bytes, deliberately not current TOML.
  const actual = outputs.map(row => ({ ...row, content: `old recorded ${row.kind} bytes\n` }));
  const outputHashes = createModelOutputManifest(actual, h, inventory).map(({ selectionId: _id, ...row }) => row);
  const recorded = { schemaVersion: 1, sourceRevision: "2".repeat(40), policySha256: old.policySha256,
    catalogSha256: old.catalogSha256, resolutionSha256: hash(resolutionText), inventoryDigest: inventory.digest, outputs: outputHashes,
    roleDefaults: Object.fromEntries(Object.entries(old.roles).map(([role, pair]) => [role, { model: pair.model, effort: pair.reasoning }])),
    agents: [{ bindingId: inventory.agents[0]!.bindingId, effective: { model: old.roles.observer.model, effort: "low" },
      defaultRealization: { model: old.roles.observer.model, effort: "low" } }] };
  const evidenceText = JSON.stringify(recorded), expectedEvidenceSha256 = hash(evidenceText);
  const input = { kind: "v1" as const, resolutionText, policyText: oldText, catalog: { complete: true, models: fixtureModels },
    inventory, actualOutputs: actual, evidenceText, expectedEvidenceSha256 };
  const state = verifyInstalledModelState(input);
  assert.equal(state.sourceVersion, 1);
  assert.equal(state.retained.roles.get("observer")!.effort, "low");
  assert.throws(() => verifyInstalledModelState({ ...input, evidenceText: undefined }), /migration-evidence-insufficient/);
  assert.throws(() => verifyInstalledModelState({ ...input, expectedEvidenceSha256: "0".repeat(64) }), /migration-evidence-conflict/);
  assert.throws(() => verifyInstalledModelState({ ...input, policyText }), /legacy-policy-conflict/);
  assert.throws(() => verifyInstalledModelState({ ...input, actualOutputs: actual.map((row, i) => i ? row : { ...row, content: "manual edit" }) }), /output-conflict/);
  const forgedInventory = { ...inventory, agents: inventory.agents.map(agent => ({ ...agent, role: "builder" as const })) };
  assert.throws(() => verifyInstalledModelState({ ...input, inventory: forgedInventory }), /inventory.*conflict/);
  for (const mutate of [
    (copy: typeof recorded) => { delete (copy as Partial<typeof recorded>).roleDefaults; },
    (copy: typeof recorded) => { delete (copy.roleDefaults as Partial<typeof recorded.roleDefaults>).observer; },
    (copy: typeof recorded) => { copy.agents = []; },
    (copy: typeof recorded) => { copy.agents[0]!.effective.effort = "unsupported"; },
    (copy: typeof recorded) => { copy.inventoryDigest = "0".repeat(64); },
  ]) {
    const copy = structuredClone(recorded); mutate(copy);
    const edited = JSON.stringify(copy);
    assert.throws(() => verifyInstalledModelState({ ...input, evidenceText: edited, expectedEvidenceSha256: hash(edited) }), /model-receipt:|unsupported-effort/);
  }
  // Independently recorded synthetic predecessor bytes, not a current-renderer
  // reconstruction. The verifier receives the old bytes and a separate record.
  const captured = [{ ...actual[0]!, content: 'name = "observer-alias"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\ndeveloper_instructions = "old instructions"\n' },
    { ...actual[1]!, content: '{"legacyCapabilities":{"preserve":"exact"}}' }];
  const capturedRecord = { ...recorded, outputs: createModelOutputManifest(captured, h, inventory).map(({ selectionId: _id, ...row }) => row) };
  const capturedText = JSON.stringify(capturedRecord);
  const capturedInput = { ...input, actualOutputs: captured, evidenceText: capturedText, expectedEvidenceSha256: hash(capturedText) };
  const legacy = verifyInstalledModelState(capturedInput), agent = inventory.agents[0]!;
  const updated = { ...captured[0]!, content: captured[0]!.content.replace('"old instructions"', '"new instructions"') };
  const authority: ObserverOverlayAuthority = { bindingId: agent.bindingId, sourceAgentId: agent.sourceAgentId, sourcePath: agent.sourcePath,
    sourceProvider: agent.sourceProvider, installedName: agent.installedName, role: "observer", securityPolicyDigest: agent.securityPolicyDigest,
    sourceRevision: "3".repeat(40), sourceSha256: hash("new public source"), expectedObserverSha256: hash(updated.content) };
  const next = [updated, { ...captured[1]!, content: observerOverlaySnapshot(captured[1]!.content, legacy, authority) }];
  const overlay = createObserverModelOverlay({ base: legacy, authority, predecessorOutputs: captured, outputs: next }), overlayText = JSON.stringify(overlay);
  const composed = verifyInstalledModelState({ ...capturedInput, actualOutputs: next,
    overlays: [{ authority, predecessorOutputs: captured, overlayText, expectedOverlaySha256: hash(overlayText) }] });
  assert.equal(composed.sourceVersion, 1);
  assert.equal(composed.selectionId, legacy.selectionId);
  assert.equal(composed.resolution.agents[0]!.effective.effort, "low");
  assert.deepEqual(JSON.parse(next[1]!.content).legacyCapabilities, { preserve: "exact" });
  const planned = planModelSelection({ intent: "install", policyText, inventory, userText: undefined, sourceRevision: context.sourceRevision,
    existing: legacy, currentOutputs: captured, catalog: eCatalog(), supportSource: "fresh-catalog", capturedAt: null,
    runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan });
  assert.equal(planned.receipt.migration.kind, "predecessor");
  if (planned.receipt.migration.kind === "predecessor") {
    assert.equal(planned.receipt.migration.sourceVersion, 1);
    assert.equal(planned.receipt.migration.oldPolicySha256, old.policySha256);
    assert.equal(planned.receipt.migration.oldCatalogSha256, old.catalogSha256);
    assert.equal(planned.receipt.migration.originEvidenceSha256, hash(capturedText));
  }
  replayPlan(planned, legacy, inventory);
});

const eCatalog = () => buildCatalogSupport({ complete: true, models: fixtureModels });
const renderPlan = (current: typeof resolution, id: string) => [
  ...current.agents.map(agent => ({ target: `agents/${agent.installedName}.toml`, kind: "agent-toml" as const, sourceBinding: agent.bindingId,
    content: renderAgent(agent.installedName, "Synthetic public instructions", { model: agent.effective.model, reasoning: agent.effective.effort, sandbox: "read-only" }) })),
  { target: "hooks/parity/capabilities.json", kind: "dispatch-snapshot" as const, sourceBinding: "dispatch", content: JSON.stringify(dispatchModelSelection(current, id)) }];
function replayPlan(plan: ReturnType<typeof planModelSelection>, predecessor: ReturnType<typeof verifyInstalledModelState>, currentInventory = inventory) {
  const actual = plan.writes.map(({ target, kind, sourceBinding, content }) => ({ target, kind, sourceBinding, content }));
  const receipt = plan.receipt, text = JSON.stringify(receipt);
  const e: ReceiptEvidence = { ...evidence(), inventory: currentInventory, context: { sourceRevision: context.sourceRevision,
    previousSelectionId: predecessor.selectionId, supportSource: "fresh-catalog" as const }, capturedAt: null,
    predecessor, retained: predecessor.retained };
  const verify = (value: unknown, evidenceValue = e) => {
    const serialized = JSON.stringify(value);
    return verifyInstalledModelState({ kind: "v2", receiptText: serialized, expectedReceiptSha256: hash(serialized), evidence: evidenceValue, actualOutputs: actual });
  };
  assert.equal(verify(receipt).selectionId, receipt.selectionId);
  assert.throws(() => verify(receipt, { ...e, predecessor: undefined }), /migration-evidence-required/);
  for (const mutate of [
    (copy: typeof receipt) => { delete (copy as Partial<typeof receipt>).migration; },
    (copy: typeof receipt) => { copy.migration = { kind: "fresh", status: "not-required" }; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.sourceRevision = "0".repeat(40); },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.originEvidenceSha256 = "0".repeat(64); },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.outputs = []; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.sourceVersion = 1 === copy.migration.sourceVersion ? 2 : 1; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.oldCatalogSha256 = "0".repeat(64); },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.retainedValues.agents[0]!.effective.effort = "high"; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.overlays = [{ overlayId: h, evidenceSha256: h }]; },
  ]) { const copy = structuredClone(receipt); mutate(copy); assert.throws(() => verify(copy), /model-receipt:/); }
  assert.throws(() => verify(receipt, { ...e, retained: { ...predecessor.retained, roles: new Map() } }), /migration-retained-conflict/);
  assert.equal(hash(text), hash(JSON.stringify(receipt)));
}

test("V2 predecessor migration binds verified evidence and overlay origin without reading pending input", () => {
  const f = overlayCase(), overlay = createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual, outputs: f.next });
  const overlayText = JSON.stringify(overlay), state = verifyObserverModelOverlay({ base: f.base, authority: f.authority,
    predecessorOutputs: f.actual, outputs: f.next, overlayText, expectedOverlaySha256: hash(overlayText) });
  const currentInventory = buildAgentInventory(state.inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) =>
    ({ ...row, sourceSha256: f.authority.sourceSha256 })));
  const plan = planModelSelection({ intent: "apply", policyText, inventory: currentInventory, userText: undefined,
    sourceRevision: context.sourceRevision, existing: state, currentOutputs: f.next, catalog: eCatalog(), supportSource: "fresh-catalog",
    capturedAt: null, runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan });
  assert.equal(plan.receipt.migration.kind, "predecessor");
  if (plan.receipt.migration.kind === "predecessor") {
    assert.equal(plan.receipt.migration.sourceVersion, 2);
    assert.equal(plan.receipt.migration.evidenceSha256, hash(overlayText));
    assert.equal(plan.receipt.migration.originEvidenceSha256, hash(f.text));
    assert.deepEqual(plan.receipt.migration.overlays, [{ overlayId: overlay.identity.overlayId, evidenceSha256: hash(overlayText) }]);
  }
  replayPlan(plan, state, currentInventory);
  const ordinary = planModelSelection({ intent: "apply", policyText, inventory, userText: undefined, sourceRevision: context.sourceRevision,
    existing: f.base, currentOutputs: f.actual, catalog: eCatalog(), supportSource: "fresh-catalog", capturedAt: null,
    runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan });
  replayPlan(ordinary, f.base);
});

function overlayCase(e = evidence()) {
  const actual = rendered(e).map(row => row.kind === "agent-toml" ? { ...row,
    content: row.content + 'developer_instructions = "old public instructions"\nsandbox_mode = "read-only"\n' } : row);
  const receipt = createModelResolutionReceipt(e, actual), text = JSON.stringify(receipt);
  const base = verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text), evidence: { ...e, user: undefined }, actualOutputs: actual });
  const agent = base.resolution.agents[0]!;
  const updated = { ...actual[0]!, content: actual[0]!.content.replace('"old public instructions"', '"new public instructions"') };
  const authority: ObserverOverlayAuthority = { bindingId: agent.bindingId, sourceAgentId: "codex-obs", sourcePath: agent.sourcePath,
    sourceProvider: agent.sourceProvider, installedName: agent.installedName, role: "observer", securityPolicyDigest: agent.securityPolicyDigest,
    sourceRevision: "3".repeat(40), sourceSha256: hash("new public source"), expectedObserverSha256: hash(updated.content) };
  const next = actual.map(row => row.kind === "dispatch-snapshot"
    ? { ...row, content: observerOverlaySnapshot(row.content, base, authority) }
    : row.sourceBinding === agent.bindingId ? updated : row);
  return { e, actual, receipt, text, base, authority, next };
}

test("verified predecessor identity rejects spread forgeries and post-verification nested or Map mutation", () => {
  const f = overlayCase();
  const attest = (previous: typeof f.base) => {
    const e: ReceiptEvidence = { ...evidence(), context: { ...context, previousSelectionId: previous.selectionId },
      retained: previous.retained, predecessor: previous };
    return createModelResolutionReceipt(e, rendered(e));
  };
  assert.throws(() => attest({ ...f.base, sourceRevision: "f".repeat(40), originEvidenceDigest: "0".repeat(64) }), /unverified-installed-state/);
  const copiedDescriptors = Object.create(Object.getPrototypeOf(f.base), Object.getOwnPropertyDescriptors(f.base));
  assert.deepEqual(Object.getOwnPropertySymbols(copiedDescriptors), Object.getOwnPropertySymbols(f.base));
  assert.throws(() => assertVerifiedModelState(copiedDescriptors), /unverified-installed-state/);
  assert.throws(() => createObserverModelOverlay({ base: { ...f.base }, authority: f.authority, predecessorOutputs: f.actual, outputs: f.next }), /unverified-installed-state/);
  const changes: ((state: typeof f.base) => void)[] = [
    state => { state.sourceRevision = "f".repeat(40); },
    state => { state.originEvidenceDigest = "0".repeat(64); },
    state => { state.retained.agents.get(state.inventory.agents[0]!.bindingId)!.defaultRealization.effort = "high"; },
    state => { (state.retained.roles as Map<string, unknown>).set("observer", { model: "gpt-6-luna", effort: "low" }); },
    state => { (state.retained.agents as Map<string, unknown>).delete(state.inventory.agents[0]!.bindingId); },
    state => { (state.catalog.byAlias as Map<string, unknown>).clear(); },
    state => { (state.user.roles as Map<string, unknown>).set("observer", { effort: "high" }); },
    state => { state.receipt!.outputs[0]!.sha256 = "0".repeat(64); },
  ];
  for (const change of changes) {
    const current = overlayCase().base;
    try { change(current); } catch (error) {
      assert.ok(error instanceof TypeError);
      assertVerifiedModelState(current); // Runtime freezing prevented the edit.
      continue;
    }
    assert.throws(() => assertVerifiedModelState(current), /unverified-installed-state/);
    assert.throws(() => attest(current), /unverified-installed-state/);
  }
});

test("verified state defensively captures caller evidence and registers valid overlay transitions", () => {
  const f = overlayCase(), original = f.base.sourceRevision;
  // These are caller-owned objects still used by the original successful check.
  (f.e.user.roles as Map<string, unknown>).set("observer", { effort: "high" });
  (f.e.catalog.byAlias as Map<string, unknown>).clear();
  f.actual[0]!.content = "caller changed its input after verification";
  f.receipt.outputs[0]!.sha256 = "0".repeat(64);
  assertVerifiedModelState(f.base);
  assert.equal(f.base.user.roles.size, 0);
  assert.ok(f.base.catalog.byAlias.size > 0);
  assert.equal(f.base.sourceRevision, original);
  assert.notEqual(f.base.receipt!.outputs[0]!.sha256, "0".repeat(64));
  const clean = overlayCase(), overlay = createObserverModelOverlay({ base: clean.base, authority: clean.authority, predecessorOutputs: clean.actual, outputs: clean.next });
  const text = JSON.stringify(overlay), transitioned = verifyObserverModelOverlay({ base: clean.base, authority: clean.authority,
    predecessorOutputs: clean.actual, outputs: clean.next, overlayText: text, expectedOverlaySha256: hash(text) });
  assertVerifiedModelState(transitioned);
  assert.equal(transitioned.recognizedOverlays.length, 1);
  clean.authority.sourceRevision = "f".repeat(40);
  clean.next[0]!.content = "caller edited later";
  assertVerifiedModelState(transitioned);
  assert.equal(transitioned.recognizedOverlays[0]!.identity.authority.sourceRevision, "3".repeat(40));
});

test("explicit observer overlay composes exact hashes while preserving committed selection and user metadata", () => {
  const f = overlayCase(), before = JSON.stringify(f.receipt);
  const overlay = createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual, outputs: f.next });
  assert.equal(overlay.selectionId, f.base.selectionId);
  assert.equal(overlay.effectivePairUnchanged, true);
  const overlayText = JSON.stringify(overlay);
  const state = verifyObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual,
    outputs: f.next, overlayText, expectedOverlaySha256: hash(overlayText) });
  assert.equal(state.selectionId, f.base.selectionId);
  assert.deepEqual(state.resolution, f.base.resolution);
  assert.equal(JSON.stringify(f.receipt), before);
  assert.equal(state.recognizedOverlays.length, 1);
  assert.throws(() => verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: f.e, actualOutputs: f.next }), /model-receipt:/);
  const composed = verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: { ...f.e, user: undefined }, actualOutputs: f.next,
    overlays: [{ authority: f.authority, predecessorOutputs: f.actual, overlayText, expectedOverlaySha256: hash(overlayText) }] });
  assert.equal(composed.selectionId, f.base.selectionId);
  assert.deepEqual(composed.outputs, state.outputs);
});

test("overlay chains preserve unrelated agents and snapshot fields, and require exact predecessor generations", () => {
  const e = evidence();
  e.inventory = buildAgentInventory([...e.inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) => row),
    { sourcePath: "codex/agents/worker.md", sourceProvider: "kherep", installedName: "worker", role: "builder",
      securityPolicyDigest: h, sourceSha256: h, codeBound: true }]);
  e.user = parseUserModelPolicy(undefined, e.inventory);
  const f = overlayCase(e);
  // Rebuild a complete three-output generation; only observer and dispatch change.
  const firstOutputs = f.actual.map(row => row.kind === "dispatch-snapshot"
    ? { ...row, content: observerOverlaySnapshot(row.content, f.base, f.authority) }
    : row.sourceBinding === f.authority.bindingId ? { ...row, content: row.content.replace('"old public instructions"', '"new public instructions"') } : row);
  const first = createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual, outputs: firstOutputs });
  const firstText = JSON.stringify(first), firstEvidence = { authority: f.authority, predecessorOutputs: f.actual, overlayText: firstText, expectedOverlaySha256: hash(firstText) };
  const composed = verifyObserverModelOverlay({ base: f.base, outputs: firstOutputs, ...firstEvidence });
  const authority = { ...f.authority, sourceRevision: "4".repeat(40), sourceSha256: hash("second public source") };
  const next = firstOutputs.map(row => row.kind === "dispatch-snapshot"
    ? { ...row, content: observerOverlaySnapshot(row.content, composed, authority) } : row);
  const second = createObserverModelOverlay({ base: composed, authority, predecessorOutputs: firstOutputs, outputs: next });
  const secondText = JSON.stringify(second), secondEvidence = { authority, predecessorOutputs: firstOutputs, overlayText: secondText, expectedOverlaySha256: hash(secondText) };
  const final = verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: e,
    actualOutputs: next, overlays: [firstEvidence, secondEvidence] });
  assert.equal(final.recognizedOverlays.length, 2);
  assert.deepEqual(final.resolution, f.base.resolution);
  const worker = firstOutputs.find(row => row.target === "agents/worker.toml")!;
  assert.throws(() => createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual,
    outputs: firstOutputs.map(row => row === worker ? { ...row, content: row.content + "\n" } : row) }), /overlay-unrelated-output-conflict/);
  assert.throws(() => verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: e,
    actualOutputs: next, overlays: [secondEvidence, firstEvidence] }), /model-receipt:/);
});

test("planner retains recognized overlay evidence on no-op and refuses rendering from stale observer source", () => {
  const f = overlayCase(), overlay = createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual, outputs: f.next });
  const overlayText = JSON.stringify(overlay), state = verifyObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual,
    outputs: f.next, overlayText, expectedOverlaySha256: hash(overlayText) });
  const input = { intent: "install" as const, policyText, inventory, sourceRevision: context.sourceRevision, userText: undefined,
    existing: state, currentOutputs: f.next, capturedAt: null, runtimeVersion: null, collectorVersion: null,
    renderOutputs: () => { throw new Error("no-op must not render"); } };
  const plan = planModelSelection(input);
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(plan.preservedOverlays, state.recognizedOverlays);
  assert.throws(() => planModelSelection({ ...input, intent: "apply", catalog: f.e.catalog, supportSource: "fresh-catalog" }), /overlay-source-evidence-required/);
});

test("observer overlays reject self-declared paths, forged bases, permissions/pair drift and partial output", () => {
  const f = overlayCase();
  const build = (change: Partial<Parameters<typeof createObserverModelOverlay>[0]> = {}) =>
    createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual, outputs: f.next, ...change });
  assert.throws(() => build({ authority: { ...f.authority, sourcePath: "plugins/other/agents/codex-obs.md" } }), /overlay-binding-conflict/);
  assert.throws(() => build({ authority: { ...f.authority, securityPolicyDigest: "b".repeat(64) } }), /overlay-binding-conflict/);
  assert.throws(() => build({ predecessorOutputs: f.actual.map(row => ({ ...row, content: "edited predecessor" })) }), /output-conflict/);
  assert.throws(() => build({ outputs: f.next.slice(0, 1) }), /incomplete-output-generation/);
  assert.throws(() => build({ outputs: [{ ...f.next[0]!, target: "kherep/model-policy.user.json" }, f.next[1]!] }), /output-binding-conflict/);
  for (const change of ['model = "visible-other"', 'sandbox_mode = "danger-full-access"', 'tools = "all"']) {
    const content = change.startsWith("model =") ? f.next[0]!.content.replace(/^model = .+$/m, change)
      : change.startsWith("sandbox_mode") ? f.next[0]!.content.replace(/^sandbox_mode = .+$/m, change) : f.next[0]!.content + change + "\n";
    assert.throws(() => build({ authority: { ...f.authority, expectedObserverSha256: hash(content) }, outputs: [{ ...f.next[0]!, content }, f.next[1]!] }), /model-receipt:/);
  }
  const forged = build();
  forged.identity.baseSelectionId = "0".repeat(64);
  const text = JSON.stringify(forged);
  assert.throws(() => verifyObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual, outputs: f.next,
    overlayText: text, expectedOverlaySha256: hash(text) }), /overlay-generation-conflict/);
  // A source/receipt pin does not authorize an observer sandbox widening.
  const unsafe = f.actual.map(row => ({ ...row, content: row.content.replace('"read-only"', '"danger-full-access"') }));
  const unsafeReceipt = JSON.stringify(createModelResolutionReceipt(f.e, unsafe));
  const unsafeBase = verifyInstalledModelState({ kind: "v2", receiptText: unsafeReceipt, expectedReceiptSha256: hash(unsafeReceipt), evidence: f.e, actualOutputs: unsafe });
  const unsafeNext = unsafe.map(row => row.kind === "dispatch-snapshot"
    ? { ...row, content: observerOverlaySnapshot(row.content, unsafeBase, { ...f.authority, expectedObserverSha256: hash(unsafe[0]!.content) }) } : row);
  assert.throws(() => createObserverModelOverlay({ base: unsafeBase, authority: { ...f.authority, expectedObserverSha256: hash(unsafe[0]!.content) },
    predecessorOutputs: unsafe, outputs: unsafeNext }), /overlay-security-conflict/);
});
