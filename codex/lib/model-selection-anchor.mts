import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { renderAgent } from "./component-render.mts";
import type { AgentInventory } from "./model-agent-inventory.mts";
import { record, type ModelEffort } from "./model-policy.mts";
import { parseModelPolicyJson } from "./model-policy-user.mts";
import { MODEL_DISPATCH_SNAPSHOT_TARGET, verifyInstalledModelState, type ObserverOverlayAuthority, type RenderedModelOutput,
  type VerifiedInstalledModelState } from "./model-resolution-receipt.mts";
import { ModelSelectionRefusal, type ModelSelectionGit, type SourceReader } from "./model-selection-git.mts";
import { buildSelectionInventory, readSourceSnapshot } from "./model-selection-inventory.mts";

// Issue #737. Paths relative to CODEX_HOME. The anchor is written last and pins
// the exact receipt (and optional observer overlay) bytes; parity-receipt.json
// carries only a pointer to it.
export const MODEL_SELECTION_FILES = Object.freeze({
  anchor: "orchestra/model-selection-anchor.json",
  receipt: "orchestra/model-selection-receipt.json",
  overlay: "orchestra/model-selection-overlay.json",
  lock: "orchestra/model-selection.lock",
  user: "kherep/model-policy.user.json",
});
export const OBSERVER_SOURCE = "codex/agents/codex-obs.md";
export const ANCHOR_REFUSAL = Object.freeze({
  refreshRequired: "model-selection-refresh-required",
  anchorInvalid: "model-selection-anchor-invalid",
  receiptMissing: "model-selection-receipt-missing",
  receiptConflict: "model-selection-receipt-conflict",
  outputMissing: "model-selection-output-missing",
  stateInvalid: "model-selection-installed-state-invalid",
  userUnreadable: "model-selection-user-unreadable",
  locked: "model-selection-locked",
});

