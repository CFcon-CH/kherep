import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig, type ManagedConfigOptions } from "./config-preservation.mts";
import { legacyForm } from "./legacy-control-plane-form.mts";
import { END, OPTIONS, REFUSAL, START, conserved, managedBlock, tomlDocument } from "./managed-block-split.fixture.mts";

// Issue #921. The Codex app records a tool approval as its own table. Inside the
// managed block such a table blocked the upgrade; an installer-rendered one the
// operator changed did as well. Every path below is synthetic.

const OPTS: ManagedConfigOptions = {
  ...OPTIONS,
  observationPublisher: { entry: String.raw`C:\Synthetic\workspace\tools\observation-stdio.mts`, home: String.raw`C:\Synthetic\.codex` },
  registryProjections: [{ name: "codebase-memory-mcp", transport: "stdio", command: String.raw`C:\Synthetic\bin\codebase-memory-mcp.exe`, args: [] }],
};
const FRESH = prepareManagedConfig("", OPTS).config;
const APPROVAL = '[mcp_servers.kherep_observations.tools.publish_observations]\napproval_mode = "approve"';
const LIMIT = '[mcp_servers.kherep_observations.tools.related_candidates]\napproval_mode = "prompt"\noutput_token_limit = 4000';
const RENDERED = '[mcp_servers.codebase-memory-mcp.tools.search_graph]\napproval_mode = "approve"';
const CHANGED = '[mcp_servers.codebase-memory-mcp.tools.search_graph]\napproval_mode = "prompt"';
const STATE = '[hooks.state]\n\n[hooks.state."fixture-home/config.toml:stop:0:0"]\ntrusted_hash = "sha256:fixture"';
const OBS = "[mcp_servers.kherep_observations]\n";
const MSG = "[mcp_servers.kherep_messaging]\n";
const UNMATCHED = /Refusing to retain unmatched MCP tables in the managed block/;
const PIN = String.raw`C:\Synthetic\.codex\orchestra\source-pins\0123456789abcdef0123456789abcdef01234567`;
const before = (config: string, header: string, text: string): string => config.replace(header, `${text}\n\n${header}`);
const atEnd = (config: string, text: string): string => config.replace(`\n${END}`, `\n\n${text}\n${END}`);
const behindEnd = (config: string): string => config.slice(config.indexOf(END));
const count = (text: string, part: string): number => text.split(part).length - 1;

function stable(config: string, options = OPTS): string {
  const again = prepareManagedConfig(config, options);
  assert.equal(again.managedFragment, "current");
  assert.equal(again.config, config);
  return config;
}

function lifted(config: string, ...tables: string[]): string {
  const result = prepareManagedConfig(config, OPTS);
  assert.equal(result.managedFragment, "replaced");
  assert.equal(managedBlock(result.config), managedBlock(FRESH));
  assert.deepEqual(tomlDocument(result.config), tomlDocument(config));
  assert.ok(conserved(config, result.config, managedBlock(FRESH), managedBlock(FRESH)), "every other line stays, once");
  const at = tables.map((table) => behindEnd(result.config).indexOf(`\n${table}\n`));
  assert.ok(at.every((offset, index) => offset > 0 && (index === 0 || offset > at[index - 1])), "verbatim behind the end marker, in order");
  return stable(result.config);
}

test("lifts an approval table between managed tables behind the end marker", () => {
  lifted(before(FRESH, MSG, APPROVAL), APPROVAL);
});

test("lifts an approval table that ends the block, with the text behind the marker it owns", () => {
  lifted(atEnd(FRESH, APPROVAL), APPROVAL);
  const owned = lifted(`${atEnd(FRESH, APPROVAL)}# operator note\n`, APPROVAL);
  assert.ok(owned.includes(`${APPROVAL}\n# operator note\n`));
});

