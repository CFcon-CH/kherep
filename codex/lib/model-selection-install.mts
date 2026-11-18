import fs from "node:fs";

import { renderAgent } from "./component-render.mts";
import type { Capabilities, PlannedAgentOutput } from "./contracts.mts";
import { buildCatalogSupport, type CatalogSupport, type EffectiveResolutionV2 } from "./model-policy.mts";
import { assertModelSelectionPreconditions, planModelSelection, type ModelSelectionPlan } from "./model-install-state.mts";
import { dispatchModelSelection, MODEL_DISPATCH_SNAPSHOT_TARGET, type RenderedModelOutput } from "./model-resolution-receipt.mts";
import { ANCHOR_REFUSAL, homeFile, MODEL_SELECTION_FILES, readOptional, renderAnchor, sha256, verifyAnchoredState,
  type AnchoredState } from "./model-selection-anchor.mts";
import { ModelSelectionRefusal, type ModelSelectionGit } from "./model-selection-git.mts";
import { buildSelectionInventory, readSourceSnapshot, type AgentSourceRow } from "./model-selection-inventory.mts";
import { planAgentNames } from "./parity-projection.mts";

export const CATALOG_REQUIRED = "model-selection-catalog-required";

export interface InstallSelectionInput {
  repoRoot: string; codexHome: string; git: ModelSelectionGit; refresh: boolean; catalog?: unknown;
  checkInstalledTarget?: (file: string) => void;
}
export interface InstallSelection {
  plan: ModelSelectionPlan; noOp: boolean; selectionId: string; resolution: EffectiveResolutionV2;
  outputs: readonly RenderedModelOutput[]; snapshotText: string; agentOutputs: ReadonlyMap<string, PlannedAgentOutput>;
  receiptText: string | null; anchorText: string | null; previous: AnchoredState | undefined; userText: string | undefined;
  pointer: { schemaVersion: 2; selectionId: string; anchor: string; receipt: string };
}

function render(rows: readonly AgentSourceRow[], capabilities: Capabilities) {
  const byBinding = new Map(rows.map((row) => [row.bindingId, row]));
  return (resolution: EffectiveResolutionV2, selectionId: string): RenderedModelOutput[] => {
    const effective = (bindingId: string) => resolution.agents.find((agent) => agent.bindingId === bindingId)!.effective;
    const agents = Object.fromEntries(Object.entries(capabilities.agents).map(([key, entry]) => {
      const pair = effective(`kherep:${entry.source ?? `claude/agents/${key}.md`}`);
      return [key, { ...entry, model: pair.model, reasoning: pair.effort }];
    }));
    return [...resolution.agents.map((agent): RenderedModelOutput => {
      const row = byBinding.get(agent.bindingId)!;
      return { target: `agents/${agent.installedName}.toml`, kind: "agent-toml", sourceBinding: agent.bindingId,
        content: renderAgent(agent.installedName, row.source, { model: agent.effective.model, reasoning: agent.effective.effort,
          ...(row.sandbox ? { sandbox: row.sandbox } : {}) }) };
    }), { target: MODEL_DISPATCH_SNAPSHOT_TARGET, kind: "dispatch-snapshot", sourceBinding: "dispatch",
      content: `${JSON.stringify({ ...capabilities, agents, ...dispatchModelSelection(resolution, selectionId) }, null, 2)}\n` }];
  };
}

function readOutputs(codexHome: string, targets: readonly string[]): string[] {
  return targets.map((target) => {
    const content = readOptional(homeFile(codexHome, target, ANCHOR_REFUSAL.stateInvalid), ANCHOR_REFUSAL.outputMissing);
    if (content === undefined) throw new ModelSelectionRefusal(ANCHOR_REFUSAL.outputMissing);
    return content;
  });
}

