import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { assertRegular, assertWorkspaceConfig, configureRoot, readManagedText } from "./start-model-artifacts.mts";

const root = { model: "gpt-6.10-sol", effort: "xhigh" };
function workdir(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kherep-start-artifacts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("root defaults preserve other TOML bytes and accept the built-in provider", () => {
  const existing = ["# unrelated note", 'model_provider = "openai"  # provider', 'model= "gpt-6.9-sol" # default',
    "[features]", 'model = "unrelated table value"', ""].join("\r\n");
  assert.equal(configureRoot(existing, root), 'model_reasoning_effort = "xhigh"\r\n'
    + existing.replace('"gpt-6.9-sol"', '"gpt-6.10-sol"'));
  assert.equal(configureRoot("[features]\nhooks = true\n", root),
    'model_reasoning_effort = "xhigh"\nmodel = "gpt-6.10-sol"\n[features]\nhooks = true\n');
});

test("root refresh refuses unowned native providers and model override layers", () => {
  const providers = ['model_provider = "synthetic-other"', "model_provider = 'openai'\nmodel_provider = 'openai'",
    'openai_base_url = "https://example.invalid"', '"chatgpt_base_url" = "https://example.invalid"'];
  for (const config of providers) assert.throws(() => configureRoot(config, root), { message: "codex-start-provider-unsupported" });
  const overrides = ['profile = "test"', "'model_catalog_json' = 'catalog.json'", 'project_root_markers = [".hg"]',
    '[profiles.test]\nmodel = "other"', '["agents".builder]\nconfig_file = "other.toml"', 'agents.builder = "other"'];
  for (const config of overrides) assert.throws(() => configureRoot(config, root), { message: "codex-start-root-override-unsupported" });
});

test("root refresh refuses ambiguous configuration and invalid values before they can be written", () => {
  for (const config of ['\uFEFFmodel = "old"', 'model = "old"\rmodel = "other"', 'model = """multiline"""',
    'model = "old"\nmodel = "other"', '"model" = "old"', 'model.default = "old"']) {
    assert.throws(() => configureRoot(config, root), { message: "codex-start-root-config-ambiguous" });
  }
  assert.throws(() => configureRoot('model = "old"\n', { ...root, model: "invalid default" }), { message: "codex-start-root-config-ambiguous" });
});

test("checks only the declared workspace ancestry up to its Git boundary", (t) => {
  const directory = workdir(t), project = path.join(directory, "project"), workspace = path.join(project, "nested");
  const home = path.join(project, ".codex");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(project, ".git"), "synthetic Git boundary\n");
  fs.writeFileSync(path.join(home, "config.toml"), "model = 'managed'\n");
  assert.doesNotThrow(() => assertWorkspaceConfig(home, workspace));
  assert.throws(() => assertWorkspaceConfig(path.join(directory, "another-home"), workspace), { message: "codex-start-project-config" });
});

test("rejects non-regular, oversized and invalid UTF-8 managed inputs", (t) => {
  const directory = workdir(t), file = path.join(directory, "managed.toml");
  assert.doesNotThrow(() => assertRegular(file, false, true));
  assert.throws(() => readManagedText(directory), { message: "codex-start-target-not-regular" });
  fs.writeFileSync(file, Buffer.alloc(1_048_577));
  assert.throws(() => readManagedText(file), { message: "codex-start-target-unreadable" });
  fs.writeFileSync(file, Buffer.from([0xc3]));
  assert.throws(() => readManagedText(file), { message: "codex-start-target-unreadable" });
  if (process.platform !== "win32") {
    const link = path.join(directory, "linked.toml");
    fs.linkSync(file, link);
    assert.throws(() => readManagedText(link), { message: "codex-start-target-not-regular" });
  }
});