test("lifts approval tables and trust tables in their order", () => {
  lifted(before(FRESH, OBS, `${STATE}\n\n${APPROVAL}\n\n${LIMIT}`), "[hooks.state]", APPROVAL, LIMIT);
});

test("lifts an approval table out of a block an earlier source pin wrote", () => {
  const config = legacyForm(before(FRESH, MSG, APPROVAL), PIN);
  assert.notEqual(config, before(FRESH, MSG, APPROVAL));
  const result = prepareManagedConfig(config, OPTS);
  assert.equal(result.managedFragment, "replaced");
  assert.equal(managedBlock(result.config), managedBlock(FRESH));
  assert.ok(behindEnd(result.config).includes(`\n${APPROVAL}\n`));
  stable(result.config);
});

test("leaves an approval table outside the block byte for byte", () => {
  for (const config of [`${FRESH}\n${APPROVAL}\n`, `${FRESH}\n[operator_after]\nkeep = 1\n\n${APPROVAL}\n`,
    FRESH.replace(START, `${APPROVAL}\n\n${START}`)]) {
    stable(config);
  }
});

test("keeps the operator's value in an approval table the installer renders", () => {
  const config = FRESH.replace(RENDERED, CHANGED);
  assert.notEqual(config, FRESH);
  stable(config);
  // The comment behind the end marker belongs to no table.
  stable(`${config}\n# operator note\n`);
  const lift = prepareManagedConfig(before(config, MSG, APPROVAL), OPTS);
  assert.equal(lift.managedFragment, "replaced");
  assert.equal(managedBlock(lift.config), managedBlock(config));
  stable(lift.config);
});

test("keeps the operator's value in a block an earlier source pin wrote", () => {
  const config = legacyForm(FRESH.replace(RENDERED, CHANGED), PIN);
  const result = prepareManagedConfig(config, OPTS);
  assert.equal(result.managedFragment, "replaced");
  assert.equal(managedBlock(result.config), managedBlock(FRESH).replace(RENDERED, CHANGED));
  stable(result.config);
});

const PLUGIN = { command: String.raw`C:\Synthetic\bin\plugin.exe`, args: [], promptTools: ["executeDestructive"] };
const PROMPT = '[mcp_servers.fixture_plugin.tools.executeDestructive]\napproval_mode = "prompt"';
const APPROVE = PROMPT.replace('"prompt"', '"approve"');
const STRANGER = '[mcp_servers.stranger.tools.lookup]\napproval_mode = "approve"';
const STRANGER_SERVER = '[mcp_servers.stranger]\ncommand = "stranger"';

function pluginInstall() {
  const withPlugin = { ...OPTS, pluginMcpServers: { fixture_plugin: PLUGIN }, optionalPluginMcpServers: { fixture_plugin: PLUGIN } };
  const installed = prepareManagedConfig("", withPlugin).config;
  assert.equal(count(managedBlock(installed), PROMPT), 1);
  return installed.replace(PROMPT, APPROVE);
}

test("moves an operator value behind the marker when the new block renders its server but not its table", () => {
  const quiet = { ...PLUGIN, promptTools: [] };
  const options = { ...OPTS, pluginMcpServers: { fixture_plugin: quiet }, optionalPluginMcpServers: { fixture_plugin: quiet },
    predecessorOptionalPluginMcpServers: [{ fixture_plugin: PLUGIN }] };

  const result = prepareManagedConfig(pluginInstall(), options);

  assert.equal(count(managedBlock(result.config), "[mcp_servers.fixture_plugin]"), 1);
  assert.equal(count(managedBlock(result.config), "[mcp_servers.fixture_plugin.tools."), 0);
  assert.equal(count(result.config, APPROVE), 1);
  assert.ok(behindEnd(result.config).startsWith(`${END}\n\n${APPROVE}\n`));
  stable(result.config, options);
});

