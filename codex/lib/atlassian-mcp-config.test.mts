// Issue #376. The Codex side of the Atlassian service-account server: the
// destructive guard as the last entry of the Agent, web and MCP PreToolUse
// group, the managed stdio table with its approval prompt, and the upgrade from
// each block form an earlier installer wrote.
import assert from "node:assert/strict";
import test from "node:test";

import {
  atlassianMcpServer, hasManagedAtlassianTable, managedAtlassianTokenFile, PREDECESSOR_NATIVE_ATLASSIAN,
} from "./atlassian-mcp.mts";
import { prepareManagedConfig } from "./config-preservation.mts";
import * as parity from "./parity-config.mts";

const START = "# >>> fixture >>>";
const END = "# <<< fixture <<<";
const TABLE = { node: "/opt/bin/node", runtime: "/opt/codex/orchestra/supergateway-secret-wrapper.mts" };
const TOKEN = "/opt/operator/atl-mcp-credential-codex.txt";
const options = { startMarker: START, endMarker: END, retiredMcpServerNames: [],
  pluginMcpServers: {}, registryProjections: [], registry: "/opt/fixture/registry.json", registryBridge: "/opt/fixture/bridge.mts",
  registryRuntime: TABLE.runtime, memoryNotifyHook: "/opt/fixture/notify.mts", node: TABLE.node,
  hookDir: "/opt/codex/hooks", contextHook: "/opt/codex/context.mts",
  controlPlaneHook: "/opt/kherep/modules/control-plane/node/deliver-hook.mts" };
const renderOptions = { ...options, mcpServers: [] };
const GUARD = /atlassian-destructive-guard\.mts\\" \\"--runtime\\" \\"codex\\""/;

