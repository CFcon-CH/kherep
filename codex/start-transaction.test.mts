import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { workingTreeReader } from "./lib/model-selection-git.mts";
import { sha256 } from "./lib/model-selection-anchor.mts";
import { prepareInstallSelection } from "./lib/model-selection-install.mts";
import { planObserverOverlay } from "./lib/model-selection-observer.mts";
import type { RenderedModelOutput } from "./lib/model-resolution-receipt.mts";
import { assertModelOnly, updateParity } from "./lib/start-model-artifacts.mts";
import { catalog, fakeGit, files, fixture, newerCatalog, overlayReader, repoRoot, write } from "./model-selection-install.fixture.mts";
import { startCodex } from "./start.mts";

function installed(t: TestContext, applyRootModelPolicy = true) {
  const f = fixture(t);
  fs.mkdirSync(f.workspace, { recursive: true });
  const revision = "5".repeat(40), source = workingTreeReader(repoRoot);
  const git = fakeGit({ head: revision, revisions: { [revision]: source }, workingTree: source, assertClean() {} });
  f.run({ modelCatalog: catalog(), applyRootModelPolicy, modelSelectionGit: git });
  const options = { workspace: f.workspace, codexHome: f.codexHome, executable: process.execPath, git, prepareOnly: true as const };
  const deps = { readCatalog: async () => newerCatalog(), launch: async () => { assert.fail("unexpected launch"); } };
  return { f, options, deps, source };
}

test("preparation fills a previously unapplied root model summary and preserves its other bytes", async (t) => {
  const { f, options, deps } = installed(t, false);
  const untouched = '"unrelatedMetadata" : [ 1,  2 ]';
  write(f.file(files.parity), f.read(files.parity).replace('"rootModelPolicy": {', `"rootModelPolicy": {\n    ${untouched},`).replaceAll("\n", "\r\n"));
  assert.equal(JSON.parse(f.read(files.parity)).rootModelPolicy.status, "not-applied");
  assert.equal(await startCodex(options, deps), 0);
  const parity = f.read(files.parity), root = JSON.parse(parity).rootModelPolicy;
  assert.deepEqual({ status: root.status, model: root.model, effort: root.effort }, { status: "applied", model: "gpt-7-sol", effort: "xhigh" });
  assert.match(root.configSha256, /^[a-z0-9]{64}$/);
  assert.ok(parity.includes(untouched));
  assert.doesNotMatch(parity, /(?<!\r)\n/);
  assert.match(f.read("config.toml"), /^model = "gpt-7-sol"\r?\n/);

  const incomplete = JSON.parse(parity);
  incomplete.rootModelPolicy = {};
  const anchor = f.read(files.anchor);
  write(f.file(files.parity), JSON.stringify(incomplete, null, 2));
  assert.equal(await startCodex(options, deps), 0);
  assert.deepEqual(JSON.parse(f.read(files.parity)).rootModelPolicy,
    { status: root.status, model: root.model, effort: root.effort, configSha256: root.configSha256 });
  assert.equal(f.read(files.anchor), anchor);
});