// A3: Codex refuses to start on a tools table whose server table is absent.
test("drops an operator value whose server the new block no longer renders", () => {
  const optedOut = { ...OPTS, predecessorOptionalPluginMcpServers: [{ fixture_plugin: PLUGIN }] };
  for (const tail of ["", `\n[operator_after]\nkeep = 1\n`]) {
    const result = prepareManagedConfig(pluginInstall() + tail, optedOut);

    assert.equal(managedBlock(result.config), managedBlock(FRESH));
    assert.equal(result.managedFragment, "replaced");
    assert.equal(result.config.includes("fixture_plugin"), false);
    assert.equal(behindEnd(result.config), `${END}\n${tail}`);
    assert.doesNotThrow(() => tomlDocument(result.config));
    stable(result.config, optedOut);
  }
});

test("drops a lifted approval table whose server the config defines nowhere, and keeps its comment", () => {
  const cases: [string, string][] = [[before(FRESH, MSG, STRANGER), `${END}\n`],
    [`${atEnd(FRESH, STRANGER)}# operator note\n`, `${END}\n\n# operator note\n`],
    [`${before(FRESH, MSG, STRANGER)}\n[operator_after]\nkeep = 1\n`, `${END}\n\n[operator_after]\nkeep = 1\n`]];
  for (const [config, tail] of cases) {
    const result = prepareManagedConfig(config, OPTS);

    assert.equal(result.managedFragment, "replaced");
    assert.equal(managedBlock(result.config), managedBlock(FRESH));
    assert.equal(result.config.includes("stranger"), false);
    assert.equal(behindEnd(result.config), tail);
    assert.doesNotThrow(() => tomlDocument(result.config));
    stable(result.config);
  }
});

test("keeps a lifted approval table whose server stands outside the block, and an orphan already outside", () => {
  const defined = prepareManagedConfig(`${before(FRESH, MSG, STRANGER)}\n${STRANGER_SERVER}\n`, OPTS);
  assert.equal(managedBlock(defined.config), managedBlock(FRESH));
  assert.equal(count(defined.config, STRANGER), 1);
  assert.ok(behindEnd(defined.config).includes(`\n${STRANGER}\n`));
  stable(defined.config);

  const orphan = '[mcp_servers.elsewhere.tools.lookup]\napproval_mode = "approve"';
  const both = prepareManagedConfig(`${before(FRESH, MSG, STRANGER)}\n${orphan}\n`, OPTS);
  assert.equal(both.config.includes("stranger"), false);
  assert.ok(behindEnd(both.config).includes(`\n${orphan}\n`));
  stable(both.config);
  stable(`${FRESH}\n${orphan}\n`);
});

test("merges an operator copy outside the block into the table the block renders", () => {
  const note = "# operator note";
  for (const config of [`${FRESH}\n${CHANGED}\n${note}\n\n[operator_after]\nkeep = 1\n`,
    FRESH.replace(START, `${CHANGED}\n${note}\n\n${START}`)]) {
    const result = prepareManagedConfig(config, OPTS);
    assert.equal(result.managedFragment, "replaced");
    assert.equal(managedBlock(result.config), managedBlock(FRESH).replace(RENDERED, CHANGED));
    assert.equal(count(result.config, "[mcp_servers.codebase-memory-mcp.tools.search_graph]"), 1);
    assert.equal(count(result.config, note), 1);
    assert.doesNotThrow(() => tomlDocument(result.config));
    stable(result.config);
  }
});

