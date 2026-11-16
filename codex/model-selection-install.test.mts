import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { checkObservationPublisher, installObservationPublisher } from "./install-observations.mts";
import { dispatchPolicy, validate } from "./hooks/dispatch-contract-guard.mts";
import { observationPrompt } from "./hooks/observation-stop.mts";
import { ANCHOR_REFUSAL } from "./lib/model-selection-anchor.mts";
import { GIT_REFUSAL, modelSelectionGit, ModelSelectionRefusal } from "./lib/model-selection-git.mts";
import { CATALOG_REQUIRED } from "./lib/model-selection-install.mts";
import { legacyModelHome } from "./lib/model-policy.fixture.mts";
import { assertNoWrites, catalog, fakeGit, files, fixture, newerCatalog, overlayReader, policyWith, refusal, repoRoot, tree, write } from "./model-selection-install.fixture.mts";

const R1 = "1".repeat(40), R2 = "2".repeat(40);
const real = () => modelSelectionGit(repoRoot);

test("a fresh install writes the anchor last, pins the receipt and serves a coherent guard snapshot", (t) => {
  const f = fixture(t);
  let anchorAt = 0, writes = 0;
  const result = f.run({ modelCatalog: catalog(), afterWrite(count) {
    writes = count;
    if (!anchorAt && fs.existsSync(f.file(files.anchor))) anchorAt = count;
  } });
  assert.ok(anchorAt > 0 && anchorAt === writes, "the anchor is the final write");
  assert.equal(result.modelSelection.noOp, false);
  const anchor = JSON.parse(f.read(files.anchor));
  assert.equal(anchor.selectionId, result.modelSelection.selectionId);
  assert.equal(anchor.sourceRevision, real().head());
  assert.equal(anchor.overlay, null);
  assert.deepEqual(JSON.parse(f.read(files.parity)).modelResolution, { schemaVersion: 2, selectionId: anchor.selectionId,
    anchor: files.anchor, receipt: files.receipt });
  assert.equal(fs.existsSync(f.file(files.lock)), false, "the single-writer lock is released");
  assert.equal(fs.existsSync(f.file(files.user)), false, "the installer never writes the user layer");
  assert.deepEqual(result.modelSelection.resolution.roles.observer.effective, { model: "gpt-6-luna", effort: "medium" });
  assert.deepEqual([f.field("codex-obs", "model"), f.field("codex-obs", "model_reasoning_effort"), f.field("codex-obs", "sandbox_mode")],
    ["gpt-6-luna", "medium", "read-only"]);
  const snapshot = JSON.parse(f.read(files.snapshot));
  assert.equal(snapshot.agents["claude-obs"].enforcePin, undefined, "no dispatch pin is installed");
  const policy = dispatchPolicy(snapshot);
  const dispatch = (input: object) => validate({ tool_name: "spawn_agent", tool_input: {
    task_name: "observe", message: "- measured: `synthetic-test` -> 1 pass\n- relayed: operator in test fixture", agent_type: "codex-obs", ...input } }, policy);
  assert.equal(dispatch({}), null, "the native TOML carries the effective pair; no argument pin");
  assert.equal(dispatch({ model: "gpt-6-astra", reasoning_effort: "high" }), null, "any installed visible model is supportable");
  assert.match(dispatch({ model: "gpt-0-unknown" }) ?? "", /Unsupported Kherep agent model/);
  assert.match(f.read("hooks/kherep-maestro/codex-observation-stop.mts"), /exact model and model_reasoning_effort from its installed agent TOML/);
  assert.doesNotMatch(observationPrompt(), /reasoning_effort low|Luna/);
});

test("an exact reinstall is a no-op that ignores a newer supplied catalog and is not gated by B1", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const pinned = () => [files.anchor, files.receipt, files.snapshot, "agents/codex-obs.toml"].map(f.read);
  const before = pinned();
  const dirty = fakeGit({ assertClean() { throw new ModelSelectionRefusal(GIT_REFUSAL.sourceDirty); } });
  const result = f.run({ modelCatalog: newerCatalog(), modelSelectionGit: dirty });
  assert.equal(result.modelSelection.noOp, true);
  assert.deepEqual(pinned(), before);
});

