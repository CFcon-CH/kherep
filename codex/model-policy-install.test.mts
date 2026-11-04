import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { install, type InstallOptions } from "./install.mts";
import { dispatchPolicy, validate } from "./hooks/dispatch-contract-guard.mts";
import type { Capabilities, ProjectionReceipt } from "./lib/contracts.mts";
import { fixtureModels } from "./lib/model-policy.fixture.mts";
import { parseModelPolicy, resolveModels, type ModelResolution } from "./lib/model-policy.mts";
import { checkObservationPublisher, installObservationPublisher } from "./install-observations.mts";
import { turnContext } from "./hooks/kherep-maestro-context.mts";

interface ModelReceipt { modelResolution: ModelResolution; projection: ProjectionReceipt }
const catalog = () => ({ complete: true, models: structuredClone(fixtureModels) });
const newerCatalog = () => ({ complete: true, models: [...structuredClone(fixtureModels), {
  ...structuredClone(fixtureModels[1]), id: "gpt-7-sol", model: "gpt-7-sol",
}] });

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

function fixture(t: TestContext, personalDesigner = false) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kherep-model-install-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const codexHome = path.join(root, "synthetic codex home");
  const workspace = path.join(root, "synthetic workspace");
  const registryFile = path.join(root, "synthetic registry.json");
  const capabilities = JSON.parse(fs.readFileSync(new URL("./parity/capabilities.json", import.meta.url), "utf8")) as Capabilities;
  write(registryFile, JSON.stringify({ mcpServers: Object.fromEntries(capabilities.mcpServers.map((name) => [name, {
    type: "http", url: `https://example.invalid/${name}`,
  }])) }));
  write(path.join(codexHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n');
  const personalToml = 'name = "code-architect"\ndescription = "Personal fixture"\n';
  if (personalDesigner) write(path.join(codexHome, "agents", "code-architect.toml"), personalToml);
  const calls: string[][] = [];
  const options: InstallOptions = {
    codexHome, workspace, registryFile, claudeRegistryFile: registryFile,
    claudeConfigDir: path.join(root, "synthetic claude home"), homeDir: root,
    memoryProvider: { provider: "unconfigured" }, nodePath: process.execPath,
    controlPlaneOutbox: path.join(root, "synthetic outbox"), installAtlassianTools: false,
    skipPluginRegistration: true, resolveRegistryRuntime: () => "synthetic-runtime", log: () => {},
    runCodex(args) { calls.push(args); return args[0] === "--version" ? "codex-cli synthetic" : "ok"; },
  };
  const guardFile = path.join(codexHome, "hooks", "parity", "capabilities.json");
  const receiptFile = path.join(codexHome, "orchestra", "parity-receipt.json");
  const run = (overrides: InstallOptions = {}) => install({ ...options, ...overrides });
  return { root, codexHome, workspace, guardFile, receiptFile, run, calls, personalToml };
}

function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      assert.equal(entry.isSymbolicLink(), false, "fixture never follows symlinks");
      if (entry.isDirectory()) { entries[relative] = "directory"; walk(file); }
      else entries[relative] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  };
  if (fs.existsSync(root)) walk(root);
  return entries;
}

