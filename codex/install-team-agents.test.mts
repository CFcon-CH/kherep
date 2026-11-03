// Issue #761. codex/install.mts projects the Codex lead and team-lead profiles
// from their own sources in codex/agents/ into <codex-home>/agents/<name>.toml,
// with the body as developer_instructions and the resolved root model defaults,
// and installs the routing and AGENTS.md text that point a session at them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AGENTS_START, install } from "./install.mts";
import { adaptCodexText, parseFrontmatter } from "./lib/component-render.mts";
import type { Capabilities } from "./lib/contracts.mts";
import { fixtureModelOptions } from "./lib/model-policy.fixture.mts";

const here = import.meta.dirname;
const AGENTS = ["kherep-lead", "kherep-team-lead"];
const AGENTS_END = "<!-- kherep:end -->";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-761-codex-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home", ".codex");
  const claudeRegistryFile = path.join(root, "home", ".claude.json");
  const configRoot = path.join(root, "kherep config");
  fs.mkdirSync(codexHome, { recursive: true });
  const capabilities = JSON.parse(fs.readFileSync(path.join(here, "parity", "capabilities.json"), "utf8")) as Capabilities;
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: Object.fromEntries(
    capabilities.mcpServers.map((name) => [name, { type: "http", url: `https://example.test/${name}` }])) }), { mode: 0o600 });
  return {
    codexHome, capabilities,
    options: {
      ...fixtureModelOptions(),
      codexHome, claudeRegistryFile, claudeConfigDir: path.join(root, "home", ".claude"), workspace: path.join(root, "workspace"),
      nodePath: process.execPath, log: (): void => {}, skipPluginRegistration: true, installAtlassianTools: false,
      resolveRegistryRuntime: () => "fixture", runCodex: (): string => "ok",
      controlPlaneOutbox: path.join(configRoot, "control-plane", "outbox"),
    },
  };
}

function field(toml: string, key: string): string | undefined {
  const line = toml.split("\n").find((entry) => entry.startsWith(`${key} = `));
  return line === undefined ? undefined : JSON.parse(line.slice(key.length + 3)) as string;
}

test("capabilities.json names the runtime's own source and the root role for both profiles", () => {
  const capabilities = JSON.parse(fs.readFileSync(path.join(here, "parity", "capabilities.json"), "utf8")) as Capabilities;
  for (const agent of AGENTS) {
    assert.deepEqual(capabilities.agents[agent], { source: `codex/agents/${agent}.md`, role: "root" }, agent);
  }
});

test("install projects both profiles as native agent TOMLs with the root defaults", (t) => {
  const { codexHome, options } = fixture(t);
  const result = install(options);
  const defaults = result.receipt.modelResolution.roles.root;
  for (const agent of AGENTS) {
    const source = fs.readFileSync(path.join(here, "agents", `${agent}.md`), "utf8");
    const toml = fs.readFileSync(path.join(codexHome, "agents", `${agent}.toml`), "utf8");
    const parsed = parseFrontmatter(adaptCodexText(source));
    assert.equal(field(toml, "name"), agent);
    assert.equal(field(toml, "description"), parsed.metadata.description);
    assert.equal(field(toml, "developer_instructions"), parsed.body);
    assert.equal(field(toml, "developer_instructions"), parseFrontmatter(source).body, `${agent}: no Claude text to adapt`);
    assert.equal(field(toml, "model"), defaults.model);
    assert.equal(field(toml, "model_reasoning_effort"), defaults.reasoning);
    assert.equal(field(toml, "sandbox_mode"), undefined, `${agent}: inherits the session sandbox`);
    assert.equal(result.receipt.projection.agents.find((entry) => entry.name === agent)?.status, "installed");
    assert.deepEqual(result.receipt.projection.agentDefaults[agent], { role: "root", ...defaults });
  }
  const snapshot = JSON.parse(fs.readFileSync(path.join(result.targets.hookDir, "..", "parity", "capabilities.json"), "utf8")) as Capabilities;
  for (const agent of AGENTS) assert.equal(snapshot.projectedAgents?.[agent]?.role, "root");

  const agentsFile = fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8");
  const block = agentsFile.slice(agentsFile.indexOf(AGENTS_START), agentsFile.indexOf(AGENTS_END));
  assert.match(block, /agents\/kherep-lead\.toml/);
  assert.match(block, /agents\/kherep-team-lead\.toml/);
  const routing = fs.readFileSync(path.join(codexHome, "orchestra", "ROUTING.md"), "utf8");
  assert.match(routing, /^## Team model$/m);
  assert.match(routing, /operator -> lead -> team leads/);

  const again = install(options);
  for (const agent of AGENTS) {
    assert.equal(again.receipt.projection.agents.find((entry) => entry.name === agent)?.status, "replaced-with-backup");
  }
});