test("A1: an anchor-less earlier install refuses before any write; one refresh mints V2 and resets a managed Low observer", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  for (const name of [files.anchor, files.receipt]) fs.rmSync(f.file(name));
  write(f.file("agents/codex-obs.toml"), f.read("agents/codex-obs.toml").replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "low"'));
  assertNoWrites(f, (afterWrite) => f.run({ modelCatalog: catalog(), afterWrite }), refusal(ANCHOR_REFUSAL.refreshRequired));
  const refreshed = f.run({ modelCatalog: catalog(), refreshModels: true });
  assert.equal(refreshed.modelSelection.receipt.migration.kind, "fresh");
  assert.equal(f.field("codex-obs", "model_reasoning_effort"), "medium");
  assert.equal(JSON.parse(f.read(files.anchor)).selectionId, refreshed.modelSelection.selectionId);
  assert.equal(f.run().modelSelection.noOp, true, "the next ordinary install is anchored");
});

test("B1: a selection change needs a resolved HEAD and a clean source, checked before any write", (t) => {
  const f = fixture(t);
  const headless = fakeGit({ head: () => { throw new ModelSelectionRefusal(GIT_REFUSAL.headUnresolved); } });
  const dirty = fakeGit({ assertClean() { throw new ModelSelectionRefusal(GIT_REFUSAL.sourceDirty); } });
  assertNoWrites(f, (afterWrite) => f.run({ modelCatalog: catalog(), modelSelectionGit: headless, afterWrite }), refusal(GIT_REFUSAL.headUnresolved));
  assertNoWrites(f, (afterWrite) => f.run({ modelCatalog: catalog(), modelSelectionGit: dirty, afterWrite }), refusal(GIT_REFUSAL.sourceDirty));
  assertNoWrites(f, (afterWrite) => f.run({ modelSelectionGit: dirty, afterWrite }), refusal(GIT_REFUSAL.sourceDirty));
  f.run({ modelCatalog: catalog() });
  write(f.file(files.user), JSON.stringify({ roles: { support: { effort: "high" } } }));
  assertNoWrites(f, (afterWrite) => f.run({ modelCatalog: catalog(), modelSelectionGit: dirty, afterWrite }), refusal(GIT_REFUSAL.sourceDirty));
  assertNoWrites(f, (afterWrite) => f.run({ afterWrite }), refusal(CATALOG_REQUIRED));
});

test("tampered anchored state, an unreadable user layer and a held lock refuse before any write", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const mutations: [string, (file: string) => void, string][] = [
    [files.anchor, (file) => write(file, "{"), ANCHOR_REFUSAL.anchorInvalid],
    [files.anchor, (file) => write(file, fs.readFileSync(file, "utf8").replace(/"sourceRevision": "[a-f0-9]{40}"/, `"sourceRevision": "${"0".repeat(40)}"`)), GIT_REFUSAL.revisionAbsent],
    [files.anchor, (file) => write(file, fs.readFileSync(file, "utf8").replace(/"selectionId": "[a-f0-9]{64}"/, `"selectionId": "${"0".repeat(64)}"`)), ANCHOR_REFUSAL.anchorInvalid],
    [files.receipt, (file) => fs.rmSync(file), ANCHOR_REFUSAL.receiptMissing],
    [files.receipt, (file) => write(file, `${fs.readFileSync(file, "utf8")} `), ANCHOR_REFUSAL.receiptConflict],
    ["agents/codex-obs.toml", (file) => write(file, fs.readFileSync(file, "utf8").replace('"medium"', '"low"')), ANCHOR_REFUSAL.stateInvalid],
    [files.snapshot, (file) => write(file, fs.readFileSync(file, "utf8").replace('"role": "observer"', '"role": "builder"')), ANCHOR_REFUSAL.stateInvalid],
    ["agents/kherep-builder.toml", (file) => fs.rmSync(file), ANCHOR_REFUSAL.outputMissing],
    [files.user, (file) => fs.mkdirSync(file, { recursive: true }), ANCHOR_REFUSAL.userUnreadable],
    [files.lock, (file) => write(file, "4242\n"), ANCHOR_REFUSAL.locked],
  ];
  for (const [relative, mutate, code] of mutations) {
    const file = f.file(relative), saved = fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : undefined;
    mutate(file);
    assertNoWrites(f, (afterWrite) => f.run({ modelCatalog: catalog(), afterWrite }), refusal(code));
    fs.rmSync(file, { recursive: true, force: true });
    if (saved) fs.writeFileSync(file, saved);
  }
  assert.equal(f.run().modelSelection.noOp, true, "the restored home verifies again");
});