function readInstallation(f: ReturnType<typeof fixture>) {
  const receipt = JSON.parse(fs.readFileSync(f.receiptFile, "utf8")) as ModelReceipt;
  const snapshot = JSON.parse(fs.readFileSync(f.guardFile, "utf8")) as Capabilities & { modelResolution: ModelResolution };
  assert.deepEqual(snapshot.modelResolution, receipt.modelResolution);
  assert.deepEqual(snapshot.projectedAgents, receipt.projection.agentDefaults);
  const policy = dispatchPolicy(snapshot);
  for (const [name, defaults] of Object.entries(receipt.projection.agentDefaults)) {
    const toml = fs.readFileSync(path.join(f.codexHome, "agents", `${name}.toml`), "utf8");
    const field = (key: string) => JSON.parse(toml.split("\n").find((line) => line.startsWith(`${key} = `))!.slice(key.length + 3));
    assert.equal(field("name"), name);
    assert.equal(field("model"), defaults.model, name);
    assert.equal(field("model_reasoning_effort"), defaults.reasoning, name);
    assert.deepEqual(policy.agentDefaults.get(name), { model: defaults.model, reasoning: defaults.reasoning });
  }
  const actualFiles = fs.readdirSync(path.join(f.codexHome, "agents")).filter((file) => file.endsWith(".toml"));
  const expectedFiles = Object.keys(receipt.projection.agentDefaults).map((name) => `${name}.toml`);
  if (actualFiles.includes("code-architect.toml") && !expectedFiles.includes("code-architect.toml")) expectedFiles.push("code-architect.toml");
  assert.deepEqual(actualFiles.sort(), expectedFiles.sort());
  assert.equal(fs.readFileSync(path.join(f.codexHome, "orchestra", "model-policy.toml"), "utf8"),
    fs.readFileSync(new URL("./parity/model-policy.toml", import.meta.url), "utf8"));
  assert.equal(parseModelPolicy(fs.readFileSync(path.join(f.codexHome, "orchestra/model-policy.toml"), "utf8")).roles.observer.reasoning, "medium");
  assert.deepEqual(receipt.modelResolution.roles.observer, { model: "gpt-6-luna", reasoning: "medium" });
  assert.deepEqual(receipt.projection.agentDefaults["codex-obs"], { role: "observer", model: "gpt-6-luna", reasoning: "medium" });
  assert.equal(parseModelPolicy(fs.readFileSync(path.join(f.codexHome, "orchestra/model-policy.toml"), "utf8")).roles.broker.reasoning, "medium");
  assert.deepEqual(receipt.modelResolution.roles.broker, { model: "gpt-6-luna", reasoning: "medium" });
  assert.deepEqual(receipt.projection.agentDefaults["atlassian-broker"], { role: "broker", model: "gpt-6-luna", reasoning: "medium" });
  assert.equal(snapshot.agents["atlassian-broker"].reasoning, "medium");
  assert.equal(snapshot.agents["claude-obs"].enforcePin, true);
  assert.equal(snapshot.agents["claude-obs"].sandbox, "read-only");
  assert.equal(snapshot.agents["claude-obs"].reasoning, "medium");
  assert.match(fs.readFileSync(path.join(f.codexHome, "agents/codex-obs.toml"), "utf8"), /sandbox_mode = "read-only"/);
  assert.equal(fs.readFileSync(path.join(f.codexHome, "hooks/kherep-maestro-context.mts"), "utf8"),
    fs.readFileSync(new URL("./hooks/kherep-maestro-context.mts", import.meta.url), "utf8"));
  assert.match(turnContext(), /the exact model and model_reasoning_effort from its installed agent TOML/);
  assert.doesNotMatch(turnContext(), /reasoning_effort low/);
  assert.equal(f.calls.length, 0, "fixture neither launches Codex nor registers external plugins");
  return { receipt, snapshot, policy };
}

test("first install rejects absent or incomplete model evidence before any write or runtime call", (t) => {
  for (const modelCatalog of [undefined, { complete: false, models: fixtureModels }, { complete: true, models: [] }]) {
    const f = fixture(t);
    const before = tree(f.root);
    let writes = 0;
    let failure: unknown;
    try { f.run({ modelCatalog, afterWrite() { writes++; } }); } catch (error) { failure = error; }
    assert.ok(failure instanceof Error, "invalid catalog must fail installation");
    assert.equal(writes, 0, "preflight must precede transactions, copies and projections");
    assert.deepEqual(tree(f.root), before, "no directories, backups or files may be created on preflight rejection");
    assert.equal(f.calls.length, 0);
    assert.match((failure as Error).message, /catalog|model evidence/i);
  }
});