test("prelaunch refuses concurrent changes and rolls back only its own writes", async (t) => {
  const { f, options, deps } = installed(t);
  const original = new Map(["config.toml", files.anchor, files.receipt, files.snapshot, files.parity, "agents/kherep-builder.toml"]
    .map((name) => [name, f.read(name)]));
  const config = original.get("config.toml")!;
  const external = `${config}\n# independently updated\n`;
  const forbiddenWrite = () => assert.fail("precondition conflict must precede the first write");
  await assert.rejects(startCodex(options, { ...deps, readCatalog: async () => {
    write(f.file("config.toml"), external);
    return newerCatalog();
  }, afterWrite: forbiddenWrite }), { message: "codex-start-precondition-conflict" });
  assert.equal(f.read("config.toml"), external);
  assert.equal(f.read(files.anchor), original.get(files.anchor));
  write(f.file("config.toml"), config);

  const preference = '{"roles":{"builder":{"effort":"medium"}}}\n';
  await assert.rejects(startCodex(options, { ...deps, readCatalog: async () => {
    write(f.file(files.user), preference);
    return newerCatalog();
  }, afterWrite: forbiddenWrite }), { message: "codex-start-precondition-conflict" });
  assert.equal(f.read(files.user), preference);
  fs.unlinkSync(f.file(files.user));

  const foreignReceipt = `${original.get(files.receipt)} `;
  await assert.rejects(startCodex(options, { ...deps, afterWrite: (target) => {
    if (target === "agents/kherep-builder.toml") write(f.file(files.receipt), foreignReceipt);
  } }), { message: "codex-start-transaction-failed" });
  assert.equal(f.read(files.receipt), foreignReceipt);
  for (const [target, value] of original) if (target !== files.receipt) assert.equal(f.read(target), value, target);
  write(f.file(files.receipt), original.get(files.receipt)!);

  await assert.rejects(startCodex(options, { ...deps, afterWrite: (target) => {
    if (target === "config.toml") write(f.file(target), external);
  } }), { message: "codex-start-rollback-conflict" });
  assert.equal(f.read("config.toml"), external);
  for (const [target, value] of original) if (target !== "config.toml") assert.equal(f.read(target), value, target);

  write(f.file("config.toml"), config);
  const otherAnchor = `${original.get(files.anchor)} `;
  await assert.rejects(startCodex(options, { ...deps, afterWrite: (target) => {
    if (target === files.anchor) write(f.file(target), otherAnchor);
  } }), { message: "codex-start-rollback-conflict" });
  assert.equal(f.read(files.anchor), otherAnchor);
  for (const [target, value] of original) if (target !== files.anchor) assert.equal(f.read(target), value, target);
  assert.equal(fs.existsSync(f.file(files.lock)), false);
});

test("refuses source policy drift and unrelated dispatch snapshot changes", async (t) => {
  const { f, options, deps, source } = installed(t);
  const policyPath = "codex/parity/model-policy.toml", capabilityPath = "codex/parity/capabilities.json";
  const policy = source.read(policyPath), capability = JSON.parse(source.read(capabilityPath));
  const anchor = f.read(files.anchor), snapshot = f.read(files.snapshot);
  const overrides: Record<string, string>[] = [{ [policyPath]: `${policy}\n# synthetic source change\n` },
    { [capabilityPath]: JSON.stringify({ ...capability, syntheticUnrelatedCapability: true }) }];
  for (const edits of overrides) {
    const git = { ...options.git, workingTree: () => overlayReader(source, edits) };
    await assert.rejects(startCodex({ ...options, git }, { ...deps, afterWrite: () => { assert.fail("unexpected write"); } }),
      { message: "codex-start-source-or-target-drift" });
    assert.equal(f.read(files.anchor), anchor);
    assert.equal(f.read(files.snapshot), snapshot);
  }
  const selection = prepareInstallSelection({ ...options, repoRoot, refresh: true, catalog: newerCatalog() });
  assert.ok(selection.previous);
  assert.doesNotThrow(() => assertModelOnly(selection, selection.previous!));
  for (const change of [
    { target: "orchestra/unowned-fixture.json" }, { kind: "dispatch-snapshot" }, { sourceBinding: "unrelated-binding" },
  ] satisfies Partial<RenderedModelOutput>[]) {
    const [first, ...rest] = selection.outputs;
    assert.ok(first);
    const outputs = [{ ...first, ...change }, ...rest];
    assert.throws(() => assertModelOnly({ ...selection, outputs }, selection.previous!), { message: "codex-start-source-or-target-drift" });
  }
});