test("refuses every other table or shape in the block", () => {
  const shapes = [`${APPROVAL}\nenabled = false`, `${APPROVAL}\napproval_mode = "prompt"`,
    "[mcp_servers.kherep_observations.tools.publish_observations]\napproval_mode = '''\napprove\n'''",
    "[[mcp_servers.kherep_observations.tools.publish_observations]]\napproval_mode = \"approve\"",
    '[mcp_servers.kherep_observations.tools]\napproval_mode = "approve"',
    '[mcp_servers.kherep_observations.tools.publish_observations.extra]\napproval_mode = "approve"',
    '[mcp_servers.kherep_observations.env]\nCODEX_HOME = "C:\\\\Synthetic"', '[mcp_servers.stranger]\ncommand = "stranger"'];
  for (const shape of shapes) assert.throws(() => prepareManagedConfig(before(FRESH, MSG, shape), OPTS), REFUSAL, shape);
  assert.throws(() => prepareManagedConfig(FRESH.replace(RENDERED, `${CHANGED}\nenabled = false`), OPTS), REFUSAL);
  assert.throws(() => prepareManagedConfig(atEnd(FRESH, '[mcp_servers.stranger]\ncommand = "stranger"'), OPTS), UNMATCHED);
});

test("removes a retired server's tables before it lifts a live approval", () => {
  const options = { ...OPTS, retiredMcpServerNames: ["retired_fixture"] };
  const retired = '[mcp_servers.retired_fixture]\ncommand = "retired"\n\n[mcp_servers.retired_fixture.tools.old]\napproval_mode = "approve"';
  for (const config of [before(FRESH, MSG, `${retired}\n\n${APPROVAL}`), `${before(FRESH, MSG, APPROVAL)}\n${retired}\n`]) {
    const result = prepareManagedConfig(config, options);
    assert.equal(managedBlock(result.config), managedBlock(FRESH));
    assert.equal(result.config.includes("retired_fixture"), false);
    assert.ok(behindEnd(result.config).includes(`\n${APPROVAL}\n`));
    assert.deepEqual(result.retiredMcpServers.find(({ name }) => name === "retired_fixture"), { name: "retired_fixture", status: "removed" });
    stable(result.config, options);
  }
});

const PROBE = ["# kherep-binding-probe:start", "[mcp_servers.kherep_binding_probe]", "enabled = false", "required = false",
  String.raw`command = 'C:\Synthetic\node.exe'`, "enabled_tools = ['binding_probe']", "",
  "[mcp_servers.kherep_binding_probe.tools.binding_probe]", "approval_mode = 'prompt'", "# kherep-binding-probe:end", ""].join("\n");

// Issue #1010. The line behind a removed table can be a managed marker or the operator's.
test("keeps every marker and comment line around a retired server's tables", () => {
  const kept = { kept_fixture: { url: "https://kept.example.invalid/mcp" } };
  const options = { ...OPTS, pluginMcpServers: kept, retiredMcpServerNames: ["retired_fixture"] };
  const fresh = prepareManagedConfig("", options).config;
  const old = prepareManagedConfig("", { ...OPTS, pluginMcpServers: { retired_fixture: { command: "retired" }, ...kept } }).config;
  const approval = '[mcp_servers.retired_fixture.tools.old]\napproval_mode = "approve"';
  const operator = "# operator comment\n\n[operator_after]\nkeep = 1\n";
  for (const [config, expected] of [
    [atEnd(old, approval), fresh.replace(`\n${END}`, `\n\n${END}`)],
    [old.replace(START, `${approval}\n${START}`), fresh],
    [`${old}\n${approval}\n\n${operator}`, `${fresh}\n${operator}`],
    [`${old}\n${approval}\n${PROBE}`, `${fresh}\n${PROBE}`],
  ]) {
    const result = prepareManagedConfig(config, options);
    assert.equal(result.config, expected);
    assert.deepEqual(result.retiredMcpServers, [{ name: "retired_fixture", status: "removed" }]);
    stable(result.config, options);
  }
  // Inside the block a comment of the operator's still refuses, as before the retirement.
  assert.throws(() => prepareManagedConfig(before(old, OBS, "# operator comment"), options), REFUSAL);
});

test("leaves the operator's binding-probe tables outside the block untouched", () => {
  for (const block of [FRESH, FRESH.replace(RENDERED, CHANGED)]) stable(`${block}\n${PROBE}`);
});
