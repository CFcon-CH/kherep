import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { acquireSelectionLock } from "./lib/model-selection-anchor.mts";
import { type ModelCatalog } from "./lib/model-policy.mts";
import { workingTreeReader } from "./lib/model-selection-git.mts";
import { catalog, fakeGit, files, fixture, repoRoot, tree, write } from "./model-selection-install.fixture.mts";
import { parseStartArgs, startCodex } from "./start.mts";

const families = ["sol", "astra", "luna", "terra"];
const model = (id: string, hidden = false) => ({ ...catalog().models[0]!, id, model: id, hidden });
const oldCatalog = (): ModelCatalog => ({ complete: true, models: families.map((family) => model(`gpt-6.9-${family}`)) });
const newCatalog = (): ModelCatalog => ({ complete: true, models: [...oldCatalog().models,
  ...families.map((family) => model(`gpt-6.10-${family}`)), model("gpt-8-sol", true),
  model("gpt-9-sol-preview"), model("gpt-9-sol-20261118")] });

function installed(f: ReturnType<typeof fixture>) {
  fs.mkdirSync(f.workspace, { recursive: true });
  const revision = "4".repeat(40), source = workingTreeReader(repoRoot);
  const git = fakeGit({ head: revision, revisions: { [revision]: source }, workingTree: source, assertClean() {} });
  f.run({ modelCatalog: oldCatalog(), applyRootModelPolicy: true, modelSelectionGit: git });
  return { codexHome: fs.realpathSync.native(f.codexHome), workspace: fs.realpathSync.native(f.workspace), executable: process.execPath, git };
}

test("the managed CLI launches only with fixed arguments after a fresh validated selection on each start", async (t) => {
  const f = fixture(t);
  const options = installed(f);
  const userText = '{ "roles": { "root": { "effort": "xhigh" }, "broker": { "effort": "high" } } }\n';
  write(f.file(files.user), userText);
  const saved = '{"model":"gpt-6.9-sol"}\n';
  // A directory in the place of another saved-session file makes any attempt to
  // parse it invalid. The prelaunch only writes/reads explicit model targets.
  write(f.file("sessions/synthetic.jsonl"), saved);
  fs.mkdirSync(f.file("sessions/unreadable.jsonl"));
  const configLine = "model   =   'gpt-6.9-sol' # model comment";
  const unchangedParity = '"syntheticUnrelated" : [ 41 , 42 ]';
  write(f.file("config.toml"), f.read("config.toml").replace('model = "gpt-6.9-sol"', configLine));
  write(f.file(files.parity), f.read(files.parity).replace('"rootModelPolicy": {', `"rootModelPolicy": {\n    ${unchangedParity},`));
  const beforeConfig = f.read("config.toml"), beforeParity = JSON.parse(f.read(files.parity));
  let reads = 0, launches = 0;
  const began = Promise.withResolvers<void>(), finished = Promise.withResolvers<number>();
  const dependencies = {
    readCatalog: async (request: { cwd?: string; codexHome?: string; executable?: string }) => {
      assert.deepEqual(request, { cwd: options.workspace, codexHome: options.codexHome, executable: options.executable });
      reads++;
      return newCatalog();
    },
    launch: async (request: { cwd: string; codexHome: string; executable: string; args: string[] }) => {
      launches++;
      assert.deepEqual(request, { cwd: options.workspace, codexHome: options.codexHome, executable: options.executable,
        args: ["--no-daemon", "--cd", options.workspace, "--model", "gpt-6.10-sol"] });
      assert.equal(f.field("kherep-builder", "model"), "gpt-6.10-sol");
      assert.equal(f.field("code-architect", "model"), "gpt-6.10-astra");
      assert.equal(f.field("code-explorer", "model"), "gpt-6.10-terra");
      assert.equal(f.field("codex-obs", "model"), "gpt-6.10-luna");
      assert.equal(f.field("atlassian-broker", "model_reasoning_effort"), "high");
      const anchor = JSON.parse(f.read(files.anchor));
      const snapshot = JSON.parse(f.read(files.snapshot));
      const parity = JSON.parse(f.read(files.parity));
      assert.equal(parity.modelResolution.selectionId, anchor.selectionId);
      assert.equal(snapshot.modelResolution.selectionId, anchor.selectionId);
      assert.deepEqual(parity.projection.agentDefaults, snapshot.projectedAgents);
      assert.equal(parity.rootModelPolicy.model, "gpt-6.10-sol");
      assert.deepEqual(parity.hooks, beforeParity.hooks);
      assert.equal(f.read("config.toml"), beforeConfig.replace(configLine, configLine.replace("6.9", "6.10")));
      assert.ok(f.read(files.parity).includes(unchangedParity));
      assert.equal(f.read(files.user), userText);
      assert.equal(f.read("sessions/synthetic.jsonl"), saved);
      if (launches === 1) began.resolve();
      return { finished: launches === 1 ? finished.promise : Promise.resolve(0) };
    },
  };
  const first = startCodex(options, dependencies);
  try {
    await Promise.race([began.promise, first]);
    await Promise.resolve();
    assert.equal(fs.existsSync(f.file(files.lock)), false, "the first session is still running and the start lock is free");
    const after = tree(f.root);
    assert.equal(await startCodex(options, dependencies), 0);
    assert.equal(reads, 2);
    assert.equal(launches, 2);
    const current = tree(f.root);
    const differences = [...new Set([...Object.keys(after), ...Object.keys(current)])].filter((name) => current[name] !== after[name]);
    assert.deepEqual(differences.map((name) => name.replace(/model-start-[^\\/]+/g, "model-start-<fixture>")), []);
  } finally { finished.resolve(0); }
  assert.equal(await first, 0);
});