// Pure preflight of one model-selection generation (issue #737): reads the
// anchor, the read-only user layer, the source tree and the installed outputs;
// writes nothing. A1: an anchor-less home with an earlier install needs one
// explicit refresh. B1: any change of the selection needs a clean, resolved Git
// source; an exact no-op reinstall does not.
export function prepareInstallSelection(input: InstallSelectionInput): InstallSelection {
  const { codexHome, git } = input;
  const anchorFile = homeFile(codexHome, MODEL_SELECTION_FILES.anchor);
  input.checkInstalledTarget?.(anchorFile);
  const anchorText = readOptional(anchorFile, ANCHOR_REFUSAL.anchorInvalid);
  if (anchorText === undefined && !input.refresh && fs.existsSync(homeFile(codexHome, "orchestra/parity-receipt.json"))) {
    throw new ModelSelectionRefusal(ANCHOR_REFUSAL.refreshRequired,
      "this Codex home has no model-selection anchor; run the installer once with --refresh-models");
  }
  const sourceRevision = git.head();
  const previous = anchorText === undefined ? undefined : verifyAnchoredState(codexHome, git, anchorText, input.checkInstalledTarget);
  const source = readSourceSnapshot(git.workingTree());
  const inventory = buildSelectionInventory(source.rows, planAgentNames(source.rows, codexHome));
  const userFile = homeFile(codexHome, MODEL_SELECTION_FILES.user);
  input.checkInstalledTarget?.(userFile);
  const userText = readOptional(userFile, ANCHOR_REFUSAL.userUnreadable);
  const renderOutputs = render(source.rows, source.capabilities);
  let rendered: RenderedModelOutput[] = [];
  const attempt = (catalog?: CatalogSupport): ModelSelectionPlan => planModelSelection({
    intent: input.refresh ? "refresh" : "install", policyText: source.policyText, inventory, userText, sourceRevision,
    existing: previous?.verified, currentOutputs: previous?.actualOutputs, catalog, supportSource: catalog ? "fresh-catalog" : undefined,
    capturedAt: catalog ? new Date().toISOString() : null, runtimeVersion: null, collectorVersion: null,
    renderOutputs: (resolution, selectionId) => (rendered = renderOutputs(resolution, selectionId)),
  });
  let plan: ModelSelectionPlan | undefined;
  if (previous && !input.refresh) {
    try { plan = attempt(); }
    catch (error) { if (!(error instanceof Error && error.message === "model-selection-plan: fresh-catalog-required")) throw error; }
  }
  if (!plan) {
    if (input.catalog === undefined) {
      git.assertClean();
      throw new ModelSelectionRefusal(CATALOG_REQUIRED, "a complete model catalog is required for this model selection");
    }
    plan = attempt(buildCatalogSupport(input.catalog));
  }
  const noOp = previous !== undefined && plan.receipt === previous.verified.receipt;
  if (!noOp) git.assertClean();
  const resolution = noOp ? previous.verified.resolution : plan.receipt.resolution;
  const outputs = noOp ? previous.actualOutputs : rendered;
  const byTarget = new Map(outputs.map((row) => [row.target, row.content]));
  const agentOutputs = new Map(resolution.agents.map((agent) => [agent.bindingId, { installedName: agent.installedName,
    content: byTarget.get(`agents/${agent.installedName}.toml`)!, role: agent.role, model: agent.effective.model, reasoning: agent.effective.effort }]));
  const receiptText = noOp ? null : `${JSON.stringify(plan.receipt, null, 2)}\n`;
  return { plan, noOp, selectionId: plan.selectionId, resolution, outputs, snapshotText: byTarget.get(MODEL_DISPATCH_SNAPSHOT_TARGET)!,
    agentOutputs, receiptText, previous, userText,
    anchorText: receiptText === null ? null : renderAnchor({ schemaVersion: 1, kind: "codex-model-selection-anchor", selectionId: plan.selectionId,
      sourceRevision, receipt: { target: MODEL_SELECTION_FILES.receipt, sha256: sha256(receiptText) }, overlay: null }),
    pointer: { schemaVersion: 2, selectionId: plan.selectionId, anchor: MODEL_SELECTION_FILES.anchor, receipt: MODEL_SELECTION_FILES.receipt } };
}

// True when the selection cannot be planned from the verified stored support.
export function selectionNeedsCatalog(input: InstallSelectionInput): boolean {
  if (input.refresh) { input.git.assertClean(); return true; }
  try { prepareInstallSelection({ ...input, catalog: undefined }); return false; }
  catch (error) { if (error instanceof ModelSelectionRefusal && error.code === CATALOG_REQUIRED) return true; throw error; }
}

// Immediately before the first write, under the lock: the anchor, the user
// layer and every predecessor output still have the bytes the plan was made from.
export function assertSelectionUnchanged(codexHome: string, selection: InstallSelection): void {
  const anchorText = readOptional(homeFile(codexHome, MODEL_SELECTION_FILES.anchor), ANCHOR_REFUSAL.anchorInvalid);
  if (anchorText !== selection.previous?.anchorText) throw new ModelSelectionRefusal("model-selection-plan: output-precondition-conflict");
  const userText = readOptional(homeFile(codexHome, MODEL_SELECTION_FILES.user), ANCHOR_REFUSAL.userUnreadable);
  const targets = selection.plan.preconditions.outputs.map((row) => row.target);
  let actual: RenderedModelOutput[];
  try {
    actual = readOutputs(codexHome, targets).map((content, index) => ({ target: targets[index]!, kind: "agent-toml", sourceBinding: "", content }));
  } catch { throw new ModelSelectionRefusal("model-selection-plan: output-precondition-conflict"); }
  try { assertModelSelectionPreconditions(selection.plan, userText, actual); }
  catch (error) { throw new ModelSelectionRefusal((error as Error).message); }
}

// Readback of every model output and the receipt before the anchor is written.
export function assertSelectionWritten(codexHome: string, selection: InstallSelection): void {
  const rows: [string, string][] = selection.outputs.map((row) => [row.target, row.content]);
  if (selection.receiptText !== null) rows.push([MODEL_SELECTION_FILES.receipt, selection.receiptText]);
  const actual = readOutputs(codexHome, rows.map(([target]) => target));
  if (rows.some(([, content], index) => actual[index] !== content)) throw new ModelSelectionRefusal("model-selection-readback-conflict");
}
