import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildAgentInventory } from "./model-agent-inventory.mts";
import { acquireSelectionLock, ANCHOR_REFUSAL, homeFile, MODEL_SELECTION_FILES, observerOverlayAuthority, parseAnchor, readOptional,
  renderAnchor, sha256, verifyAnchoredState, type ModelSelectionAnchor } from "./model-selection-anchor.mts";
import { ModelSelectionRefusal } from "./model-selection-git.mts";

const refusal = (code: string) => (error: unknown) => error instanceof ModelSelectionRefusal && error.code === code;
const anchor: ModelSelectionAnchor = { schemaVersion: 1, kind: "codex-model-selection-anchor", selectionId: "a".repeat(64), sourceRevision: "b".repeat(40),
  receipt: { target: MODEL_SELECTION_FILES.receipt, sha256: "c".repeat(64) }, overlay: null };

test("the anchor grammar is exact and round-trips", () => {
  assert.deepEqual(parseAnchor(renderAnchor(anchor)), anchor);
  const overlay = { ...anchor, overlay: { target: MODEL_SELECTION_FILES.overlay, sha256: "d".repeat(64), sourceRevision: "e".repeat(40) } };
  assert.deepEqual(parseAnchor(renderAnchor(overlay)), overlay);
  const broken: unknown[] = [
    [], { ...anchor, extra: 1 }, { ...anchor, schemaVersion: 2 }, { ...anchor, kind: "other" }, { ...anchor, selectionId: "A".repeat(64) },
    { ...anchor, selectionId: 1 }, { ...anchor, sourceRevision: "b".repeat(39) }, { ...anchor, sourceRevision: null },
    { ...anchor, receipt: { target: "orchestra/other.json", sha256: "c".repeat(64) } }, { ...anchor, receipt: { target: MODEL_SELECTION_FILES.receipt } },
    { ...anchor, receipt: { target: MODEL_SELECTION_FILES.receipt, sha256: 7 } },
    { ...anchor, overlay: {} }, { ...anchor, overlay: { ...overlay.overlay, target: "x" } }, { ...anchor, overlay: { ...overlay.overlay, sha256: "z" } },
    { ...anchor, overlay: { ...overlay.overlay, sha256: 1 } }, { ...anchor, overlay: { ...overlay.overlay, sourceRevision: "e" } },
    { ...anchor, overlay: { ...overlay.overlay, sourceRevision: 1 } },
  ];
  for (const value of broken) assert.throws(() => parseAnchor(JSON.stringify(value)), refusal(ANCHOR_REFUSAL.anchorInvalid), JSON.stringify(value));
  for (const text of ["{", '{"schemaVersion":1,"schemaVersion":1}', "x".repeat(9000)]) {
    assert.throws(() => parseAnchor(text), refusal(ANCHOR_REFUSAL.anchorInvalid));
  }
});

test("home paths stay inside the home, and only ENOENT reads as absent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-anchor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(homeFile(root, "agents/a.toml"), path.join(root, "agents", "a.toml"));
  for (const bad of ["../escape", "agents/../x", ".hidden", "a//b", "x".repeat(513)]) {
    assert.throws(() => homeFile(root, bad), refusal(ANCHOR_REFUSAL.anchorInvalid), bad);
  }
  assert.throws(() => homeFile(root, "../x", "custom-code"), refusal("custom-code"));
  assert.equal(readOptional(path.join(root, "missing.json"), "unreadable"), undefined);
  assert.throws(() => readOptional(root, "unreadable"), refusal("unreadable"), "a directory is unreadable, not absent");
  fs.writeFileSync(path.join(root, "present.json"), "x");
  assert.equal(readOptional(path.join(root, "present.json"), "unreadable"), "x");
});

test("the selection lock admits one writer and is released by its holder", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = acquireSelectionLock(root);
  assert.equal(fs.readFileSync(path.join(root, "orchestra", "model-selection.lock"), "utf8"), `${process.pid}\n`);
  assert.throws(() => acquireSelectionLock(root), refusal(ANCHOR_REFUSAL.locked));
  release();
  acquireSelectionLock(root)();
  assert.equal(fs.existsSync(path.join(root, "orchestra", "model-selection.lock")), false);
});

test("overlay authority needs both the observer binding and its recorded effective pair", () => {
  const row = { sourceProvider: "kherep", securityPolicyDigest: "1".repeat(64), sourceSha256: "2".repeat(64), codeBound: false };
  const builderOnly = buildAgentInventory([{ ...row, sourcePath: "claude/agents/kherep-builder.md", installedName: "kherep-builder", role: "builder" }]);
  const withObserver = buildAgentInventory([{ ...row, sourcePath: "codex/agents/codex-obs.md", installedName: "codex-obs", role: "observer" }]);
  const reader = { read: () => "Observe.\n", list: () => [] };
  const effective = { model: "gpt-6-luna", effort: "medium" };
  const bindingId = withObserver.agents[0]!.bindingId;
  assert.throws(() => observerOverlayAuthority(builderOnly, { agents: [{ bindingId, effective }] }, "3".repeat(40), reader), refusal(ANCHOR_REFUSAL.stateInvalid));
  assert.throws(() => observerOverlayAuthority(withObserver, { agents: [] }, "3".repeat(40), reader), refusal(ANCHOR_REFUSAL.stateInvalid));
  const built = observerOverlayAuthority(withObserver, { agents: [{ bindingId, effective }] }, "3".repeat(40), reader);
  assert.equal(built.authority.installedName, "codex-obs");
  assert.match(built.agentText, /^model_reasoning_effort = "medium"$/m);
});

test("a receipt whose pinned bytes are not a receipt shape is refused before any Git read", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-anchor-shape-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = { head: () => { throw new Error("unused"); }, assertClean: () => undefined, at: () => { throw new Error("no Git read"); }, workingTree: () => { throw new Error("unused"); } };
  const receipt = { inventory: { agents: [] }, outputs: [], resolution: { agents: [] } };
  for (const text of ["not json", JSON.stringify({ ...receipt, inventory: { agents: [null] } }), JSON.stringify({ ...receipt, outputs: {} })]) {
    fs.mkdirSync(path.join(root, "orchestra"), { recursive: true });
    fs.writeFileSync(path.join(root, MODEL_SELECTION_FILES.receipt), text);
    const pinned = renderAnchor({ ...anchor, receipt: { target: MODEL_SELECTION_FILES.receipt, sha256: sha256(text) } });
    assert.throws(() => verifyAnchoredState(root, git, pinned), refusal(ANCHOR_REFUSAL.stateInvalid), text);
  }
});