test("unsafe catalog evidence never updates the installation or launches", async (t) => {
  const f = fixture(t);
  const options = installed(f);
  const unsupported = newCatalog();
  unsupported.models.find((row) => row.model === "gpt-6.10-sol")!.supportedReasoningEfforts = [{ reasoningEffort: "low" }];
  const refusal = async (readCatalog: () => Promise<unknown>, code: string) => {
    const before = tree(f.root);
    await assert.rejects(startCodex(options, { readCatalog, launch: async () => { assert.fail("unexpected launch"); } }), new RegExp(code));
    assert.deepEqual(tree(f.root), before);
  };
  await refusal(async () => ({ ...newCatalog(), complete: false }), "codex-start-catalog-invalid");
  await refusal(async () => { throw new Error("sensitive diagnostic"); }, "codex-start-catalog-unavailable$");
  await refusal(async () => ({ complete: true, models: newCatalog().models.filter((row) => !row.model.endsWith("-luna")) }), "codex-start-family-missing");
  await refusal(async () => ({ complete: true, models: [...oldCatalog().models, model("gpt-7-sol"), model("gpt-7.0-sol")] }), "codex-start-family-ambiguous");
  await refusal(async () => ({ complete: true, models: oldCatalog().models.map((row) => row.model.endsWith("-astra") ? model("gpt-6.8-astra") : row) }), "codex-start-catalog-regressed");
  await refusal(async () => unsupported, "codex-start-latest-effort-unsupported");
  write(f.file(files.user), '{"roles":{"builder":{"model":"gpt-6.9-sol"}}}\n');
  await refusal(async () => newCatalog(), "codex-start-model-pin-conflict");
});

test("repairs only the verified immediate predecessor parity pointer without starting another generation", async (t) => {
  const f = fixture(t);
  const options = { ...installed(f), prepareOnly: true as const };
  const predecessor = JSON.parse(f.read(files.anchor)).selectionId as string;
  const deps = { readCatalog: async () => newCatalog(), launch: async () => { assert.fail("unexpected launch"); } };
  assert.equal(await startCodex(options, deps), 0);

  const anchor = f.read(files.anchor), receipt = f.read(files.receipt);
  const current = JSON.parse(anchor).selectionId as string;
  assert.equal(JSON.parse(receipt).inputs.previousSelectionId, predecessor);
  assert.notEqual(current, predecessor);
  const parity = f.read(files.parity);
  const stale = parity.replace(`"selectionId": "${current}"`, `"selectionId": "${predecessor}"`);
  assert.notEqual(stale, parity);
  const writes: string[] = [];
  const afterWrite = (target: string) => { writes.push(target); };

  for (const invalid of [stale.replace(predecessor, "a".repeat(64)), stale.replace(files.anchor, "orchestra/foreign-anchor.json")]) {
    write(f.file(files.parity), invalid);
    await assert.rejects(startCodex(options, { ...deps, afterWrite }), /codex-start-parity-ownership-conflict/);
    assert.equal(f.read(files.parity), invalid);
    assert.deepEqual(writes, []);
  }

  write(f.file(files.parity), stale);
  assert.equal(await startCodex(options, { ...deps, afterWrite }), 0);
  assert.deepEqual(writes, [files.parity]);
  assert.equal(f.read(files.parity), parity);
  assert.equal(f.read(files.anchor), anchor);
  assert.equal(f.read(files.receipt), receipt);

  write(f.file(files.parity), stale);
  write(f.file(files.receipt), `${receipt} `);
  await assert.rejects(startCodex(options, { ...deps, afterWrite }), /model-selection-receipt-conflict/);
  assert.deepEqual(writes, [files.parity]);
  assert.equal(f.read(files.parity), stale);
});