test("a changed shipped default is retained without a throw until an explicit refresh adopts it", (t) => {
  const f = fixture(t);
  const head = real().head(), low = overlayReader(real().at(head), { "codex/parity/model-policy.toml": policyWith("observer", "low") });
  f.run({ modelCatalog: catalog(), modelSelectionGit: fakeGit({ head: R1, revisions: { [R1]: low },
    workingTree: overlayReader(real().workingTree(), { "codex/parity/model-policy.toml": policyWith("observer", "low") }) }) });
  assert.equal(f.field("codex-obs", "model_reasoning_effort"), "low");
  const upgrade = fakeGit({ head: R2, revisions: { [R1]: low, [R2]: real().at(head) } });
  const kept = f.run({ modelSelectionGit: upgrade });
  assert.equal(kept.modelSelection.noOp, false);
  assert.equal(f.field("codex-obs", "model_reasoning_effort"), "low", "the managed Low default is retained");
  assert.equal(kept.modelSelection.resolution.roles.observer.provenance.effort.origin, "retained-managed");
  assert.equal(JSON.parse(f.read(files.anchor)).sourceRevision, R2);
  const refreshed = f.run({ modelSelectionGit: upgrade, modelCatalog: newerCatalog(), refreshModels: true });
  assert.equal(f.field("codex-obs", "model_reasoning_effort"), "medium");
  assert.equal(f.field("kherep-builder", "model"), "gpt-7-sol", "refresh adopts the newest default generation");
  assert.equal(refreshed.modelSelection.receipt.migration.kind, "predecessor");
});

test("user choices win field by field and a broker effort override survives reinstall and upgrade byte for byte", (t) => {
  const f = fixture(t);
  const userText = `${JSON.stringify({ roles: { builder: { model: "gpt-6-astra" } }, agents: { "atlassian-broker": { effort: "high" } } }, null, 2)}\n`;
  write(f.file(files.user), userText);
  f.run({ modelCatalog: catalog() });
  const check = () => {
    assert.deepEqual([f.field("atlassian-broker", "model"), f.field("atlassian-broker", "model_reasoning_effort")], ["gpt-6-luna", "high"]);
    assert.deepEqual([f.field("kherep-builder", "model"), f.field("kherep-builder", "model_reasoning_effort")], ["gpt-6-astra", "high"]);
    assert.deepEqual(JSON.parse(f.read(files.snapshot)).projectedAgents["atlassian-broker"], { role: "broker", model: "gpt-6-luna", reasoning: "high" });
    assert.equal(f.read(files.user), userText, "the user layer keeps its exact bytes");
  };
  check();
  assert.equal(f.run().modelSelection.noOp, true);
  check();
  const head = real().head();
  const upgraded = f.run({ modelSelectionGit: fakeGit({ head: R2, revisions: { [R2]: real().at(head) } }) });
  assert.equal(upgraded.modelSelection.noOp, false);
  assert.equal(upgraded.modelSelection.resolution.agents.find((agent) => agent.installedName === "atlassian-broker")!.provenance.effort.origin, "user-agent");
  check();
  write(f.file(files.user), JSON.stringify({ roles: { builder: { model: "gpt-6-astra" } } }));
  const upgradedGit = fakeGit({ head: R2, revisions: { [R2]: real().at(head) } });
  assertNoWrites(f, (afterWrite) => f.run({ modelSelectionGit: upgradedGit, afterWrite }), refusal(CATALOG_REQUIRED));
  f.run({ modelSelectionGit: upgradedGit, modelCatalog: catalog() });
  assert.equal(f.field("atlassian-broker", "model_reasoning_effort"), "medium", "deleting the override falls back to the recorded default");
  write(f.file(files.user), JSON.stringify({ roles: { observer: { model: "gpt-0-missing" } } }));
  assertNoWrites(f, (afterWrite) => f.run({ modelSelectionGit: upgradedGit, modelCatalog: catalog(), afterWrite }), /unsupported-model/);
});

