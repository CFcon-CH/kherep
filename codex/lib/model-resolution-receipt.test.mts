import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentInventory } from "./model-agent-inventory.mts";
import { parseUserModelPolicy } from "./model-policy-user.mts";
import { buildCatalogSupport, parseModelPolicy, resolveModels, resolveEffectiveSelections } from "./model-policy.mts";
import { modelSelectionId, createModelOutputManifest, verifyModelOutputManifest, createModelResolutionReceipt,
  verifyInstalledModelState, dispatchModelSelection, assertVerifiedModelState, modelEvidenceDigest, type ReceiptEvidence } from "./model-resolution-receipt.mts";
import { createObserverModelOverlay, observerOverlaySnapshot, verifyObserverModelOverlay, type ObserverOverlayAuthority } from "./model-resolution-receipt.mts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
const installedSource = (e: ReceiptEvidence) => ({ sourceRevision: e.context.sourceRevision, policyText: e.policyText,
  inventory: e.inventory, ...(e.agentDefaults === undefined ? {} : { agentDefaults: e.agentDefaults }) });
function coldRead(input: Parameters<typeof verifyInstalledModelState>[0], expected: { selectionId: string; overlays: number }): void {
  const script = `import fs from 'node:fs';
    import {verifyInstalledModelState} from ${JSON.stringify(new URL("./model-resolution-receipt.mts", import.meta.url).href)};
    import {buildAgentInventory} from ${JSON.stringify(new URL("./model-agent-inventory.mts", import.meta.url).href)};
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    const holder=input.kind==='v2'?input.evidence:input;
    holder.inventory=buildAgentInventory(holder.inventory.agents.map(({sourceAgentId,bindingId,...source})=>source));
    if(holder.agentDefaults)holder.agentDefaults=new Map(holder.agentDefaults);
    const state=verifyInstalledModelState(input);
    process.stdout.write(JSON.stringify({selectionId:state.selectionId,overlays:state.recognizedOverlays.length}));`;
  // Deliberate child arguments, never parent --test/coverage/loader execArgv.
  const execArgv = ["--input-type=module", "-e", script];
  const envKeys = ["PATH", "TMPDIR", "LANG", ...(process.platform === "win32" ? ["SystemRoot", "WINDIR", "TMP", "TEMP"] : [])];
  const result = spawnSync(process.execPath, execArgv, { input: JSON.stringify(input, (_key, value) => value instanceof Map ? [...value] : value), encoding: "utf8",
    timeout: 10_000, maxBuffer: 2_097_152, env: Object.fromEntries(envKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!])) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
}
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

test("F1 latest-only serialized receipt survives checkout B upgrade and repeated restart/apply/refresh", () => {
  const a = evidence(); a.policyText = policyText.replace(/(\[roles\.observer\][\s\S]*?reasoning = )"medium"/, '$1"low"');
  const aSource = installedSource(a);
  let actual = rendered(a), text = JSON.stringify(createModelResolutionReceipt(a, actual)), pin = hash(text);
  const bInventory = buildAgentInventory(inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) =>
    ({ ...row, sourceSha256: hash("checkout B changed observer prose") })));
  const bSource = { sourceRevision: "4".repeat(40), policyText, inventory: bInventory };
  const restart = (source: typeof aSource) => verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: pin,
    evidence: source, actualOutputs: JSON.parse(JSON.stringify(actual)) });
  let state = restart(aSource);
  assert.throws(() => restart(bSource), /model-receipt:/);
  assert.throws(() => restart({ ...bSource, sourceRevision: aSource.sourceRevision }), /model-receipt:/);
  const input = { policyText, inventory: bInventory, sourceRevision: bSource.sourceRevision, capturedAt: null,
    runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan };
  for (const [intent, userText] of [["install", undefined], ["apply", '{"roles":{"observer":{"effort":"medium"}}}'],
    ["apply", undefined], ["refresh", undefined]] as const) {
    const plan = planModelSelection({ ...input, intent, userText, existing: state, currentOutputs: actual,
      ...(intent === "install" ? {} : { catalog: eCatalog(), supportSource: "fresh-catalog" as const }) });
    actual = renderPlan(plan.receipt.resolution, plan.selectionId);
    text = JSON.stringify(plan.receipt); pin = hash(text); // overwrite the entire persisted store
    state = restart(bSource); // no predecessor object, receipt, bytes or external historical catalog supplied
    coldRead({ kind: "v2", receiptText: text, expectedReceiptSha256: pin, evidence: bSource, actualOutputs: actual }, { selectionId: plan.selectionId, overlays: 0 });
    assert.equal(state.resolution.agents[0]!.effective.effort, intent === "refresh" || userText ? "medium" : "low");
    assert.equal(plan.receipt.persistenceVersion, 1);
  }
  assert.equal(state.recognizedOverlays.length, 0);
  const latestRead = { kind: "v2" as const, receiptText: text, expectedReceiptSha256: pin, evidence: bSource, actualOutputs: actual };
  for (const wrong of [{ selectionId: "0".repeat(64), overlays: 0 }, { selectionId: state.selectionId, overlays: 1 }]) {
    assert.throws(() => coldRead(latestRead, wrong), error => {
      assert.ok(error instanceof Error);
      const comparison = error as Error & { operator?: string; actual?: unknown };
      assert.equal(comparison.operator, "deepStrictEqual");
      assert.deepEqual(comparison.actual, { selectionId: state.selectionId, overlays: 0 });
      return true;
    });
  }
});