test("project overrides, held lock and a partial transactional failure block launch", async (t) => {
  const f = fixture(t);
  const options = installed(f);
  const launch = async () => { assert.fail("unexpected launch"); };
  const readCatalog = async () => newCatalog();
  const projectConfig = path.join(f.workspace, ".codex", "config.toml");
  write(projectConfig, 'model = "gpt-6.9-sol"\n');
  await assert.rejects(startCodex(options, { readCatalog, launch }), /codex-start-project-config/);
  fs.unlinkSync(projectConfig);
  const release = acquireSelectionLock(f.codexHome);
  try {
    await assert.rejects(startCodex(options, { readCatalog, launch }), /model-selection-locked/);
  } finally { release(); }
  const before = tree(f.codexHome);
  await assert.rejects(startCodex(options, { readCatalog, launch, afterWrite: (target: string) => {
    if (target === "config.toml") throw new Error("synthetic write failure");
  } }), /codex-start-transaction-failed/);
  const noBackup = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith("backups")));
  assert.deepEqual(noBackup(tree(f.codexHome)), noBackup(before));
});

test("managed arguments reject profile, model, command and other native tails", () => {
  const cwd = path.resolve("fixture cwd");
  assert.deepEqual(parseStartArgs([], cwd), { workspace: cwd });
  assert.deepEqual(parseStartArgs(["--workspace", cwd], cwd), { workspace: cwd });
  assert.deepEqual(parseStartArgs(["--desktop", "--workspace", cwd, "--prepare-only"], cwd), { workspace: cwd, desktop: true, prepareOnly: true });
  for (const args of [["--workspace", "relative"], ["--profile", "custom"], ["-m", "old"], ["resume"], ["--workspace", cwd, "--help"]]) {
    assert.throws(() => parseStartArgs(args, cwd), /codex-start-invalid-arguments/);
  }
});

test("Windows Desktop uses the discovered package catalog and waits for installed-only cold activation", async (t) => {
  const f = fixture(t);
  const options = installed(f);
  const packaged = path.join(f.root, "package", "app", "resources", "codex.exe");
  const calls: string[] = [];
  const desktop = {
    home: options.codexHome,
    probe: async () => { calls.push("probe"); return packaged; },
    activate: async (executable: string) => {
      calls.push("activate");
      assert.equal(executable, packaged);
      assert.equal(f.field("codex-obs", "model"), "gpt-6.10-luna");
      assert.ok(fs.existsSync(f.file(files.lock)));
    },
  };
  const deps = { desktop,
    readCatalog: async (context: { executable: string }) => { calls.push("catalog"); assert.equal(context.executable, packaged); return newCatalog(); },
    launch: async () => { assert.fail("CLI launch during Desktop activation"); } };
  assert.equal(await startCodex({ ...options, desktop: true }, deps), 0);
  assert.deepEqual(calls, ["probe", "catalog", "probe", "activate"]);
  assert.equal(fs.existsSync(f.file(files.lock)), false);
  desktop.probe = async () => { throw new Error("app is already running"); };
  await assert.rejects(startCodex({ ...options, desktop: true }, deps), /codex-start-preflight-failed/);
  assert.deepEqual(calls, ["probe", "catalog", "probe", "activate"]);
});