test("a failure at every model-selection write boundary rolls the generation back", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const watched = () => tree(f.codexHome);
  const strip = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).filter(([name]) => !name.startsWith("backups")));
  const before = strip(watched());
  const changed = (relative: string, text: string) => fs.existsSync(f.file(relative)) && f.read(relative) !== text;
  const baseline = Object.fromEntries([files.snapshot, files.receipt, files.parity, files.anchor].map((name) => [name, f.read(name)]));
  for (const boundary of [files.snapshot, files.receipt, files.parity, files.anchor]) {
    assert.throws(() => f.run({ modelCatalog: newerCatalog(), refreshModels: true, afterWrite() {
      if (changed(boundary, baseline[boundary]!)) throw new Error(`synthetic failure after ${boundary}`);
    } }), new RegExp(`synthetic failure after ${boundary.replaceAll(".", "\\.")}`));
    assert.deepEqual(strip(watched()), before, boundary);
  }
  let failVerify = false;
  const failing = fakeGit({ at() { if (failVerify) throw new ModelSelectionRefusal(GIT_REFUSAL.revisionAbsent); } });
  assert.throws(() => f.run({ modelCatalog: newerCatalog(), refreshModels: true, modelSelectionGit: failing, afterWrite() {
    if (changed(files.anchor, baseline[files.anchor]!)) failVerify = true;
  } }), refusal(GIT_REFUSAL.revisionAbsent));
  assert.deepEqual(strip(watched()), before, "post-anchor verification failure");
});

test("a concurrent edit is never overwritten by rollback, and a user edit after planning is refused under the lock", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const baseline = f.read(files.parity);
  const builder = f.file("agents/kherep-builder.toml");
  let concurrent = "";
  assert.throws(() => f.run({ modelCatalog: newerCatalog(), refreshModels: true, afterWrite() {
    if (concurrent || f.read(files.parity) === baseline) return;
    concurrent = `${fs.readFileSync(builder, "utf8")}# concurrent edit\n`;
    fs.writeFileSync(builder, concurrent);
  } }), (error: Error) => /install-rollback-ownership-conflict: 1 target/.test(error.message)
    && (error.cause as Error).message === "model-selection-readback-conflict");
  assert.equal(fs.readFileSync(builder, "utf8"), concurrent, "the other writer's bytes stay in place");
  assert.equal(fs.existsSync(f.file(files.lock)), false);
  const g = fixture(t);
  g.run({ modelCatalog: catalog() });
  write(g.file(files.user), JSON.stringify({ roles: { support: { effort: "high" } } }));
  let edited = false;
  const racing = fakeGit({ assertClean() {
    real().assertClean();
    if (!edited) { edited = true; write(g.file(files.user), JSON.stringify({ roles: { support: { effort: "low" } } })); }
  } });
  const before = tree(g.root);
  let writes = 0;
  assert.throws(() => g.run({ modelCatalog: catalog(), modelSelectionGit: racing, afterWrite() { writes++; } }), refusal("model-selection-plan: user-input-changed"));
  assert.equal(writes, 0);
  const after = tree(g.root);
  assert.deepEqual(Object.keys(after).filter((name) => after[name] !== before[name]), [path.relative(g.root, g.file(files.user))], "only the user's own edit changed");
});