test("F2 latest cumulative checkpoint restarts beyond eight updates without old records or bytes", () => {
  const f = overlayCase();
  let state = f.base, actual = JSON.parse(JSON.stringify(f.actual)) as typeof f.actual;
  for (let index = 0; index < 12; index++) {
    const observer = actual.find(row => row.kind === "agent-toml")!;
    const nextObserver = { ...observer, content: observer.content.replace(/^developer_instructions = .+$/m,
      `developer_instructions = ${JSON.stringify("public update " + index)}`) };
    const authority = { ...f.authority, sourceRevision: (index + 4).toString(16).repeat(40).slice(0, 40),
      sourceSha256: hash("public source " + index), expectedObserverSha256: hash(nextObserver.content) };
    const next = actual.map(row => row.kind === "agent-toml" ? nextObserver
      : { ...row, content: observerOverlaySnapshot(row.content, state, authority) });
    const checkpoint = createObserverModelOverlay({ base: state, authority, predecessorOutputs: actual, outputs: next });
    const overlayText = JSON.stringify(checkpoint), expectedOverlaySha256 = hash(overlayText);
    actual = next; // discard old bytes and checkpoint; only base receipt plus latest checkpoint are durable
    state = verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text),
      evidence: installedSource(f.e), actualOutputs: actual, overlay: { authority, overlayText, expectedOverlaySha256 } });
    assert.equal(state.recognizedOverlays.length, 1);
    assert.equal(checkpoint.schemaVersion, 2);
    assert.equal(Object.hasOwn(checkpoint, "predecessorOutputs"), false);
  }
  const latest = state.recognizedOverlays[0]!, latestText = JSON.stringify(latest);
  coldRead({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: installedSource(f.e), actualOutputs: actual,
    overlay: { authority: latest.identity.authority, overlayText: latestText, expectedOverlaySha256: hash(latestText) } }, { selectionId: f.base.selectionId, overlays: 1 });
  const newInventory = buildAgentInventory(inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) =>
    ({ ...row, sourceSha256: hash("new full selection source") })));
  const plan = planModelSelection({ intent: "install", sourceRevision: "ab".repeat(20), policyText, inventory: newInventory,
    userText: undefined, existing: state, currentOutputs: actual, capturedAt: null, runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan });
  const text = JSON.stringify(plan.receipt);
  const read = { kind: "v2" as const, receiptText: text, expectedReceiptSha256: hash(text),
    evidence: { sourceRevision: "ab".repeat(20), policyText, inventory: newInventory }, actualOutputs: renderPlan(plan.receipt.resolution, plan.selectionId) };
  assert.equal(verifyInstalledModelState(read).recognizedOverlays.length, 0);
  coldRead(read, { selectionId: plan.selectionId, overlays: 0 });
});

