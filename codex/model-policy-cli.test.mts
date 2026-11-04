import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { installFromCli, parseArgs } from "./install.mts";
import type { Capabilities } from "./lib/contracts.mts";
import { CatalogReadError } from "./lib/model-catalog-process.mts";
import { fixtureModelCatalog } from "./lib/model-policy.fixture.mts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kherep-model-cli-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const codexHome = path.join(root, "codex");
  const registryFile = path.join(root, "registry.json");
  const capabilities = JSON.parse(fs.readFileSync(new URL("./parity/capabilities.json", import.meta.url), "utf8")) as Capabilities;
  fs.mkdirSync(codexHome);
  fs.writeFileSync(registryFile, JSON.stringify({ mcpServers: Object.fromEntries(capabilities.mcpServers.map((name) => [name, {
    type: "http", url: `https://example.invalid/${name}`,
  }])) }), { mode: 0o600 });
  const configFile = path.join(codexHome, "config.toml");
  const operator = 'model = "operator-model"\nmodel_reasoning_effort = "low" # operator choice\n';
  fs.writeFileSync(configFile, operator);
  const options = { codexHome, registryFile, claudeConfigDir: path.join(root, "claude"), workspace: path.join(root, "workspace"),
    homeDir: root, memoryProvider: { provider: "unconfigured" }, nodePath: process.execPath,
    skipPluginRegistration: true, installAtlassianTools: false, controlPlaneOutbox: path.join(root, "outbox"),
    resolveRegistryRuntime: () => "fixture", runCodex: () => { throw new Error("No runtime call authorized in offline CLI fixture"); }, log: () => {},
  };
  return { root, codexHome, configFile, operator, options };
}

test("model refresh requires its explicit CLI flag", () => {
  assert.deepEqual(parseArgs(["--refresh-models"]), { refreshModels: true });
  assert.equal(parseArgs([]).refreshModels, undefined);
  assert.throws(() => parseArgs(["--models-only"]), /Unexpected/);
});

for (const effort of ["low", "high"]) test(`top-level ${effort} model settings retain exact lines through install, refresh and reinstall`, async (t) => {
  const f = fixture(t);
  const operator = `model  = "operator-model" # explicit model\nmodel_reasoning_effort = "${effort}" # explicit effort\n`;
  const profile = '[profiles.personal]\nmodel = "profile-model"\nmodel_reasoning_effort = "high" # profile choice\n';
  fs.writeFileSync(f.configFile, operator + profile);
  for (const refreshModels of [false, true, false]) {
    const result = await installFromCli({ ...f.options, refreshModels }, async () => {
      assert.ok(refreshModels || !fs.existsSync(path.join(f.codexHome, "orchestra/parity-receipt.json")), "ordinary reinstall never reads a catalog");
      return fixtureModelCatalog();
    });
    const config = fs.readFileSync(f.configFile, "utf8");
    assert.ok(config.startsWith(operator));
    assert.ok(config.includes(profile));
    assert.equal(result.receipt.modelResolution.roles.broker.reasoning, "medium");
  }
});

test("async CLI reads one selected-home catalog initially, none on reinstall, and one on refresh", async (t) => {
  const f = fixture(t);
  const calls: string[] = [];
  const readCatalog = async ({ codexHome }: { codexHome: string }) => { calls.push(codexHome); return fixtureModelCatalog(); };
  const first = await installFromCli(f.options, readCatalog);
  assert.deepEqual(calls, [f.codexHome]);
  const second = await installFromCli(f.options, async () => { throw new Error("Normal reinstall must not read a catalog"); });
  assert.deepEqual(second.receipt.modelResolution, first.receipt.modelResolution);
  const refreshed = await installFromCli({ ...f.options, refreshModels: true }, async ({ codexHome }) => {
    calls.push(codexHome);
    const catalog = fixtureModelCatalog();
    catalog.models.push({ ...catalog.models[1], id: "gpt-7-sol", model: "gpt-7-sol" });
    return catalog;
  });
  assert.deepEqual(calls, [f.codexHome, f.codexHome]);
  assert.equal(refreshed.receipt.modelResolution.roles.builder.model, "gpt-7-sol");
  assert.ok(fs.readFileSync(f.configFile, "utf8").startsWith(f.operator), "operator model and reasoning retain their exact bytes");
});

test("async CLI catalog failure is redacted and leaves the first install untouched", async (t) => {
  const f = fixture(t);
  await assert.rejects(installFromCli(f.options, async () => { throw new Error("synthetic-account-detail"); }), (error: Error) => {
    assert.equal(error.message, "Codex model catalog unavailable or cleanup unconfirmed");
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(fs.readdirSync(f.codexHome), ["config.toml"]);
  assert.equal(fs.readFileSync(f.configFile, "utf8"), f.operator);
  assert.equal(fs.existsSync(f.options.workspace), false);
});

test("async CLI keeps the stage of an already redacted catalog error", async (t) => {
  const f = fixture(t);
  const staged = new CatalogReadError("cleanup");
  await assert.rejects(installFromCli(f.options, async () => { throw staged; }), (error: Error) => {
    assert.equal(error, staged);
    assert.equal((error as CatalogReadError).stage, "cleanup");
    assert.equal(error.message, "Codex model catalog unavailable or cleanup unconfirmed (stage: cleanup)");
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(fs.readdirSync(f.codexHome), ["config.toml"]);
  assert.equal(fs.readFileSync(f.configFile, "utf8"), f.operator);
  assert.equal(fs.existsSync(f.options.workspace), false);
});

test("a missing --codex-home is created private before the catalog read", async (t) => {
  const f = fixture(t);
  fs.rmSync(f.codexHome, { recursive: true });
  const result = await installFromCli(f.options, async ({ codexHome }) => {
    assert.ok(fs.statSync(codexHome).isDirectory());
    if (process.platform !== "win32") assert.equal(fs.statSync(codexHome).mode & 0o777, 0o700);
    return fixtureModelCatalog();
  });
  assert.equal(result.codexHome, f.codexHome);
});

test("a failed read in a created --codex-home leaves it empty and the workspace absent", async (t) => {
  const f = fixture(t);
  fs.rmSync(f.codexHome, { recursive: true });
  const staged = new CatalogReadError("start");
  await assert.rejects(installFromCli(f.options, async () => { throw staged; }), (error: Error) => error === staged);
  assert.deepEqual(fs.readdirSync(f.codexHome), []);
  assert.equal(fs.existsSync(f.options.workspace), false);
});

test("a missing home taken from CODEX_HOME is not created", async (t) => {
  const f = fixture(t);
  const missing = path.join(f.root, "env-home");
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = missing;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const { codexHome: _selected, ...options } = f.options;
  const seen: string[] = [];
  await assert.rejects(installFromCli(options, async ({ codexHome }) => { seen.push(codexHome); throw new CatalogReadError("start"); }),
    /stage: start/);
  assert.deepEqual(seen, [missing]);
  assert.equal(fs.existsSync(missing), false);
});

test("unreadable canonical receipt refuses reinstall without treating it as a fresh catalog request", async (t) => {
  const f = fixture(t);
  const receipt = path.join(f.codexHome, "orchestra", "parity-receipt.json");
  fs.mkdirSync(path.dirname(receipt));
  fs.writeFileSync(receipt, "not json");
  let reads = 0;
  await assert.rejects(installFromCli(f.options, async () => { reads++; return fixtureModelCatalog(); }), /model receipt/i);
  assert.equal(reads, 0);
  assert.equal(fs.readFileSync(receipt, "utf8"), "not json");
  assert.equal(fs.existsSync(f.options.workspace), false);
});
