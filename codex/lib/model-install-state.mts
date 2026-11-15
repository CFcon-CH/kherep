import { createHash } from "node:crypto";
import { parseModelPolicy, record, resolveModels, resolveEffectiveSelections, buildCatalogSupport, type ModelResolution, type CatalogSupport, type EffectiveResolutionV2 } from "./model-policy.mts";
import { verifyAgentInventory, type AgentInventory } from "./model-agent-inventory.mts";
import { parseUserModelPolicy, type ModelChoice } from "./model-policy-user.mts";
import { assertVerifiedModelState, createModelResolutionReceipt, modelSelectionId, verifyModelOutputManifest,
  type ModelResolutionReceiptV2, type RenderedModelOutput, type ModelOutputIdentity, type VerifiedInstalledModelState, type ReceiptEvidence,
  type ObserverModelOverlay } from "./model-resolution-receipt.mts";

export interface ModelSelection { existing?: unknown; catalog?: unknown; refresh?: boolean }

// A normal reinstall never refreshes model identities. This pure preflight runs
// before the install transaction; a changed policy needs an explicit refresh.
export function selectModelResolution(policyText: string, selection: ModelSelection = {}): ModelResolution {
  const policy = parseModelPolicy(policyText);
  if (selection.refresh !== true && selection.existing !== undefined) {
    const value = selection.existing;
    if (!record(value) || value.schemaVersion !== 1 || value.policySha256 !== policy.sourceSha256
      || typeof value.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.catalogSha256)
      || typeof value.resolvedAt !== "string" || !Number.isFinite(Date.parse(value.resolvedAt))
      || !record(value.roles) || !record(value.supportedModels)) throw new Error("Installed model resolution is invalid or requires explicit refresh");
    const models = Object.entries(value.supportedModels).map(([model, efforts]) => ({
      id: model, model, hidden: false,
      supportedReasoningEfforts: Array.isArray(efforts) ? efforts.map((reasoningEffort: unknown) => ({ reasoningEffort })) : [],
    }));
    let checked: ModelResolution;
    try { checked = resolveModels(policy, { complete: true, models }); }
    catch { throw new Error("Installed model resolution support is invalid"); }
    if (JSON.stringify(checked.roles) !== JSON.stringify(value.roles)) throw new Error("Installed model resolution roles are inconsistent");
    return value as unknown as ModelResolution;
  }
  if (selection.catalog === undefined) throw new Error("A complete model catalog is required for first install or explicit refresh");
  return resolveModels(policy, selection.catalog);
}

export interface SelectionInputs {
  intent: "install" | "apply" | "refresh"; policyText: string; inventory: AgentInventory; userText: string | undefined;
  sourceRevision: string; existing?: VerifiedInstalledModelState; currentOutputs?: readonly RenderedModelOutput[];
  catalog?: CatalogSupport; supportSource?: "fresh-catalog" | "verified-snapshot"; agentDefaults?: ReadonlyMap<string, ModelChoice>;
  capturedAt: string | null; runtimeVersion: string | null; collectorVersion: string | null;
  // Adapter-owned pure renderer. No user-authored executable or I/O callback.
  renderOutputs(resolution: EffectiveResolutionV2, selectionId: string): readonly RenderedModelOutput[];
}
export interface ModelSelectionPlan {
  schemaVersion: 2; selectionId: string; receipt: ModelResolutionReceiptV2;
  preservedOverlays: readonly ObserverModelOverlay[];
  writes: readonly (RenderedModelOutput & { previousSha256: string | null; nextSha256: string })[];
  deletions: readonly ModelOutputIdentity[];
  preconditions: { user: EffectiveResolutionV2["userIdentity"]; outputs: readonly ModelOutputIdentity[] };
  rollback: { userFile: "never-write";
    restore: readonly { target: string; content: string; expectedAfterSha256: string | null }[]; removeCreated: readonly string[] };
}
const inputSha = (text: string): string => createHash("sha256").update(text).digest("hex");
function planFail(code: string): never { throw new Error(`model-selection-plan: ${code}`); }
export function assertModelSelectionPreconditions(plan: ModelSelectionPlan, userText: string | undefined, actual: readonly RenderedModelOutput[]): void {
  if (plan.preconditions.user.present !== (userText !== undefined)
    || plan.preconditions.user.byteSha256 !== (userText === undefined ? null : inputSha(userText))) planFail("user-input-changed");
  const expected = new Map(plan.preconditions.outputs.map(row => [row.target, row.sha256]));
  if (actual.length !== expected.size || new Set(actual.map(row => row.target)).size !== actual.length
    || actual.some(row => expected.get(row.target) !== inputSha(row.content))) planFail("output-precondition-conflict");
}