test("refuses unsafe CLI and Desktop contexts before model writes or activation", async (t) => {
  const { f, options, deps } = installed(t);
  const home = fs.realpathSync.native(f.codexHome);
  const catalogCall = async () => { assert.fail("unexpected native catalog read"); };
  const activation = async () => { assert.fail("unexpected activation"); };
  await assert.rejects(startCodex({ ...options, workspace: "relative" }, { ...deps, readCatalog: catalogCall }), { message: "codex-start-context-invalid" });
  const excludedWorkspace = path.join(f.workspace, ".claude");
  fs.mkdirSync(excludedWorkspace);
  await assert.rejects(startCodex({ ...options, workspace: excludedWorkspace }, { ...deps, readCatalog: catalogCall }), { message: "codex-start-context-invalid" });
  await assert.rejects(startCodex({ ...options, executable: "relative" }, { ...deps, readCatalog: catalogCall }), { message: "codex-start-executable-unavailable" });
  await assert.rejects(startCodex({ ...options, desktop: true }, { ...deps, readCatalog: catalogCall,
    desktop: { home: "relative", probe: catalogCall, activate: activation } }), { message: "codex-start-desktop-home-unsupported" });
  await assert.rejects(startCodex({ ...options, desktop: true }, { ...deps, readCatalog: catalogCall,
    desktop: { home: f.root, probe: catalogCall, activate: activation } }), { message: "codex-start-desktop-home-unsupported" });
  let probes = 0;
  await assert.rejects(startCodex({ ...options, desktop: true }, { ...deps, desktop: { home,
    probe: async () => path.join(f.root, `synthetic-package-${++probes}`, "codex.exe"), activate: activation } }),
    { message: "codex-start-desktop-package-changed" });
  assert.equal(probes, 2);
  const anchor = f.read(files.anchor);
  fs.unlinkSync(f.file(files.anchor));
  await assert.rejects(startCodex(options, { ...deps, readCatalog: catalogCall }), { message: "codex-start-anchor-required" });
  write(f.file(files.anchor), anchor);
});

test("refuses malformed parity ownership metadata before writing any model targets", async (t) => {
  const { f, options, deps } = installed(t);
  const parity = f.read(files.parity), anchor = f.read(files.anchor);
  const source = JSON.parse(parity);
  const wrongRole = JSON.parse(parity);
  wrongRole.projection.agentDefaults["kherep-builder"].role = "observer";
  const selection = prepareInstallSelection({ ...options, repoRoot, refresh: true, catalog: newerCatalog() });
  assert.ok(selection.previous);
  assert.throws(() => updateParity("[]", selection.previous!, selection, selection.selectionId, f.read("config.toml")),
    { message: "codex-start-json-invalid" });
  for (const [candidate, message] of [
    [[], "source-or-target-drift"],
    [wrongRole, "parity-ownership-conflict"],
    [{ ...source, rootModelPolicy: null }, "parity-ownership-conflict"],
    [{ ...source, reasoningEffort: { status: "preserved" } }, "json-target-missing"],
  ] as const) {
    const text = JSON.stringify(candidate);
    write(f.file(files.parity), text);
    await assert.rejects(startCodex(options, { ...deps, afterWrite: () => { assert.fail("unexpected write"); } }), { message: `codex-start-${message}` });
    assert.equal(f.read(files.anchor), anchor);
    assert.equal(f.read(files.parity), text);
  }
});

test("refuses unowned receipt targets and preserves a legitimate installed observer overlay", async (t) => {
  const { f, options, deps } = installed(t);
  const readCatalog = async () => { assert.fail("unexpected catalog for an ineligible anchor"); };
  const before = { anchor: f.read(files.anchor), receipt: f.read(files.receipt) };
  const receipt = JSON.parse(before.receipt), anchor = JSON.parse(before.anchor);
  receipt.outputs[0].target = "orchestra/unowned-fixture.json";
  const invalidReceipt = JSON.stringify(receipt);
  anchor.receipt.sha256 = sha256(invalidReceipt);
  write(f.file(files.receipt), invalidReceipt);
  write(f.file(files.anchor), JSON.stringify(anchor));
  await assert.rejects(startCodex(options, { ...deps, readCatalog }), { message: "model-selection-installed-state-invalid" });

  write(f.file(files.anchor), before.anchor);
  write(f.file(files.receipt), before.receipt);
  const overlay = planObserverOverlay(options.codexHome, options.git, before.anchor);
  for (const [file, content] of [[overlay.agentFile, overlay.agentText], [overlay.snapshotFile, overlay.snapshotText],
    [overlay.overlayFile, overlay.overlayText], [overlay.anchorFile, overlay.anchorText]] as const) write(file, content);
  await assert.rejects(startCodex(options, { ...deps, readCatalog }), { message: "codex-start-observer-overlay-unsupported" });
  assert.equal(f.read(files.anchor), overlay.anchorText);
  assert.equal(f.read(files.overlay), overlay.overlayText);
  assert.equal(f.read(files.snapshot), overlay.snapshotText);
});