test("the observation-only updater keeps the committed pair, ignores a pending user edit and pins its overlay", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const committed = JSON.parse(f.read(files.anchor));
  write(f.file(files.user), JSON.stringify({ agents: { "codex-obs": { effort: "high" } } }));
  const options = { codexHome: f.codexHome, workspace: f.workspace };
  const dirty = fakeGit({ assertClean() { throw new ModelSelectionRefusal(GIT_REFUSAL.sourceDirty); } });
  assertNoWrites(f, (afterWrite) => installObservationPublisher({ ...options, modelSelectionGit: dirty, afterWrite }), refusal(GIT_REFUSAL.sourceDirty));
  assert.equal(checkObservationPublisher(options).modelSelection.kind, "v2-overlay");
  const first = installObservationPublisher(options).receipt;
  assert.deepEqual(first.modelSelection, { kind: "v2-overlay", selectionId: committed.selectionId, effectivePairUnchanged: true, observer: "codex-obs" });
  assert.equal(f.field("codex-obs", "model_reasoning_effort"), "medium", "the pending user edit stays inactive");
  const anchor = JSON.parse(f.read(files.anchor));
  assert.equal(anchor.receipt.sha256, committed.receipt.sha256, "only the overlay entry changed");
  assert.equal(anchor.overlay.sourceRevision, real().head());
  assert.equal(JSON.parse(f.read(files.snapshot)).modelSelectionOverlay.overlayId, JSON.parse(f.read(files.overlay)).identity.overlayId);
  installObservationPublisher(options);
  assert.notEqual(JSON.parse(f.read(files.anchor)).overlay.sha256, anchor.overlay.sha256, "a rerun chains a new overlay on the verified one");
  const saved = f.read(files.overlay);
  write(f.file(files.overlay), `${saved} `);
  assertNoWrites(f, (afterWrite) => f.run({ modelCatalog: catalog(), afterWrite }), refusal(ANCHOR_REFUSAL.stateInvalid));
  fs.rmSync(f.file(files.overlay));
  assertNoWrites(f, (afterWrite) => f.run({ modelCatalog: catalog(), afterWrite }), refusal(ANCHOR_REFUSAL.outputMissing));
  write(f.file(files.overlay), saved);
  assertNoWrites(f, (afterWrite) => f.run({ afterWrite }), refusal(CATALOG_REQUIRED));
  f.run({ modelCatalog: catalog() });
  assert.equal(f.field("codex-obs", "model_reasoning_effort"), "high", "a full install applies the edit");
  assert.equal(JSON.parse(f.read(files.anchor)).overlay, null, "a new generation clears the overlay");
});

test("a failed observation-only update rolls the overlay back and restores the anchor last", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const before = Object.fromEntries([files.anchor, files.snapshot, "agents/codex-obs.toml"].map((name) => [name, f.read(name)]));
  let failVerify = false;
  const failing = fakeGit({ at() { if (failVerify) throw new ModelSelectionRefusal(GIT_REFUSAL.revisionAbsent); } });
  assert.throws(() => installObservationPublisher({ codexHome: f.codexHome, workspace: f.workspace, modelSelectionGit: failing, afterWrite() {
    if (f.read(files.anchor) !== before[files.anchor]) failVerify = true;
  } }), /observation-install-failed-rolled-back/);
  assert.equal(failVerify, true, "the failure came after the anchor write");
  for (const [name, text] of Object.entries(before)) assert.equal(f.read(name), text, name);
  assert.equal(fs.existsSync(f.file(files.overlay)), false);
});