test("F1 persisted read validates fixed pins, strict metadata and embedded support without old live evidence", () => {
  const f = overlayCase(), source = installedSource(f.e);
  const plan = planModelSelection({ intent: "apply", sourceRevision: "2".repeat(40), policyText, inventory,
    existing: f.base, currentOutputs: f.actual, userText: undefined, catalog: eCatalog(), supportSource: "fresh-catalog",
    capturedAt: null, runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan });
  const receipt = plan.receipt, text = JSON.stringify(receipt), pin = hash(text), actual = renderPlan(receipt.resolution, plan.selectionId);
  const installed = { ...source, sourceRevision: "2".repeat(40) };
  const read = (value: unknown, trustedPin: string, evidenceValue = installed) => verifyInstalledModelState({ kind: "v2",
    receiptText: typeof value === "string" ? value : JSON.stringify(value), expectedReceiptSha256: trustedPin, evidence: evidenceValue, actualOutputs: actual });
  const assertRepinnedMalformed = (mutate: (copy: typeof receipt) => void) => {
    const copy = structuredClone(receipt); mutate(copy); const serialized = JSON.stringify(copy);
    assert.throws(() => read(serialized, pin), /receipt-byte-conflict/);
    assert.throws(() => read(serialized, hash(serialized)), /model-receipt:|agent-inventory:|model-resolution:/);
  };
  for (const mutate of [
    (copy: typeof receipt) => { delete (copy as Partial<typeof receipt>).persistenceVersion; },
    (copy: typeof receipt) => { copy.inputs.refresh = "true" as unknown as boolean; },
    (copy: typeof receipt) => { copy.catalog.digest = "0".repeat(64); },
    (copy: typeof receipt) => { copy.catalog.snapshot.models[0]!.hidden = !copy.catalog.snapshot.models[0]!.hidden; },
    (copy: typeof receipt) => { copy.catalog.captureStatus = "KNOWN"; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") delete (copy.migration.retainedValues.agents[0] as Partial<typeof inventory.agents[0]>).codeBound; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.retainedValues.agents[0]!.role = "builder"; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.retainedValues.agents = [...copy.migration.retainedValues.agents, structuredClone(copy.migration.retainedValues.agents[0]!)]; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.retainedValues.roles.observer!.defaultRealization.effort = "invalid"; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.outputs[0]!.target = "kherep/model-policy.user.json"; },
    (copy: typeof receipt) => { if (copy.migration.kind === "predecessor") copy.migration.retainedValues.agents[0]!.provenance.effort.inputDigest = "invalid"; },
    (copy: typeof receipt) => { copy.inputs.previousSelectionId = "0".repeat(64); },
    (copy: typeof receipt) => { Object.assign(copy.inputs, { authority: "all" }); },
  ]) assertRepinnedMalformed(mutate);
  for (const extra of [{ catalog: eCatalog() }, { user: f.e.user }, { context }, { retained: f.base.retained }, { predecessor: f.base }]) {
    assert.throws(() => read(text, pin, { ...installed, ...extra }), /unknown-identity-field/);
  }
  const duplicate = text.replace('"persistenceVersion":1', '"persistenceVersion":1,"persistenceVersion":1');
  assert.throws(() => read(duplicate, hash(duplicate)), /duplicate-key/);
  const oversized = text.slice(0, -1) + ',"extra":' + JSON.stringify("x".repeat(1_048_576)) + '}';
  assert.throws(() => read(oversized, hash(oversized)), /receipt-json-/);
  const deep = text.slice(0, -1) + ',"extra":' + '['.repeat(34) + '0' + ']'.repeat(34) + '}';
  assert.throws(() => read(deep, hash(deep)), /receipt-json-/);
  const prototype = text.replace('"roles":{}', '"roles":{"__proto__":{}}');
  assert.notEqual(prototype, text);
  assert.throws(() => read(prototype, hash(prototype)), /model-receipt:/);
  assert.throws(() => verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: pin, evidence: installed,
    actualOutputs: actual, overlays: [] } as unknown as Parameters<typeof verifyInstalledModelState>[0]), /unknown-identity-field/);
  const reauthorizedHistory = structuredClone(receipt);
  if (reauthorizedHistory.migration.kind === "predecessor") reauthorizedHistory.migration.sourceRevision = "f".repeat(40);
  const reauthorizedText = JSON.stringify(reauthorizedHistory);
  assert.throws(() => read(reauthorizedText, pin), /receipt-byte-conflict/);
  // Replacing the independently trusted pin authorizes a different historical
  // attestation. No deleted-history reconstruction or same-UID tamper proof.
  assert.equal(read(reauthorizedText, hash(reauthorizedText)).selectionId, receipt.selectionId);
});