// Pure preflight/rollback planning only. Filesystem transactions and receipt-last
// execution remain the installer's separate responsibility in PR-B.
export function planModelSelection(input: SelectionInputs): ModelSelectionPlan {
  if (!["install", "apply", "refresh"].includes(input.intent)) planFail("invalid-intent");
  const inventory = verifyAgentInventory(input.inventory);
  const existing = input.existing;
  if (existing) assertVerifiedModelState(existing);
  const current = input.currentOutputs ?? [];
  if (existing) for (const agent of inventory.agents) {
    const next = `agents/${agent.installedName}.toml`;
    if (existing.outputs.some(row => row.target !== next && row.target.toLowerCase() === next.toLowerCase()))
      planFail("case-only-output-transition");
  }
  if (existing) {
    if (!input.currentOutputs) planFail("missing-current-output-evidence");
    verifyModelOutputManifest(existing.outputs, current, existing.selectionId, existing.inventory);
  } else if (current.length) planFail("unowned-output-conflict");
  const user = parseUserModelPolicy(input.userText, inventory), policy = parseModelPolicy(input.policyText);
  const newAgents = existing && inventory.agents.some(agent => !existing.retained.agents.has(agent.bindingId));
  const changedUser = existing && (user.semanticSha256 !== existing.user.semanticSha256 || user.present !== existing.user.present);
  const needsFresh = !existing || input.intent !== "install" || changedUser || newAgents;
  if (needsFresh && (!input.catalog || input.supportSource !== "fresh-catalog")) planFail("fresh-catalog-required");
  if (input.catalog && !input.supportSource) planFail("missing-catalog-source");
  // The snapshot label is evidence of reuse, not authority to replace support.
  // Rebuild caller-provided derived lookups and validate the raw catalog digest
  // before the no-op shortcut can accept it.
  const suppliedCatalog = input.catalog && buildCatalogSupport(input.catalog.catalog);
  if (suppliedCatalog && suppliedCatalog.digest !== input.catalog!.digest) planFail("catalog-evidence-conflict");
  if (suppliedCatalog && input.supportSource === "verified-snapshot" && suppliedCatalog.digest !== existing?.catalog.digest)
    planFail("snapshot-catalog-conflict");
  const catalog = suppliedCatalog ?? existing?.catalog;
  if (!catalog) planFail("catalog-required");
  const sameUserBytes = existing && user.byteSha256 === existing.user.byteSha256 && user.present === existing.user.present;
  if (existing?.receipt && input.intent === "install" && sameUserBytes && policy.sourceSha256 === existing.resolution.policySha256
    && input.sourceRevision === existing.sourceRevision && inventory.digest === existing.inventoryDigest
    && catalog.digest === existing.catalog.digest && input.agentDefaults === undefined) {
    return { schemaVersion: 2, selectionId: existing.selectionId, receipt: existing.receipt, preservedOverlays: existing.recognizedOverlays, writes: [], deletions: [],
      preconditions: { user: existing.resolution.userIdentity, outputs: existing.outputs }, rollback: { userFile: "never-write", restore: [], removeCreated: [] } };
  }
  const lastOverlay = existing?.recognizedOverlays.at(-1);
  if (lastOverlay) {
    const current = inventory.agents.find(agent => agent.bindingId === lastOverlay.identity.authority.bindingId);
    // Source revision + inventory are independently adapter-trusted inputs.
    // A different current revision may advance public prose without refreshing
    // model defaults. SHA inequality is not a claim of Git ancestry/freshness.
    if (!current || current.sourceSha256 !== lastOverlay.identity.authority.sourceSha256
      && (input.sourceRevision === existing!.sourceRevision || input.sourceRevision === lastOverlay.identity.authority.sourceRevision))
      planFail("overlay-source-evidence-required");
  }
  const evidence: ReceiptEvidence = { context: { sourceRevision: input.sourceRevision, previousSelectionId: existing?.selectionId ?? null,
    supportSource: input.catalog ? input.supportSource! : "verified-snapshot" }, policyText: input.policyText, inventory,
    user, catalog, retained: existing?.retained, predecessor: existing, agentDefaults: input.agentDefaults, refresh: input.intent === "refresh",
    capturedAt: input.catalog ? input.capturedAt : existing?.receipt?.catalog.capturedAt ?? null,
    runtimeVersion: input.catalog ? input.runtimeVersion : existing?.receipt?.catalog.runtimeVersion.value ?? null,
    collectorVersion: input.catalog ? input.collectorVersion : existing?.receipt?.catalog.collectorVersion.value ?? null };
  const resolution = resolveEffectiveSelections({ policy, inventory, user, catalog,
    retained: existing?.retained, agentDefaults: input.agentDefaults, refresh: evidence.refresh });
  const selectionId = modelSelectionId(resolution, evidence.context);
  let rendered: readonly RenderedModelOutput[];
  try { rendered = input.renderOutputs(resolution, selectionId); } catch { planFail("render-failed"); }
  const receipt = createModelResolutionReceipt(evidence, rendered);
  const oldHashes = new Map(existing?.outputs.map(row => [row.target, row.sha256]) ?? []);
  const oldBytes = new Map(current.map(row => [row.target, row.content]));
  const newHashes = new Map(receipt.outputs.map(row => [row.target, row.sha256]));
  const writes = rendered.filter(row => oldHashes.get(row.target) !== newHashes.get(row.target)).map(row => ({ ...row,
    previousSha256: oldHashes.get(row.target) ?? null, nextSha256: newHashes.get(row.target)! }));
  const deletions = existing?.outputs.filter(row => !newHashes.has(row.target)) ?? [];
  return { schemaVersion: 2, selectionId, receipt, preservedOverlays: [], writes, deletions,
    preconditions: { user: resolution.userIdentity, outputs: existing?.outputs ?? [] },
    rollback: { userFile: "never-write", restore: [
      ...writes.filter(row => oldBytes.has(row.target)).map(row => ({ target: row.target, content: oldBytes.get(row.target)!, expectedAfterSha256: row.nextSha256 })),
      ...deletions.map(row => ({ target: row.target, content: oldBytes.get(row.target)!, expectedAfterSha256: null }))],
    removeCreated: writes.filter(row => !oldBytes.has(row.target)).map(row => row.target) } };
}