function preGroups(config: string): string[][] {
  return config.split(/^(?=\[\[hooks\.[A-Za-z]+\]\]$)/m).slice(1)
    .filter((group) => group.startsWith("[[hooks.PreToolUse]]"))
    .map((group) => group.split(/^\[(?!\[)/m)[0]!)
    .map((group) => group.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m).map((entry) => entry.trim()));
}

const block = (body: string): string => `${START}\n${body.trim()}\n${END}\n`;

test("the guard is the last entry of the MCP group, and no PreToolUse key moves", () => {
  // Isolate the historical guard addition from the later shell consolidation.
  const current = preGroups(parity.renderBeforeShellDispatcher(renderOptions));
  const previous = preGroups(parity.renderBeforeAtlassianDestructiveGuard(renderOptions));
  assert.equal(current.length, previous.length, "no PreToolUse group added");
  const mcp = current.findIndex(([header]) => header!.includes("|mcp__.*"));
  assert.ok(mcp >= 0);
  assert.match(current[mcp]!.at(-1)!, GUARD);
  assert.match(current[mcp]!.at(-1)!, /^commandWindows = "& /m);
  current.forEach((group, index) => assert.deepEqual(index === mcp ? group.slice(0, -1) : group, previous[index]));
  assert.equal([...parity.render(renderOptions).matchAll(/atlassian-destructive-guard/g)].length, 2,
    "the command and its Windows form, once");
});

test("every historical renderer predates the guard", () => {
  for (const [name, value] of Object.entries(parity)) {
    // Issue #507, part 4. The block right before the adapted guards already had the guard.
    // Issue #538. So had the block right before the adapted messaging intent entry.
    if (!["renderBeforeShellDispatcher", "renderBeforeAdaptedDirectGuards", "renderBeforeAdaptedIntentHook", "renderBeforeSelfAssignment"].includes(name)
        && /^render(Before|Previous|Legacy)/.test(name) && typeof value === "function") {
      assert.doesNotMatch((value as typeof parity.render)(renderOptions), /atlassian-destructive-guard/, name);
    }
  }
});

test("renders the service-account table with its environment and the destructive prompt", () => {
  const rendered = parity.renderPluginMcp({ ...renderOptions, pluginMcpServers: {
    atlassian: atlassianMcpServer(TOKEN, TABLE), context7: { command: "npx", args: ["-y", "fixture"] },
  } });
  assert.equal(rendered, [
    "[mcp_servers.atlassian]",
    "enabled = true",
    "required = false",
    `command = ${JSON.stringify(TABLE.node)}`,
    `args = [${JSON.stringify(TABLE.runtime)}]`,
    `env = { KHEREP_MCP_AUTH_FILE = ${JSON.stringify(TOKEN)}, KHEREP_MCP_ENDPOINT = "https://mcp.atlassian.com/v2/mcp" }`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
    "",
    "[mcp_servers.atlassian.tools.executeDestructive]",
    'approval_mode = "prompt"',
    "",
    "[mcp_servers.context7]",
    "enabled = true",
    "required = false",
    'command = "npx"',
    'args = ["-y", "fixture"]',
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
  ].join("\n"));
});

test("upgrades each earlier Atlassian block form idempotently and keeps operator text", () => {
  const atlassian = { atlassian: atlassianMcpServer(TOKEN, TABLE) };
  const current = { ...options, pluginMcpServers: atlassian, optionalPluginMcpServers: atlassian };
  const moved = "/opt/operator/old/atl-mcp-credential-codex.txt";
  const operator = '\n[mcp_servers.keep]\ncommand = "keep"\n';
  const olds = [
    // Before the guard, with the native OAuth table.
    parity.renderBeforeAtlassianDestructiveGuard({ ...renderOptions, pluginMcpServers: { atlassian: PREDECESSOR_NATIVE_ATLASSIAN } }),
    // Before the guard, without the optional tool set.
    parity.renderBeforeAtlassianDestructiveGuard(renderOptions),
    // The current form for another key file.
    parity.render({ ...renderOptions, pluginMcpServers: { atlassian: atlassianMcpServer(moved, TABLE) } }),
  ];
  for (const old of olds) {
    const config = `${block(old)}${operator}`;
    const previousToken = managedAtlassianTokenFile(config, { start: START, end: END });
    const upgraded = prepareManagedConfig(config, {
      ...current,
      predecessorOptionalPluginMcpServers: [
        { atlassian: PREDECESSOR_NATIVE_ATLASSIAN },
        ...(previousToken ? [{ atlassian: atlassianMcpServer(previousToken, TABLE) }] : []),
      ],
    });
    assert.ok(upgraded.config.includes(parity.render({ ...renderOptions, pluginMcpServers: atlassian }).trim()));
    assert.ok(upgraded.config.includes(operator));
    assert.doesNotMatch(upgraded.config, /^url = /m);
    assert.equal(prepareManagedConfig(upgraded.config, current).config, upgraded.config);
  }
  assert.equal(managedAtlassianTokenFile(block(olds[2]!), { start: START, end: END }), moved);
  assert.equal(managedAtlassianTokenFile(block(olds[0]!), { start: START, end: END }), undefined);
});

// Issue #397. Whether the installed block carries an Atlassian table at all,
// in any form; one outside the block is the operator's and does not count.
test("finds a managed Atlassian table of either form only inside the block", () => {
  const markers = { start: START, end: END };
  const native = block(parity.render({ ...renderOptions, pluginMcpServers: { atlassian: PREDECESSOR_NATIVE_ATLASSIAN } }));
  const serviceAccount = block(parity.render({ ...renderOptions, pluginMcpServers: { atlassian: atlassianMcpServer(TOKEN, TABLE) } }));
  const without = block(parity.render(renderOptions));
  assert.equal(hasManagedAtlassianTable(native, markers), true);
  assert.equal(hasManagedAtlassianTable(serviceAccount, markers), true);
  assert.equal(hasManagedAtlassianTable(without, markers), false);
  assert.equal(hasManagedAtlassianTable(`${without}\n[mcp_servers.atlassian]\nurl = "https://operator.invalid/mcp"\n`, markers), false);
  assert.equal(hasManagedAtlassianTable("", markers), false);
});

test("an unknown Atlassian table inside the block still refuses", () => {
  const atlassian = { atlassian: atlassianMcpServer(TOKEN, TABLE) };
  const foreign = parity.render({ ...renderOptions, pluginMcpServers: {
    atlassian: { ...atlassianMcpServer(TOKEN, TABLE), env: { KHEREP_MCP_AUTH_FILE: TOKEN, KHEREP_MCP_ENDPOINT: "https://other.invalid/mcp" } },
  } });
  assert.throws(() => prepareManagedConfig(block(foreign), {
    ...options, pluginMcpServers: atlassian, optionalPluginMcpServers: atlassian,
    predecessorOptionalPluginMcpServers: [{ atlassian: PREDECESSOR_NATIVE_ATLASSIAN }],
  }), /Refusing to /);
});