test("F1 authenticated historical defaults may be absent from newer support while an explicit field masks them", () => {
  const e = evidence(), oldModel = { ...fixtureModels.find(row => row.model === "gpt-6-luna")!, id: "old-agent-model", model: "old-agent-model" };
  e.catalog = buildCatalogSupport({ complete: true, models: [...fixtureModels, oldModel] });
  e.agentDefaults = new Map([[inventory.agents[0]!.bindingId, { model: oldModel.model }]]);
  const original = rendered(e), originalText = JSON.stringify(createModelResolutionReceipt(e, original));
  const state = verifyInstalledModelState({ kind: "v2", receiptText: originalText, expectedReceiptSha256: hash(originalText), evidence: installedSource(e), actualOutputs: original });
  coldRead({ kind: "v2", receiptText: originalText, expectedReceiptSha256: hash(originalText), evidence: installedSource(e), actualOutputs: original }, { selectionId: state.selectionId, overlays: 0 });
  const plan = planModelSelection({ intent: "apply", sourceRevision: "2".repeat(40), policyText, inventory, existing: state,
    currentOutputs: original, userText: '{"agents":{"codex-obs":{"model":"gpt-6-luna"}}}', catalog: eCatalog(), supportSource: "fresh-catalog",
    capturedAt: null, runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan });
  const text = JSON.stringify(plan.receipt), latest = verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text),
    evidence: { sourceRevision: "2".repeat(40), policyText, inventory }, actualOutputs: renderPlan(plan.receipt.resolution, plan.selectionId) });
  assert.equal(latest.resolution.agents[0]!.defaultRealization.model, oldModel.model);
  assert.equal(latest.resolution.agents[0]!.effective.model, "gpt-6-luna");
});