test("inputs that change after planning are refused under the lock, and the lock is always released", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  write(f.file(files.user), JSON.stringify({ roles: { support: { effort: "high" } } }));
  const race = (act: () => void) => fakeGit({ assertClean() { real().assertClean(); act(); } });
  const builder = f.file("agents/kherep-builder.toml"), saved = fs.readFileSync(builder);
  assert.throws(() => f.run({ modelCatalog: catalog(), modelSelectionGit: race(() => fs.rmSync(builder, { force: true })) }),
    refusal("model-selection-plan: output-precondition-conflict"));
  fs.writeFileSync(builder, saved);
  const anchorText = f.read(files.anchor);
  assert.throws(() => f.run({ modelCatalog: catalog(), modelSelectionGit: race(() => write(f.file(files.anchor), `${anchorText} `)) }),
    refusal("model-selection-plan: output-precondition-conflict"));
  write(f.file(files.anchor), anchorText);
  assert.equal(fs.existsSync(f.file(files.lock)), false);
  write(f.file(files.user), "{ not json");
  assertNoWrites(f, (afterWrite) => f.run({ afterWrite }), /model-policy-user: json: invalid-json/);
  fs.rmSync(f.file(files.user));
  fs.rmSync(f.file("backups"), { recursive: true, force: true });
  write(f.file("backups"), "a file where the backup directory goes\n");
  assert.throws(() => f.run({ modelCatalog: newerCatalog(), refreshModels: true }), /EEXIST|ENOTDIR/);
  assert.throws(() => installObservationPublisher({ codexHome: f.codexHome, workspace: f.workspace }), /EEXIST|ENOTDIR/);
  assert.equal(fs.existsSync(f.file(files.lock)), false, "a failed backup directory releases the lock");
  fs.rmSync(f.file("backups"));
  let calls = 0;
  const moving = fakeGit({ at() { if (++calls === 2) write(f.file(files.anchor), `${anchorText} `); } });
  assert.throws(() => installObservationPublisher({ codexHome: f.codexHome, workspace: f.workspace, modelSelectionGit: moving }),
    refusal("model-selection-plan: output-precondition-conflict"));
  assert.equal(fs.existsSync(f.file(files.lock)), false);
});

test("the observation-only updater refuses a config.toml without exactly one ordered managed block", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const start = "# >>> Kherep Codex Maestro >>>", end = "# <<< Kherep Codex Maestro <<<";
  const config = f.read("config.toml");
  for (const broken of [config.replace(start, "# moved"), config.replace(start, "# s").replace(end, start).replace("# s", end),
    `${config}\n${start}\n`, `${config}\n${end}\n`]) {
    write(f.file("config.toml"), broken);
    assert.throws(() => checkObservationPublisher({ codexHome: f.codexHome, workspace: f.workspace }), /observation-managed-block-unrecognized/);
  }
});

test("the V1 compatibility updater keeps refusing an incoherent anchor-less home", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  legacyModelHome(f.codexHome);
  const options = { codexHome: f.codexHome, workspace: f.workspace };
  assert.equal(checkObservationPublisher(options).modelSelection.kind, "v1-compatibility");
  const edit = (relative: string, change: (value: Record<string, any>) => void) => {
    const saved = f.read(relative), value = JSON.parse(saved);
    change(value);
    write(f.file(relative), JSON.stringify(value));
    return () => write(f.file(relative), saved);
  };
  for (const [relative, change, code] of [
    [files.parity, (value: Record<string, any>) => { delete value.projection; }, /observation-role-unrecognized/],
    [files.parity, (value: Record<string, any>) => { value.projection.agentDefaults["codex-obs"].reasoning = "low"; }, /observation-pin-unrecognized/],
    [files.snapshot, (value: Record<string, any>) => { value.agents["claude-obs"].enforcePin = false; }, /observation-pin-unrecognized/],
  ] as const) {
    const restore = edit(relative, change);
    assert.throws(() => checkObservationPublisher(options), code);
    restore();
  }
});

test("the observation-only CLI reports a model-selection refusal by its fixed code", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  write(f.file(files.receipt), `${f.read(files.receipt)} `);
  // Node 24.1 prints the type-stripping ExperimentalWarning on stderr; the assertions compare stderr exactly.
  const cli = (...args: string[]) => spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", path.join(repoRoot, "codex", "install-observations.mts"), ...args], { encoding: "utf8" });
  const refused = cli("--check", "--codex-home", f.codexHome, "--workspace", f.workspace);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, `${ANCHOR_REFUSAL.receiptConflict}\n`);
  assert.equal(cli("--check").stderr, "observation-upgrade-unavailable\n");
  assert.equal(cli("--check", "--codex-home", "relative-home", "--workspace", "relative-workspace").stderr, "observation-explicit-targets-required\n");
});

