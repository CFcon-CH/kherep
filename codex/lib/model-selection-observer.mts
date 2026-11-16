import path from "node:path";

import type { ModelEffort } from "./model-policy.mts";
import { createObserverModelOverlay, MODEL_DISPATCH_SNAPSHOT_TARGET, observerOverlaySnapshot } from "./model-resolution-receipt.mts";
import { MODEL_SELECTION_FILES, observerOverlayAuthority, renderAnchor, sha256, verifyAnchoredState } from "./model-selection-anchor.mts";
import type { ModelSelectionGit } from "./model-selection-git.mts";

export interface ObserverOverlayPlan {
  selectionId: string; effective: ModelEffort; installedName: string; previousAnchorText: string;
  agentFile: string; agentText: string; snapshotFile: string; snapshotText: string;
  overlayFile: string; overlayText: string; anchorFile: string; anchorText: string;
}

// Amendment 6 of the #737 design: the observation-only updater keeps the
// committed selection. It verifies the anchored generation, re-renders the
// observer with its recorded effective pair from the current clean source,
// records a scoped overlay and updates only anchor.overlay. It never reads the
// user layer or a catalog, so a pending user edit stays inactive.
export function planObserverOverlay(codexHome: string, git: ModelSelectionGit, anchorText: string): ObserverOverlayPlan {
  git.assertClean();
  const head = git.head();
  const state = verifyAnchoredState(codexHome, git, anchorText);
  const { verified } = state;
  const { authority, agentText, effective } = observerOverlayAuthority(verified.inventory, verified.resolution, head, git.at(head));
  const agentTarget = `agents/${authority.installedName}.toml`;
  const snapshot = state.actualOutputs.find((row) => row.target === MODEL_DISPATCH_SNAPSHOT_TARGET)!;
  const snapshotText = observerOverlaySnapshot(snapshot.content, verified, authority);
  const outputs = state.actualOutputs.map((row) => row.target === agentTarget ? { ...row, content: agentText }
    : row === snapshot ? { ...row, content: snapshotText } : row);
  const overlayText = `${JSON.stringify(createObserverModelOverlay({ base: verified, authority, predecessorOutputs: state.actualOutputs, outputs }), null, 2)}\n`;
  const file = (relative: string) => path.join(codexHome, ...relative.split("/"));
  return { selectionId: verified.selectionId, effective, installedName: authority.installedName, previousAnchorText: anchorText,
    agentFile: file(agentTarget), agentText, snapshotFile: file(MODEL_DISPATCH_SNAPSHOT_TARGET), snapshotText,
    overlayFile: file(MODEL_SELECTION_FILES.overlay), overlayText, anchorFile: file(MODEL_SELECTION_FILES.anchor),
    anchorText: renderAnchor({ ...state.anchor, overlay: { target: MODEL_SELECTION_FILES.overlay, sha256: sha256(overlayText), sourceRevision: head } }) };
}