test("F2 latest checkpoint read rejects malformed authority, invariants, target and current pair/sandbox/unrelated output", () => {
  const e = evidence();
  e.inventory = buildAgentInventory([...inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) => row),
    { sourcePath: "codex/agents/worker.md", sourceProvider: "kherep", installedName: "worker", role: "builder", securityPolicyDigest: h, sourceSha256: h, codeBound: true }]);
  e.user = parseUserModelPolicy(undefined, e.inventory);
  const f = overlayCase(e), checkpoint = createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual, outputs: f.next });
  const text = JSON.stringify(checkpoint), pin = hash(text);
  const read = (copy: typeof checkpoint, actual = f.next, authority = f.authority, trustedPin = hash(JSON.stringify(copy))) => verifyInstalledModelState({
    kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: installedSource(e), actualOutputs: actual,
    overlay: { authority, overlayText: JSON.stringify(copy), expectedOverlaySha256: trustedPin } });
  assert.equal(read(checkpoint).recognizedOverlays.length, 1);
  for (const mutate of [
    (copy: typeof checkpoint) => { copy.schemaVersion = 1 as 2; },
    (copy: typeof checkpoint) => { copy.identity.originEvidenceSha256 = "0".repeat(64); },
    (copy: typeof checkpoint) => { copy.identity.authority.securityPolicyDigest = "b".repeat(64); },
    (copy: typeof checkpoint) => { copy.identity.authority.sourcePath = "plugins/unowned/agents/codex-obs.md"; },
    (copy: typeof checkpoint) => { copy.outputs[0]!.target = "kherep/model-policy.user.json"; },
    (copy: typeof checkpoint) => { Object.assign(copy, { authority: "all" }); },
    (copy: typeof checkpoint) => { copy.identity.invariants.observerStableFieldsSha256 = "invalid"; },
  ]) {
    const copy = structuredClone(checkpoint); mutate(copy);
    assert.throws(() => read(copy, f.next, f.authority, pin), /overlay-byte-conflict/);
    assert.throws(() => read(copy), /model-receipt:/);
  }
  for (const change of ["sandbox", "pair", "worker", "snapshot", "invariant"] as const) {
    const copy = structuredClone(checkpoint), actual = structuredClone(f.next);
    const observer = actual.find(row => row.sourceBinding === f.authority.bindingId)!;
    if (change === "sandbox") observer.content = observer.content.replace('sandbox_mode = "read-only"', 'sandbox_mode = "danger-full-access"');
    if (change === "pair") observer.content = observer.content.replace(/^model_reasoning_effort = .+$/m, 'model_reasoning_effort = "high"');
    if (change === "worker") actual.find(row => row.target === "agents/worker.toml")!.content += "\n";
    const authority = { ...f.authority, expectedObserverSha256: hash(observer.content) };
    copy.identity.authority = authority;
    if (change === "invariant") copy.identity.invariants.snapshotWithoutOverlaySha256 = "0".repeat(64);
    const { overlayId: _old, ...identity } = copy.identity;
    copy.identity.overlayId = modelEvidenceDigest(identity);
    const snapshot = actual.find(row => row.kind === "dispatch-snapshot")!, parsed = JSON.parse(snapshot.content);
    if (change === "snapshot") parsed.unrelated = "changed";
    parsed.modelSelectionOverlay = copy.identity; snapshot.content = JSON.stringify(parsed);
    copy.outputs = createModelOutputManifest(actual, f.base.selectionId, e.inventory);
    assert.throws(() => read(copy, actual, authority), /model-receipt:/);
  }
  // The reserved member cannot be silently adopted as a first checkpoint.
  const marked = f.actual.map(row => row.kind === "dispatch-snapshot" ? { ...row, content: JSON.stringify({ ...JSON.parse(row.content), modelSelectionOverlay: {} }) } : row);
  const markedText = JSON.stringify(createModelResolutionReceipt(e, marked));
  const base = verifyInstalledModelState({ kind: "v2", receiptText: markedText, expectedReceiptSha256: hash(markedText), evidence: installedSource(e), actualOutputs: marked });
  assert.throws(() => observerOverlaySnapshot(marked.find(row => row.kind === "dispatch-snapshot")!.content, base, f.authority), /overlay-generation-conflict/);
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
  const state = verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text), evidence: installedSource(e), actualOutputs: actual });
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
    return verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text), evidence: installedSource(e), actualOutputs: rows });
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
  const malformedRows = [{ ...good, content: bad[0]! }, actual[1]!];
  const malformedReceipt = createModelResolutionReceipt(e, actual);
  // Re-pin internally hashed malformed current output to exercise the grammar
  // independently of the preceding exact-byte check, not historical proof.
  malformedReceipt.outputs = createModelOutputManifest(malformedRows, malformedReceipt.selectionId, inventory);
  const text = JSON.stringify(malformedReceipt);
  assert.throws(() => verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text), evidence: installedSource(e),
    actualOutputs: malformedRows }), /agent-generation-conflict/);
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
  assert.throws(() => verifyInstalledModelState({ ...input, catalog: undefined }), /migration-evidence-insufficient/);
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
    overlay: { authority, overlayText, expectedOverlaySha256: hash(overlayText) } });
  assert.equal(composed.sourceVersion, 1);
  assert.equal(composed.selectionId, legacy.selectionId);
  assert.equal(composed.resolution.agents[0]!.effective.effort, "low");
  assert.deepEqual(JSON.parse(next[1]!.content).legacyCapabilities, { preserve: "exact" });
  const { actualOutputs: _obsoleteBaselineBytes, ...legacyMetadata } = capturedInput;
  let currentState = composed, currentBytes = next;
  for (let index = 0; index < 10; index++) {
    const currentObserver = { ...currentBytes[0]!, content: currentBytes[0]!.content.replace(/^developer_instructions = .+$/m,
      `developer_instructions = ${JSON.stringify("V1 public update " + index)}`) };
    const latestAuthority = { ...authority, sourceRevision: (index + 4).toString(16).padStart(2, "0").repeat(20),
      sourceSha256: hash("V1 public source " + index), expectedObserverSha256: hash(currentObserver.content) };
    const proposed = [currentObserver, { ...currentBytes[1]!, content: observerOverlaySnapshot(currentBytes[1]!.content, currentState, latestAuthority) }];
    const checkpoint = createObserverModelOverlay({ base: currentState, authority: latestAuthority, predecessorOutputs: currentBytes, outputs: proposed });
    const overlayText = JSON.stringify(checkpoint);
    currentBytes = proposed; // old observer bytes and old checkpoint are replaced
    const latestOnly = { ...legacyMetadata, actualOutputs: currentBytes,
      overlay: { authority: latestAuthority, overlayText, expectedOverlaySha256: hash(overlayText) } };
    currentState = verifyInstalledModelState(latestOnly);
    assert.equal(currentState.recognizedOverlays.length, 1);
    if (index === 9) coldRead(latestOnly, { selectionId: legacy.selectionId, overlays: 1 });
  }
  const newInventory = buildAgentInventory(inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) =>
    ({ ...row, sourceSha256: hash("full post-V1 checkout") })));
  for (const intent of ["install", "apply", "refresh"] as const) {
    const plan = planModelSelection({ intent, policyText, inventory: newInventory, sourceRevision: "ab".repeat(20), userText: undefined,
      existing: currentState, currentOutputs: currentBytes, catalog: eCatalog(), supportSource: "fresh-catalog", capturedAt: null,
      runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan });
    const newestText = JSON.stringify(plan.receipt);
    currentBytes = renderPlan(plan.receipt.resolution, plan.selectionId);
    const latestOnly = { kind: "v2" as const, receiptText: newestText, expectedReceiptSha256: hash(newestText),
      evidence: { sourceRevision: "ab".repeat(20), policyText, inventory: newInventory }, actualOutputs: currentBytes };
    currentState = verifyInstalledModelState(latestOnly); // no V1 record/catalog or predecessor passed
    assert.equal(currentState.recognizedOverlays.length, 0);
    assert.equal(currentState.resolution.agents[0]!.effective.effort, intent === "refresh" ? "medium" : "low");
    coldRead(latestOnly, { selectionId: plan.selectionId, overlays: 0 });
  }
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
  const verify = (value: unknown, fixedPin = hash(text)) => {
    const serialized = JSON.stringify(value);
    return verifyInstalledModelState({ kind: "v2", receiptText: serialized, expectedReceiptSha256: fixedPin, evidence: installedSource(e), actualOutputs: actual });
  };
  assert.equal(verify(receipt).selectionId, receipt.selectionId);
  // No predecessor identity or byte history is a read dependency. Live creation
  // still refuses to attest retention without an authentic predecessor.
  assert.throws(() => createModelResolutionReceipt({ ...e, predecessor: undefined }, actual), /migration-evidence-required/);
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
  ]) { const copy = structuredClone(receipt); mutate(copy); assert.throws(() => verify(copy), { message: "model-receipt: receipt-byte-conflict" }); }
  const structuralCases = [
    { expected: "unknown-identity-field", mutate(copy: typeof receipt) { delete (copy as Partial<typeof receipt>).migration; } },
    { expected: "invalid-migration-record", mutate(copy: typeof receipt) { copy.migration = { kind: "fresh", status: "not-required" }; } },
    { expected: "incomplete-output-generation", mutate(copy: typeof receipt) { if (copy.migration.kind === "predecessor") copy.migration.outputs = []; } },
    { expected: "invalid-migration-record", v2Catalog: true, mutate(copy: typeof receipt) {
      if (copy.migration.kind === "predecessor") { assert.notEqual(copy.migration.catalogSupportDigest, "0".repeat(64)); copy.migration.oldCatalogSha256 = "0".repeat(64); }
    } },
    { expected: "invalid-migration-overlay", mutate(copy: typeof receipt) {
      if (copy.migration.kind === "predecessor") {
        assert.notEqual(copy.migration.evidenceSha256, "0".repeat(64));
        copy.migration.overlays = [{ overlayId: h, evidenceSha256: "0".repeat(64) }];
      }
    } },
  ];
  for (const { mutate, expected, v2Catalog } of structuralCases) {
    const copy = structuredClone(receipt);
    if (v2Catalog && copy.migration.kind === "predecessor") {
      // V1's recorded catalog hash may legitimately differ from normalized
      // support. Reauthorize a coherent V2 attestation before breaking its link.
      copy.migration.sourceVersion = 2;
      copy.migration.oldCatalogSha256 = copy.migration.catalogSupportDigest;
      assert.equal(verify(copy, hash(JSON.stringify(copy))).selectionId, receipt.selectionId);
    }
    mutate(copy);
    assert.throws(() => verify(copy), { message: "model-receipt: receipt-byte-conflict" });
    assert.throws(() => verify(copy, hash(JSON.stringify(copy))), { message: `model-receipt: ${expected}` });
  }
  type Historical = Extract<typeof receipt.migration, { kind: "predecessor" }>;
  const reauthorize: ((migration: Historical) => void)[] = [
    migration => { migration.sourceRevision = "f".repeat(40); },
    migration => {
      migration.originEvidenceSha256 = "0".repeat(64);
      if (!migration.overlays.length) migration.evidenceSha256 = migration.originEvidenceSha256;
    },
    migration => {
      migration.sourceVersion = migration.sourceVersion === 1 ? 2 : 1;
      migration.oldCatalogSha256 = migration.sourceVersion === 2 ? migration.catalogSupportDigest
        : resolveModels(parseModelPolicy(policyText), eCatalog().catalog).catalogSha256;
    },
    migration => { migration.retainedValues.agents[0]!.effective.effort = "high"; },
  ];
  for (const mutate of reauthorize) {
    const copy = structuredClone(receipt);
    if (copy.migration.kind !== "predecessor") assert.fail("fixture must have a predecessor");
    mutate(copy.migration);
    assert.throws(() => verify(copy), { message: "model-receipt: receipt-byte-conflict" });
    // A new independently trusted pin authorizes a coherent historical claim;
    // this is not reconstruction of deleted history. Defaults/current selection
    // stay unchanged, and historical effective values are never defaults.
    const accepted = verify(copy, hash(JSON.stringify(copy)));
    assert.equal(accepted.selectionId, receipt.selectionId);
    // Compare persisted JSON content; defensive capture normalizes null prototypes.
    assert.deepEqual(accepted.resolution, JSON.parse(JSON.stringify(receipt.resolution)));
  }

  assert.throws(() => createModelResolutionReceipt({ ...e, retained: { ...predecessor.retained, roles: new Map() } }, actual), /migration-retained-conflict/);
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
  const base = verifyInstalledModelState({ kind: "v2", receiptText: text, expectedReceiptSha256: hash(text), evidence: installedSource(e), actualOutputs: actual });
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
  assert.throws(() => verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: installedSource(f.e), actualOutputs: f.next }), /model-receipt:/);
  const composed = verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: installedSource(f.e), actualOutputs: f.next,
    overlay: { authority: f.authority, overlayText, expectedOverlaySha256: hash(overlayText) } });
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
  const final = verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: installedSource(e),
    actualOutputs: next, overlay: { authority, overlayText: secondText, expectedOverlaySha256: hash(secondText) } });
  assert.equal(final.recognizedOverlays.length, 1);
  assert.deepEqual(final.resolution, f.base.resolution);
  const worker = firstOutputs.find(row => row.target === "agents/worker.toml")!;
  assert.throws(() => createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual,
    outputs: firstOutputs.map(row => row === worker ? { ...row, content: row.content + "\n" } : row) }), /overlay-unrelated-output-conflict/);
  assert.throws(() => verifyInstalledModelState({ kind: "v2", receiptText: f.text, expectedReceiptSha256: hash(f.text), evidence: installedSource(e),
    actualOutputs: next, overlay: { authority: f.authority, overlayText: firstText, expectedOverlaySha256: hash(firstText) } }), /model-receipt:/);
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

