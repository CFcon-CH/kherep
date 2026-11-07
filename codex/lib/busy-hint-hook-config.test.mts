import assert from "node:assert/strict";
import test from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import * as parity from "./parity-config.mts";

const options = { startMarker: "# >>> fixture >>>", endMarker: "# <<< fixture <<<", retiredMcpServerNames: [],
  pluginMcpServers: {}, registryProjections: [], registry: "/opt/fixture/registry.json", registryBridge: "/opt/fixture/bridge.mts",
  registryRuntime: "/opt/fixture/runtime.mts", memoryNotifyHook: "/opt/fixture/notify.mts", node: "/opt/bin/node",
  hookDir: "/opt/codex/hooks", contextHook: "/opt/codex/context.mts",
  controlPlaneHook: "/opt/kherep/modules/control-plane/node/deliver-hook.mts" };
const renderOptions = { ...options, mcpServers: [] };
const busyGroups = (config: string) => [...config.matchAll(/\[\[hooks\.PostToolUse\]\]\nmatcher = "\.\*"\n\n\[\[hooks\.PostToolUse\.hooks\]\]\ntype = "command"\ncommand = ".*codex-control-plane-hook\.mts\\" \\"deliver.*"/g)];

test("a supported read-only tool boundary has one independent native PostToolUse delivery hook", () => {
  const rendered = parity.render(renderOptions);
  assert.equal(busyGroups(rendered).length, 1);
  assert.equal(busyGroups(parity.render({ ...renderOptions, omitDeliveryHooks: true })).length, 1,
    "external SessionStart/UPS/Stop ownership must not suppress the new consumer");
  assert.equal(busyGroups(parity.render({ ...renderOptions, controlPlaneHook: undefined })).length, 0);
});

test("every historical renderer stays free of the new busy consumer", () => {
  for (const [name, value] of Object.entries(parity)) {
    // Issue #376. The block right before the destructive guard already had the busy hint.
    if (/^render(Before|Previous|Legacy)/.test(name)
        // Issue #538: so had the block right before the adapted messaging intent entry.
        && !["renderBeforeAtlassianDestructiveGuard", "renderBeforeShellDispatcher", "renderBeforeAdaptedDirectGuards",
          "renderBeforeAdaptedIntentHook", "renderBeforeSelfAssignment"].includes(name)
        && typeof value === "function") {
      assert.equal(busyGroups((value as typeof parity.render)(renderOptions)).length, 0, name);
    }
  }
});

test("an exact pre-busy projection upgrades idempotently and preserves existing trust bytes", () => {
  const old = parity.renderBeforeBusyHint(renderOptions);
  const trust = '[hooks.state."fixture:post_tool_use:0:0"]\ntrusted_hash = "sha256:synthetic"\n';
  const config = `${options.startMarker}\n${old.trim()}\n${options.endMarker}\n\n${trust}`;
  const upgraded = prepareManagedConfig(config, options);
  assert.equal(busyGroups(upgraded.config).length, 1);
  assert.ok(upgraded.config.includes(trust));
  assert.equal(prepareManagedConfig(upgraded.config, options).config, upgraded.config);
});

const custom = '[[hooks.PostToolUse]]\nmatcher = "Bash"\n\n[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = "operator-hook"\n';
const oldBlock = () => `${options.startMarker}\n${parity.renderBeforeBusyHint(renderOptions).trim()}\n${options.endMarker}\n`;

test("migration stops before writes if an external PostToolUse group's trust position would move", () => {
  assert.throws(() => prepareManagedConfig(`${oldBlock()}\n${custom}`, options), /external PostToolUse.*position/i);
});

test("a custom PostToolUse before the managed block keeps its bytes and position", () => {
  const result = prepareManagedConfig(`${custom}\n${oldBlock()}`, options);
  assert.ok(result.config.includes(custom));
  assert.ok(result.config.indexOf(custom) < result.config.indexOf(options.startMarker));
  assert.equal(busyGroups(result.config).length, 1);
  assert.equal(prepareManagedConfig(result.config, options).config, result.config);
});

test("table-looking text in multiline TOML values is not a Hook definition", () => {
  for (const quotes of ['"""', "'''"]) {
    const value = `\n[operator]\nnote = ${quotes}\n[[hooks.PostToolUse]]\n[hooks.state]\n${quotes}\n`;
    const result = prepareManagedConfig(`${oldBlock()}${value}`, options);
    assert.ok(result.config.includes(value));
    assert.equal(prepareManagedConfig(result.config, options).config, result.config);
  }
});

test("quoted Hook table paths and trailing comments retain the actual group index", () => {
  const quoted = custom.replace('[[hooks.PostToolUse]]', `[[ "hooks" . 'PostToolUse' ]] # operator`)
    .replace('[[hooks.PostToolUse.hooks]]', `[[ "hooks" . 'PostToolUse' . hooks ]]`);
  assert.throws(() => prepareManagedConfig(`${oldBlock()}\n${quoted}`, options), /external PostToolUse.*position/i);
  assert.ok(prepareManagedConfig(`${quoted}\n${oldBlock()}`, options).config.includes(quoted));
});

test("closing multiline quote runs cannot hide a subsequent external Hook shift", () => {
  for (const quote of ['"', "'"]) for (const count of [4, 5]) {
    const prefix = `[operator]\nnote = ${quote.repeat(3)}\ncontent${quote.repeat(count)}\n`;
    assert.throws(() => prepareManagedConfig(`${prefix}${oldBlock()}\n${custom}`, options),
      /external PostToolUse.*position/i, `${quote} closing run ${count}`);
  }
});