for (const personalDesigner of [false, true]) test(`first install shares native TOMLs, receipt and snapshot with ${personalDesigner ? "colliding personal" : "normal"} designer`, (t) => {
  const f = fixture(t, personalDesigner);
  f.run({ modelCatalog: catalog() });
  const { receipt, snapshot, policy } = readInstallation(f);
  const designers = Object.entries(receipt.projection.agentDefaults).filter(([, defaults]) => defaults.role === "designer");
  assert.equal(designers.length, 1);
  const [name, designer] = designers[0];
  assert.equal(name, personalDesigner ? "feature-dev-code-architect" : "code-architect");
  assert.equal(designer.model, receipt.modelResolution.roles.designer.model);
  if (personalDesigner) assert.equal(fs.readFileSync(path.join(f.codexHome, "agents", "code-architect.toml"), "utf8"), f.personalToml);
  assert.equal(policy.pins.get("codex-obs"), snapshot.agents["claude-obs"].model);
  const input = { task_name: "observe", message: "- measured: `synthetic-test` -> 1 pass\n- relayed: operator in test fixture", agent_type: "codex-obs" };
  const dispatch = (overrides: object) => validate({ tool_name: "spawn_agent", tool_input: { ...input, ...overrides } }, policy);
  assert.match(dispatch({}) ?? "", /pinned/);
  assert.match(dispatch({ model: designer.model }) ?? "", /pinned/);
  assert.equal(dispatch({ model: policy.pins.get("codex-obs"), reasoning_effort: "low" }), null);
  assert.equal(dispatch({ model: policy.pins.get("codex-obs"), reasoning_effort: "medium" }), null);
});

test("normal reinstall preserves exact resolution despite a newer supplied catalog", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const before = readInstallation(f);
  const agentsBefore = tree(path.join(f.codexHome, "agents"));
  f.run({ modelCatalog: newerCatalog() });
  const after = readInstallation(f);
  assert.deepEqual(after.receipt.modelResolution, before.receipt.modelResolution);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.deepEqual(tree(path.join(f.codexHome, "agents")), agentsBefore);
});

test("explicit refresh changes all consuming artifacts from one new resolution", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const before = readInstallation(f).receipt.modelResolution;
  f.run({ modelCatalog: newerCatalog(), refreshModels: true });
  const after = readInstallation(f).receipt.modelResolution;
  assert.equal(after.roles.builder.model, "gpt-7-sol");
  assert.equal(after.roles.root.model, "gpt-7-sol");
  assert.notEqual(after.catalogSha256, before.catalogSha256);
  assert.equal(after.policySha256, before.policySha256);
});

test("refresh failure after projected plugin snapshot rolls native agents, snapshot and receipt back together", (t) => {
  const f = fixture(t, true);
  f.run({ modelCatalog: catalog() });
  const before = readInstallation(f);
  const agentsBefore = tree(path.join(f.codexHome, "agents"));
  const snapshotBefore = fs.readFileSync(f.guardFile, "utf8");
  const receiptBefore = fs.readFileSync(f.receiptFile, "utf8");
  let reachedSnapshot = false;
  assert.throws(() => f.run({ modelCatalog: newerCatalog(), refreshModels: true, afterWrite() {
    if (!fs.existsSync(f.guardFile)) return;
    const installed = JSON.parse(fs.readFileSync(f.guardFile, "utf8")) as Capabilities;
    if (installed.projectedAgents?.["kherep-builder"]?.model !== "gpt-7-sol") return;
    assert.equal(installed.projectedAgents["feature-dev-code-architect"].role, "designer");
    reachedSnapshot = true;
    throw new Error("synthetic failure after projection snapshot");
  } }), /synthetic failure after projection snapshot/);
  assert.equal(reachedSnapshot, true, "failure must occur after the final plugin-aware guard snapshot write");
  assert.equal(fs.readFileSync(f.guardFile, "utf8"), snapshotBefore);
  assert.equal(fs.readFileSync(f.receiptFile, "utf8"), receiptBefore);
  assert.deepEqual(tree(path.join(f.codexHome, "agents")), agentsBefore);
  assert.deepEqual(readInstallation(f).receipt.modelResolution, before.receipt.modelResolution);
});