test("F3 trusted source advancement after an overlay retains the pair without a defaults refresh", () => {
  const e = evidence();
  e.policyText = policyText.replace(/(\[roles\.observer\][\s\S]*?reasoning = )"medium"/, '$1"low"');
  const f = overlayCase(e), overlay = createObserverModelOverlay({ base: f.base, authority: f.authority, predecessorOutputs: f.actual, outputs: f.next });
  const text = JSON.stringify(overlay), state = verifyObserverModelOverlay({ base: f.base, authority: f.authority,
    predecessorOutputs: f.actual, outputs: f.next, overlayText: text, expectedOverlaySha256: hash(text) });
  const current = buildAgentInventory(inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) =>
    ({ ...row, sourceSha256: hash("newer public observer source") })));
  const catalog = buildCatalogSupport({ complete: true, models: [...fixtureModels,
    { ...fixtureModels.find(row => row.model === "gpt-6-luna")!, id: "gpt-7-luna", model: "gpt-7-luna" }] });
  // The adapter supplies this actual current revision/inventory independently
  // of user JSON and receipts. Distinct SHA values do not prove ancestry.
  const input = { intent: "install" as const, policyText, inventory: current, sourceRevision: "4".repeat(40),
    userText: undefined, existing: state, currentOutputs: f.next, catalog, supportSource: "fresh-catalog" as const,
    capturedAt: null, runtimeVersion: null, collectorVersion: null, renderOutputs: renderPlan };
  const upgraded = planModelSelection(input);
  assert.deepEqual(upgraded.receipt.resolution.agents[0]!.effective, { model: "gpt-6-luna", effort: "low" });
  const refreshed = planModelSelection({ ...input, intent: "refresh" });
  assert.deepEqual(refreshed.receipt.resolution.agents[0]!.effective, { model: "gpt-7-luna", effort: "medium" });
  for (const sourceRevision of [state.sourceRevision, f.authority.sourceRevision]) {
    assert.throws(() => planModelSelection({ ...input, sourceRevision }), /overlay-source-evidence-required/);
  }
  const incompatible = buildAgentInventory(current.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) =>
    ({ ...row, securityPolicyDigest: "b".repeat(64) })));
  assert.throws(() => planModelSelection({ ...input, inventory: incompatible }), /retained-binding-conflict/);
});