// Lead review of #737, item 1. The plugin CLI rewrites config.toml after the
// installer staged and wrote it; a later failure must still restore the
// operator's original bytes, with no ownership conflict.
test("rollback restores a config.toml the plugin CLI rewrote", (t) => {
  const f = fixture(t);
  // Mixed line endings: the installer normalizes and writes config.toml before registration.
  const original = 'model_reasoning_effort = "xhigh"\r\n\r\n[plugins."kherep-maestro@kherep"]\nenabled = false\n';
  write(f.file("config.toml"), original);
  let registered = false;
  const runCodex = (args: string[]): string => {
    if (args.join(" ") === "plugin marketplace list --json") return JSON.stringify({ marketplaces: [] });
    if (args.join(" ") === "plugin add kherep-maestro@kherep") {
      fs.appendFileSync(f.file("config.toml"), '\n[plugins."kherep-maestro@kherep"]\nenabled = true\n');
      registered = true;
    }
    return "{}";
  };
  assert.throws(() => f.run({ modelCatalog: catalog(), skipPluginRegistration: false, runCodex, afterWrite() {
    if (registered) throw new Error("synthetic failure after plugin registration");
  } }), (error: Error) => error.message === "synthetic failure after plugin registration");
  assert.equal(registered, true);
  assert.equal(f.read("config.toml"), original, "the operator's enabled = false survives the rollback");
  assert.equal(fs.existsSync(f.file(files.lock)), false);
});

// Lead review of #737, item 3. A rollback that itself throws still releases the lock.
test("the selection lock is released even when rollback itself fails", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const breakRollback = () => { fs.rmSync(f.file("backups"), { recursive: true, force: true }); throw new Error("synthetic failure"); };
  assert.throws(() => f.run({ modelCatalog: newerCatalog(), refreshModels: true, afterWrite: breakRollback }), /ENOENT/);
  assert.equal(fs.existsSync(f.file(files.lock)), false, "installer");
  assert.throws(() => installObservationPublisher({ codexHome: f.codexHome, workspace: f.workspace, afterWrite: breakRollback }), /ENOENT/);
  assert.equal(fs.existsSync(f.file(files.lock)), false, "observation-only updater");
});

// Design "Root": the top-level model and effort are native operator state. An
// ordinary install keeps them, absence included; only the explicit root apply
// writes the effective root pair, user root choices included.
test("the root model and effort change only through the explicit root apply", (t) => {
  const f = fixture(t);
  write(f.file("config.toml"), "# operator config without a root model\n");
  const ordinary = f.run({ modelCatalog: catalog() });
  assert.deepEqual(ordinary.receipt.reasoningEffort, { status: "preserved-absent", value: null });
  assert.deepEqual(ordinary.receipt.rootModelPolicy, { status: "not-applied" });
  assert.doesNotMatch(f.read("config.toml"), /^model(?:_reasoning_effort)? =/m);
  write(f.file(files.user), JSON.stringify({ roles: { root: { effort: "high" } } }));
  const applied = f.run({ modelCatalog: catalog(), applyRootModelPolicy: true });
  const config = f.read("config.toml");
  assert.match(config, /^model = "gpt-6.10-sol"$/m);
  assert.match(config, /^model_reasoning_effort = "high"$/m);
  assert.deepEqual(applied.receipt.rootModelPolicy, { status: "applied", model: "gpt-6.10-sol", effort: "high",
    configSha256: createHash("sha256").update(config).digest("hex") });
  const kept = f.run();
  assert.deepEqual(kept.receipt.reasoningEffort, { status: "preserved-existing", value: "high" });
  assert.equal(f.read("config.toml"), config, "an ordinary reinstall keeps the applied root lines");
});