test("observation-only updater preserves the validated Medium installation", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const before = readInstallation(f);
  assert.equal(checkObservationPublisher({ codexHome: f.codexHome, workspace: f.workspace }).pinUnchanged, true);
  assert.equal(installObservationPublisher({ codexHome: f.codexHome, workspace: f.workspace }).receipt.installedHashesMatch, true);
  assert.deepEqual(readInstallation(f), before);
});

for (const mismatch of ["receipt", "snapshot", "native"] as const) test(`observation updater refuses Low ${mismatch} mismatch before writes`, (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  if (mismatch === "native") {
    const file = path.join(f.codexHome, "agents/codex-obs.toml");
    write(file, fs.readFileSync(file, "utf8").replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "low"'));
  } else {
    const file = mismatch === "receipt" ? f.receiptFile : f.guardFile;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    (mismatch === "receipt" ? value.projection.agentDefaults["codex-obs"] : value.agents["claude-obs"]).reasoning = "low";
    write(file, JSON.stringify(value));
  }
  const before = tree(f.root);
  let writes = 0;
  const options = { codexHome: f.codexHome, workspace: f.workspace, afterWrite() { writes++; } };
  assert.throws(() => checkObservationPublisher(options), /observation-(pin-unrecognized|agent-drift)/);
  assert.throws(() => installObservationPublisher(options), /observation-(pin-unrecognized|agent-drift)/);
  assert.equal(writes, 0);
  assert.deepEqual(tree(f.root), before);
});

test("coherent synthetic Low installation requires refresh, then ordinary reinstall retains Medium", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const { receipt, snapshot } = readInstallation(f);
  const policyFile = path.join(f.codexHome, "orchestra/model-policy.toml");
  const lowText = fs.readFileSync(policyFile, "utf8").replace(/(\[roles\.observer\]\s+family = "luna"\s+reasoning = )"medium"/, '$1"low"');
  const low = resolveModels(parseModelPolicy(lowText), catalog());
  assert.equal(low.roles.observer.reasoning, "low");
  receipt.modelResolution = snapshot.modelResolution = low;
  receipt.projection.agentDefaults["codex-obs"].reasoning = "low";
  snapshot.projectedAgents!["codex-obs"].reasoning = snapshot.agents["claude-obs"].reasoning = "low";
  write(policyFile, lowText);
  write(f.receiptFile, JSON.stringify(receipt));
  write(f.guardFile, JSON.stringify(snapshot));
  const agentFile = path.join(f.codexHome, "agents/codex-obs.toml");
  write(agentFile, fs.readFileSync(agentFile, "utf8").replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "low"'));
  const before = tree(f.root);
  let writes = 0;
  assert.throws(() => f.run({ modelCatalog: newerCatalog(), afterWrite() { writes++; } }), /explicit refresh/);
  assert.throws(() => installObservationPublisher({ codexHome: f.codexHome, workspace: f.workspace, afterWrite() { writes++; } }), /explicit refresh/);
  assert.equal(writes, 0);
  assert.deepEqual(tree(f.root), before);
  f.run({ modelCatalog: catalog(), refreshModels: true });
  const refreshed = readInstallation(f), agents = tree(path.join(f.codexHome, "agents"));
  assert.equal(refreshed.receipt.modelResolution.roles.observer.reasoning, "medium");
  f.run({ modelCatalog: newerCatalog() });
  const after = readInstallation(f);
  assert.deepEqual(after.receipt.modelResolution, refreshed.receipt.modelResolution);
  assert.deepEqual(after.snapshot, refreshed.snapshot);
  assert.deepEqual(tree(path.join(f.codexHome, "agents")), agents);
});

test("coherent Broker Low refuses ordinary writes, rolls failed refresh back, then retains Medium", (t) => {
  const f = fixture(t);
  f.run({ modelCatalog: catalog() });
  const { receipt, snapshot } = readInstallation(f);
  const policyFile = path.join(f.codexHome, "orchestra/model-policy.toml");
  const agentFile = path.join(f.codexHome, "agents/atlassian-broker.toml");
  const lowText = fs.readFileSync(policyFile, "utf8").replace(/(\[roles\.broker\]\s+family = "luna"\s+reasoning = )"medium"/, '$1"low"');
  const low = resolveModels(parseModelPolicy(lowText), catalog());
  assert.equal(low.policySha256, "e0ad1f9e2f1a657f27b8a9b29e9983b15cf517859cae3531276e46d3a05bd615");
  receipt.modelResolution = snapshot.modelResolution = low;
  receipt.projection.agentDefaults["atlassian-broker"].reasoning = "low";
  snapshot.projectedAgents!["atlassian-broker"].reasoning = snapshot.agents["atlassian-broker"].reasoning = "low";
  write(policyFile, lowText);
  write(f.receiptFile, JSON.stringify(receipt));
  write(f.guardFile, JSON.stringify(snapshot));
  write(agentFile, fs.readFileSync(agentFile, "utf8").replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "low"'));
  assert.deepEqual(dispatchPolicy(snapshot).agentDefaults.get("atlassian-broker"), low.roles.broker);
  const before = tree(f.root);
  let writes = 0;
  assert.throws(() => f.run({ modelCatalog: newerCatalog(), afterWrite() { writes++; } }), /explicit refresh/);
  assert.equal(writes, 0);
  assert.deepEqual(tree(f.root), before);
  const prior = [policyFile, agentFile, f.receiptFile, f.guardFile].map(file => fs.readFileSync(file));
  const agentsBefore = tree(path.join(f.codexHome, "agents"));
  let reachedSnapshot = false;
  assert.throws(() => f.run({ modelCatalog: catalog(), refreshModels: true, afterWrite() {
    const installed = JSON.parse(fs.readFileSync(f.guardFile, "utf8")) as Capabilities;
    if (installed.projectedAgents?.["atlassian-broker"]?.reasoning !== "medium") return;
    const installedReceipt = JSON.parse(fs.readFileSync(f.receiptFile, "utf8")) as ModelReceipt;
    if (installedReceipt.modelResolution.roles.broker.reasoning !== "medium") return;
    assert.equal(parseModelPolicy(fs.readFileSync(policyFile, "utf8")).roles.broker.reasoning, "medium");
    assert.match(fs.readFileSync(agentFile, "utf8"), /model_reasoning_effort = "medium"/);
    reachedSnapshot = true;
    throw new Error("synthetic broker refresh snapshot failure");
  } }), /synthetic broker refresh snapshot failure/);
  assert.equal(reachedSnapshot, true);
  [policyFile, agentFile, f.receiptFile, f.guardFile].forEach((file, i) => assert.deepEqual(fs.readFileSync(file), prior[i]));
  assert.deepEqual(tree(path.join(f.codexHome, "agents")), agentsBefore);
  f.run({ modelCatalog: catalog(), refreshModels: true });
  const refreshed = readInstallation(f), agents = tree(path.join(f.codexHome, "agents"));
  assert.deepEqual(refreshed.receipt.modelResolution.roles.broker, { model: low.roles.broker.model, reasoning: "medium" });
  for (const role of ["root", "designer", "builder", "support", "researcher", "observer"] as const)
    assert.deepEqual(refreshed.receipt.modelResolution.roles[role], low.roles[role]);
  assert.deepEqual(refreshed.receipt.modelResolution.supportedModels, low.supportedModels);
  assert.equal(refreshed.receipt.modelResolution.catalogSha256, low.catalogSha256);
  f.run({ modelCatalog: newerCatalog() });
  const after = readInstallation(f);
  assert.deepEqual(after.receipt.modelResolution, refreshed.receipt.modelResolution);
  assert.deepEqual(after.snapshot, refreshed.snapshot);
  assert.deepEqual(tree(path.join(f.codexHome, "agents")), agents);
});