test("F6 output manifest refuses ASCII case-fold target collisions independently of inventory allocation", () => {
  const inputs = inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...row }) => row);
  const distinct = buildAgentInventory([inputs[0]!, { ...inputs[0]!, sourcePath: "codex/agents/second.md", installedName: "second" }]);
  // Exercise the exported transport boundary with a caller-provided inventory,
  // even if its allocator failed to reject a case-insensitive collision.
  const aliases = ["Observer", "observer"];
  const collision = { ...distinct, agents: distinct.agents.map((row, index) => ({ ...row, installedName: aliases[index]! })) };
  const actual = collision.agents.map(row => ({ target: `agents/${row.installedName}.toml`, kind: "agent-toml" as const,
    sourceBinding: row.bindingId, content: "synthetic output" }));
  assert.throws(() => createModelOutputManifest([...actual, outputs[1]!], h, collision), /duplicate-output-target/);
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
  const unsafeBase = verifyInstalledModelState({ kind: "v2", receiptText: unsafeReceipt, expectedReceiptSha256: hash(unsafeReceipt), evidence: installedSource(f.e), actualOutputs: unsafe });
  const unsafeNext = unsafe.map(row => row.kind === "dispatch-snapshot"
    ? { ...row, content: observerOverlaySnapshot(row.content, unsafeBase, { ...f.authority, expectedObserverSha256: hash(unsafe[0]!.content) }) } : row);
  assert.throws(() => createObserverModelOverlay({ base: unsafeBase, authority: { ...f.authority, expectedObserverSha256: hash(unsafe[0]!.content) },
    predecessorOutputs: unsafe, outputs: unsafeNext }), /overlay-security-conflict/);
});