export interface ModelSelectionAnchor {
  schemaVersion: 1; kind: "codex-model-selection-anchor"; selectionId: string; sourceRevision: string;
  receipt: { target: string; sha256: string };
  overlay: { target: string; sha256: string; sourceRevision: string } | null;
}
export interface AnchoredState {
  anchor: ModelSelectionAnchor; anchorText: string; receiptText: string;
  verified: VerifiedInstalledModelState; actualOutputs: RenderedModelOutput[];
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const DIGEST = /^[a-f0-9]{64}$/, REVISION = /^[a-f0-9]{40}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The model-selection outputs whose rollback is ownership-checked (amendment 5):
// generated agent TOMLs, the dispatch snapshot, receipt, overlay and anchor.
export function modelSelectionTarget(codexHome: string): (target: string) => boolean {
  const owned = new Set([MODEL_DISPATCH_SNAPSHOT_TARGET, MODEL_SELECTION_FILES.receipt, MODEL_SELECTION_FILES.overlay, MODEL_SELECTION_FILES.anchor]);
  return (target) => {
    const relative = path.relative(path.resolve(codexHome), path.resolve(target)).split(path.sep).join("/");
    return owned.has(relative) || /^agents\/[^/]+\.toml$/.test(relative);
  };
}

export function homeFile(codexHome: string, relative: string, code: string = ANCHOR_REFUSAL.anchorInvalid): string {
  const parts = relative.split("/");
  if (relative.length > 512 || parts.some((part) => !SEGMENT.test(part) || part === "..")) throw new ModelSelectionRefusal(code);
  return path.join(codexHome, ...parts);
}

// ENOENT is the only absence; any other read failure stays a failure.
export function readOptional(file: string, unreadable: string): string | undefined {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ModelSelectionRefusal(unreadable);
  }
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseAnchor(text: string): ModelSelectionAnchor {
  let value: unknown;
  try { value = parseModelPolicyJson(text, { maxBytes: 8192, maxDepth: 4 }); }
  catch { throw new ModelSelectionRefusal(ANCHOR_REFUSAL.anchorInvalid); }
  const overlay = record(value) ? value.overlay : undefined;
  if (!exact(value, ["schemaVersion", "kind", "selectionId", "sourceRevision", "receipt", "overlay"])
    || value.schemaVersion !== 1 || value.kind !== "codex-model-selection-anchor"
    || typeof value.selectionId !== "string" || !DIGEST.test(value.selectionId)
    || typeof value.sourceRevision !== "string" || !REVISION.test(value.sourceRevision)
    || !exact(value.receipt, ["target", "sha256"]) || value.receipt.target !== MODEL_SELECTION_FILES.receipt
    || typeof value.receipt.sha256 !== "string" || !DIGEST.test(value.receipt.sha256)
    || overlay !== null && (!exact(overlay, ["target", "sha256", "sourceRevision"]) || overlay.target !== MODEL_SELECTION_FILES.overlay
      || typeof overlay.sha256 !== "string" || !DIGEST.test(overlay.sha256)
      || typeof overlay.sourceRevision !== "string" || !REVISION.test(overlay.sourceRevision))) {
    throw new ModelSelectionRefusal(ANCHOR_REFUSAL.anchorInvalid);
  }
  return value as unknown as ModelSelectionAnchor;
}

export function renderAnchor(anchor: ModelSelectionAnchor): string {
  return `${JSON.stringify(anchor, null, 2)}\n`;
}

// Adapter-trusted observer authority, rebuilt from the named commit; never
// copied out of the receipt or overlay it is about to verify. Also returns the
// observer TOML that this source renders with the recorded effective pair.
export function observerOverlayAuthority(inventory: AgentInventory, resolution: { agents: readonly { bindingId: string; effective: ModelEffort }[] },
  sourceRevision: string, reader: SourceReader): { authority: ObserverOverlayAuthority; agentText: string; effective: ModelEffort } {
  const agent = inventory.agents.find((row) => row.sourceProvider === "kherep" && row.sourcePath === OBSERVER_SOURCE && row.role === "observer");
  const effective = resolution.agents.find((row) => row.bindingId === agent?.bindingId)?.effective;
  if (!agent || !record(effective)) throw new ModelSelectionRefusal(ANCHOR_REFUSAL.stateInvalid, "observer-binding-missing");
  const source = reader.read(OBSERVER_SOURCE);
  const agentText = renderAgent(agent.installedName, source, { model: effective.model, reasoning: effective.effort, sandbox: "read-only" });
  return { agentText, effective, authority: { bindingId: agent.bindingId, sourceAgentId: agent.sourceAgentId, sourcePath: agent.sourcePath,
    sourceProvider: agent.sourceProvider, installedName: agent.installedName, role: "observer",
    securityPolicyDigest: agent.securityPolicyDigest, sourceRevision, sourceSha256: sha256(source), expectedObserverSha256: sha256(agentText) } };
}

interface ReceiptShape { inventory: { agents: { bindingId: string; installedName: string }[] }; outputs: { target: string; kind: RenderedModelOutput["kind"]; sourceBinding: string }[];
  resolution: { agents: { bindingId: string; effective: ModelEffort }[] } }
function receiptShape(text: string): ReceiptShape {
  let value: unknown;
  try { value = parseModelPolicyJson(text, { maxBytes: 1_048_576, maxDepth: 32 }); } catch { value = undefined; }
  const shape = value as ReceiptShape | undefined;
  if (!record(shape) || !record(shape.inventory) || !Array.isArray(shape.inventory.agents) || !Array.isArray(shape.outputs)
    || !record(shape.resolution) || !Array.isArray(shape.resolution.agents)
    || [...shape.inventory.agents, ...shape.outputs, ...shape.resolution.agents].some((row) => !record(row))) {
    throw new ModelSelectionRefusal(ANCHOR_REFUSAL.stateInvalid, "receipt-shape");
  }
  return shape;
}

// Verifies the anchored generation: anchor -> exact receipt bytes -> inventory
// and policy rebuilt from the receipt's own commit (aliases from the receipt)
// -> the current bytes of every recorded output, plus an optional overlay.
export function verifyAnchoredState(codexHome: string, git: ModelSelectionGit, anchorText: string): AnchoredState {
  const anchor = parseAnchor(anchorText);
  const receiptText = readOptional(homeFile(codexHome, anchor.receipt.target), ANCHOR_REFUSAL.receiptMissing);
  if (receiptText === undefined) throw new ModelSelectionRefusal(ANCHOR_REFUSAL.receiptMissing);
  if (sha256(receiptText) !== anchor.receipt.sha256) throw new ModelSelectionRefusal(ANCHOR_REFUSAL.receiptConflict);
  const shape = receiptShape(receiptText);
  const reader = git.at(anchor.sourceRevision);
  const source = readSourceSnapshot(reader);
  const inventory = buildSelectionInventory(source.rows, new Map(shape.inventory.agents.map((row) => [row.bindingId, row.installedName])));
  const actualOutputs = shape.outputs.map((row) => {
    const content = readOptional(homeFile(codexHome, String(row.target), ANCHOR_REFUSAL.stateInvalid), ANCHOR_REFUSAL.outputMissing);
    if (content === undefined) throw new ModelSelectionRefusal(ANCHOR_REFUSAL.outputMissing);
    return { target: row.target, kind: row.kind, sourceBinding: row.sourceBinding, content };
  });
  let overlay: { authority: ObserverOverlayAuthority; overlayText: string; expectedOverlaySha256: string } | undefined;
  if (anchor.overlay) {
    const overlayText = readOptional(homeFile(codexHome, anchor.overlay.target), ANCHOR_REFUSAL.outputMissing);
    if (overlayText === undefined) throw new ModelSelectionRefusal(ANCHOR_REFUSAL.outputMissing);
    const { authority } = observerOverlayAuthority(inventory, shape.resolution, anchor.overlay.sourceRevision, git.at(anchor.overlay.sourceRevision));
    overlay = { authority, overlayText, expectedOverlaySha256: anchor.overlay.sha256 };
  }
  let verified: VerifiedInstalledModelState;
  try {
    verified = verifyInstalledModelState({ kind: "v2", receiptText, expectedReceiptSha256: anchor.receipt.sha256,
      evidence: { sourceRevision: anchor.sourceRevision, policyText: source.policyText, inventory }, actualOutputs, ...(overlay ? { overlay } : {}) });
  } catch (error) {
    throw new ModelSelectionRefusal(ANCHOR_REFUSAL.stateInvalid, (error as Error).message);
  }
  if (verified.selectionId !== anchor.selectionId) throw new ModelSelectionRefusal(ANCHOR_REFUSAL.anchorInvalid);
  return { anchor, anchorText, receiptText, verified, actualOutputs };
}

// One writer per Codex home for a model-selection transaction. A stale lock
// after a crash is reported, never broken automatically.
export function acquireSelectionLock(codexHome: string): () => void {
  const file = homeFile(codexHome, MODEL_SELECTION_FILES.lock);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let descriptor: number;
  try { descriptor = fs.openSync(file, "wx", 0o600); }
  catch { throw new ModelSelectionRefusal(ANCHOR_REFUSAL.locked); }
  fs.writeSync(descriptor, `${process.pid}\n`);
  fs.closeSync(descriptor);
  return () => fs.rmSync(file, { force: true });
}
