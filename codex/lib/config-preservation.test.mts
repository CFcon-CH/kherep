import assert from "node:assert/strict";
import { test } from "node:test";
import * as preservationApi from "./config-preservation.mts";
import {
  migrateExactUnmanagedMcpArg,
  prepareManagedConfig,
  preserveConfigUpgrade,
  replaceExactManagedFragment,
} from "./config-preservation.mts";
import type { McpProjection } from "./contracts.mts";
import { render, renderPreviousNudges } from "./parity-config.mts";
import { retiredCentralBrainRender } from "./retired-central-brain.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";

const MANAGED_OPTIONS = {
  startMarker: START, endMarker: END, retiredMcpServerNames: [], pluginMcpServers: {},
  registryProjections: [{
    name: "fixture_service", transport: "http", authentication: "registry-bearer",
    sourceName: "fixture_service",
  }] as McpProjection[],
  contextHook: "/codex/hooks/kherep-maestro-context.mts",
  hookDir: "/codex/hooks/kherep-maestro",
  memoryNotifyHook: "/codex/hooks/kherep-maestro/codex-memory-notify.mts",
  node: "/usr/bin/node", registry: "/private/registry.json",
  registryBridge: "/codex/orchestra/registry-http-bridge.mts",
  registryRuntime: "/codex/orchestra/supergateway-secret-wrapper.mts",
};

test("exports pure config preservation operations", () => {
  assert.equal(typeof preservationApi.replaceExactManagedFragment, "function");
  assert.equal(typeof preservationApi.migrateExactUnmanagedMcpArg, "function");
  assert.equal(typeof Reflect.get(preservationApi, "preserveConfigUpgrade"), "function");
});

test("replaces only the exact historical fragment and preserves 27 custom hook tables", () => {
  const historical = [
    "# Managed Kherep Codex Maestro parity projection.",
    "", "[[hooks.SessionStart]]", 'matcher = "startup"', "",
    "[[hooks.SessionStart.hooks]]", 'type = "command"', 'command = "node old-hook.js"',
  ].join("\n");
  const replacement = historical.replace("old-hook.js", "new-hook.mts");
  const customHooks = Array.from({ length: 27 }, (_, index) => [
    "[[hooks.SessionStart]]", `matcher = 'custom-${index}'`, `custom_${index} = 'keep-${index}'`,
  ].join("\n")).join("\n\n");
  const config = [
    'model = "fixture"', START, historical, "", customHooks, END,
    '[mcp_servers."custom-direct"]', 'command = "custom"', "",
  ].join("\n");

  const result = replaceExactManagedFragment(config, START, END, [historical], replacement);

  assert.equal(result, config.replace(historical, replacement));
  assert.equal((result.match(/\[\[hooks\.SessionStart\]\]/g) || []).length, 28);
  assert.match(result, /custom_26 = 'keep-26'/);
});

test("keeps current managed content byte-for-byte and rejects unknown managed state", () => {
  const current = "[[hooks.Stop]]\nmatcher = 'current'";
  const custom = "[[hooks.Stop]]\nmatcher = 'custom'";
  const config = [START, current, "", custom, END, ""].join("\n");
  assert.equal(replaceExactManagedFragment(config, START, END, ["old"], current), config);
  assert.throws(
    () => replaceExactManagedFragment(config, START, END, ["absent"], "new"),
    /exact known managed fragment/,
  );
  assert.throws(
    () => replaceExactManagedFragment(
      [START, current, current, END].join("\n"), START, END, ["old"], current,
    ),
    /ambiguous exact known managed fragment/,
  );
});

test("migrates only the canonical literal bridge arg and preserves custom MCP state", () => {
  const oldArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.js`;
  const newArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.mts`;
  const config = [
    '[mcp_servers."codebase-memory-mcp"] # custom', "enabled = false", "required = true",
    "command = 'C:\\Program Files\\nodejs\\node.exe'",
    `args = ['${oldArg}'] # retain formatting`, "startup_timeout_sec = 91.0", "",
    '[mcp_servers."codebase-memory-mcp".env]', "CUSTOM_FLAG = 'keep'", "",
    '[mcp_servers."codebase-memory-mcp".tools.search_graph]', "approval_mode = 'prompt'", "",
  ].join("\n");

  assert.deepEqual(
    migrateExactUnmanagedMcpArg(config, "codebase-memory-mcp", oldArg, newArg, START, END),
    { config: config.replace(`'${oldArg}'`, `'${newArg}'`), migrated: true },
  );
});

test("supports multiline basic args and fails closed for an unparseable retired reference", () => {
  const oldArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.js`;
  const newArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.mts`;
  const basicOld = JSON.stringify(oldArg);
  const basicNew = JSON.stringify(newArg);
  const config = [
    "[mcp_servers.fixture_service]", "args = [", `  ${basicOld},`, "  '--keep',", "]", "",
  ].join("\n");
  assert.deepEqual(
    migrateExactUnmanagedMcpArg(config, "fixture_service", oldArg, newArg, START, END),
    { config: config.replace(basicOld, basicNew), migrated: true },
  );

  const invalid = ["[mcp_servers.fixture_service]", `args = { bridge = '${oldArg}' }`, ""].join("\n");
  assert.throws(
    () => migrateExactUnmanagedMcpArg(invalid, "fixture_service", oldArg, newArg, START, END),
    /Retired bridge reference.*could not be migrated safely/,
  );
});

test("reports five exact MCP rewrites while preserving custom hooks and direct MCP entries", () => {
  const oldArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.js`;
  const newArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.mts`;
  const names = ["one", "two", "three", "four", "five"];
  const managedOld = "[[hooks.Stop]]\ncommand = 'old-hook.js'";
  const managedNew = "[[hooks.Stop]]\ncommand = 'new-hook.mts'";
  const extraHooks = "[[hooks.Stop]]\ncommand = 'custom-hook'\ncustom = 'keep'";
  const migratedTables = names.map((name, index) => [
    `[mcp_servers.${name}]`, `enabled = ${index === 0 ? "false" : "true"}`,
    "command = 'node'", `args = ['${oldArg}']`, "",
  ].join("\n")).join("\n");
  const direct = [
    "[mcp_servers.direct-one]", "command = 'direct-one'", "args = []", "",
    "[mcp_servers.direct-two]", "command = 'direct-two'", "args = ['keep']", "",
  ].join("\n");
  const config = [START, managedOld, "", extraHooks, END, migratedTables, direct].join("\n");

  const result = preserveConfigUpgrade(config, {
    startMarker: START, endMarker: END, knownManagedFragments: [managedOld],
    managedReplacement: managedNew, mcpServerNames: [...names, "direct-one", "direct-two"],
    retiredBridge: oldArg, currentBridge: newArg,
  });

  assert.equal(result.managedFragment, "replaced");
  assert.deepEqual(result.migratedMcpServers, names);
  assert.equal((result.config.match(/registry-http-bridge\.mts/g) || []).length, 5);
  assert.doesNotMatch(result.config, /registry-http-bridge\.js/);
  assert.match(result.config, /\[mcp_servers\.one\]\nenabled = false/);
  assert.match(result.config, /custom = 'keep'/);
  assert.match(result.config, /command = 'direct-two'\nargs = \['keep'\]/);
});

test("ignores retired paths in comments and rejects them inside a different runtime argument", () => {
  const oldArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.js`;
  const newArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.mts`;
  const commented = [
    "[mcp_servers.one]", `# retained note: ${oldArg}`, `args = ['${oldArg}']`, "",
  ].join("\n");
  const migrated = migrateExactUnmanagedMcpArg(commented, "one", oldArg, newArg, START, END);
  assert.equal(migrated.config, commented.replace(`args = ['${oldArg}']`, `args = ['${newArg}']`));

  const embedded = [
    "[mcp_servers.one]", `args = ['--bridge=${oldArg}']`, "",
  ].join("\n");
  assert.throws(
    () => migrateExactUnmanagedMcpArg(embedded, "one", oldArg, newArg, START, END),
    /could not be migrated safely/,
  );
});

test("migrates the same canonical Windows path written with forward slashes", () => {
  const oldArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.js`;
  const newArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.mts`;
  const oldForward = oldArg.replaceAll("\\", "/");
  const newForward = newArg.replaceAll("\\", "/");
  const config = ["[mcp_servers.one]", `args = ['${oldForward}']`, ""].join("\n");
  assert.deepEqual(
    migrateExactUnmanagedMcpArg(config, "one", oldArg, newArg, START, END),
    { config: config.replace(oldForward, newForward), migrated: true },
  );
});

test("matches Windows drive paths case-insensitively without changing POSIX path case", () => {
  const oldArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.js`;
  const newArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.mts`;
  const lower = oldArg.toLowerCase();
  const windowsConfig = ["[mcp_servers.one]", `args = ['${lower}']`, ""].join("\n");
  assert.equal(
    migrateExactUnmanagedMcpArg(windowsConfig, "one", oldArg, newArg, START, END).config,
    windowsConfig.replace(lower, newArg),
  );

  const posixOld = "/Codex/orchestra/registry-http-bridge.js";
  const posixNew = "/Codex/orchestra/registry-http-bridge.mts";
  const posixConfig = ["[mcp_servers.one]", "args = ['/codex/orchestra/registry-http-bridge.js']", ""].join("\n");
  assert.equal(
    migrateExactUnmanagedMcpArg(posixConfig, "one", posixOld, posixNew, START, END).migrated,
    false,
  );
});

test("rejects prefix replacement when a different predecessor MCP projection remains", () => {
  const prefix = "[[hooks.Stop]]\ncommand = 'old-hook.js'";
  const staleMcp = "[mcp_servers.stale]\ncommand = 'stale'";
  const config = [START, prefix, "", staleMcp, END, ""].join("\n");
  assert.throws(
    () => replaceExactManagedFragment(config, START, END, [prefix], "new-hooks"),
    /unmatched MCP tables/,
  );
  assert.throws(
    () => replaceExactManagedFragment(config, START, END, ["older-hooks"], prefix),
    /unmatched MCP tables/,
  );
});

test("rejects an owned retired bridge reference under an unknown custom MCP name", () => {
  const oldArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.js`;
  const newArg = String.raw`C:\Fixture\.codex\orchestra\registry-http-bridge.mts`;
  const config = [
    START, "old-hooks", END,
    "[mcp_servers.unknown-custom]", `args = ['${oldArg}']`, "",
  ].join("\n");
  assert.throws(
    () => preserveConfigUpgrade(config, {
      startMarker: START, endMarker: END, knownManagedFragments: ["old-hooks"],
      managedReplacement: "new-hooks", mcpServerNames: ["known"],
      retiredBridge: oldArg, currentBridge: newArg,
    }),
    /unknown unmanaged MCP table/,
  );
});

// OP-1138. Zwischen dem Kherep-Rename und der Nudge-Migration hat der Installer
// eine Projektion geschrieben, die als bekanntes Fragment fehlte: aktuelle
// Produktnamen, die vier geteilten Nudges weiter .js. Jede so installierte Box
// lief danach in das fail-closed Refusal statt in ein Upgrade.
test("accepts the previous Kherep projection and still refuses an unknown managed block", () => {
  const previous = renderPreviousNudges({
    ...MANAGED_OPTIONS,
    mcpServers: MANAGED_OPTIONS.registryProjections,
  });
  const config = [START, previous, END, ""].join("\n");

  const result = prepareManagedConfig(config, MANAGED_OPTIONS);

  assert.equal(result.managedFragment, "replaced");
  assert.match(result.config, /codex-post-edit-checks\.mts/);
  for (const name of ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]) {
    assert.doesNotMatch(result.config, new RegExp(`${name}\\.(?:js|mts)`), "the current config invokes only the dispatcher");
  }
  assert.equal((result.config.match(/\[mcp_servers\.fixture_service\]/g) || []).length, 1);
  assert.equal(prepareManagedConfig(result.config, MANAGED_OPTIONS).managedFragment, "current");

  assert.throws(
    () => prepareManagedConfig(config.replace("loc-watch.js", "loc-watch.cjs"), MANAGED_OPTIONS),
    /without an exact known managed fragment/,
  );
});

test("Mac observation Stop upgrade recognizes the exact previous managed block", () => {
  const previous = prepareManagedConfig("", MANAGED_OPTIONS).config;
  const custom = '\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "custom-hook"\n';
  const nextOptions = { ...MANAGED_OPTIONS, observationStopHook: true };
  const upgraded = prepareManagedConfig(previous + custom, nextOptions).config;
  assert.match(upgraded, /codex-observation-stop\.mts/);
  assert.match(upgraded, /command = "custom-hook"/);
  assert.equal(prepareManagedConfig(upgraded, nextOptions).config, upgraded);
});
test("upgrades the exact pre-observation projection with and without retired native capture", () => {
  const omitObservation = (config: string): string => config.split("\n\n")
    .filter((block) => !block.includes("codex-observation-turn-completion"))
    .join("\n\n");
  // OP-1429. The second variant is a block an older installer wrote for the
  // retired Central Brain: native hooks plus its MCP table after the registry.
  const retired = retiredCentralBrainRender({ mcpCli: "/codex/brain/mcp.mjs", profile: "/codex/brain/profile.json",
    nativeHooks: { contextCli: "/codex/brain/native-context.js", captureCli: "/codex/brain/native-capture.mjs" } },
  MANAGED_OPTIONS.node);
  const variants = [
    { options: MANAGED_OPTIONS, written: { ...MANAGED_OPTIONS, mcpServers: MANAGED_OPTIONS.registryProjections } },
    { options: { ...MANAGED_OPTIONS, retiredCentralBrain: retired }, written: {
      ...MANAGED_OPTIONS, memoryProvider: "central-brain" as const, nativeHooks: retired.nativeHooks,
      mcpServers: [...MANAGED_OPTIONS.registryProjections, retired.server], windowsHookCommands: false,
    } },
  ];

  for (const { options, written } of variants) {
    const previous = omitObservation(render({ ...written, observationStopHook: false }));
    assert.match(previous, /codex-confluence-delivery-check\.mts/);
    assert.doesNotMatch(previous, /codex-observation-turn-completion\.mts/);
    const config = [START, previous, END, ""].join("\n");

    const result = prepareManagedConfig(config, options);
    assert.equal(result.managedFragment, "retiredCentralBrain" in options ? "replaced" : "current");
    assert.equal((result.config.match(/^command = .*codex-confluence-delivery-check\.mts/gm) || []).length, 1);
    assert.equal((result.config.match(/codex-observation-turn-completion\.mts/g) || []).length, 0);
    assert.doesNotMatch(result.config, /central-brain|native-context|native-capture/);
    assert.equal(prepareManagedConfig(result.config, options).managedFragment, "current");
    assert.throws(
      () => prepareManagedConfig(config.replace("codex-acceptance-gate.mts", "codex-acceptance-gate.mjs"), options),
      /without an exact known managed fragment/,
    );
  }
});

// Issue #212. The installer used to force model_reasoning_effort to "xhigh".
test("keeps an existing top-level reasoning effort byte for byte", () => {
  const line = "model_reasoning_effort  =  'low'  # operator choice";
  const config = `model = "fixture"\n${line}\n`;
  const result = prepareManagedConfig(config, MANAGED_OPTIONS);
  assert.ok(result.config.startsWith(config));
  assert.equal((result.config.match(/model_reasoning_effort/g) || []).length, 1);
  assert.deepEqual(result.reasoningEffort, { status: "preserved-existing", value: "low" });
  assert.equal(prepareManagedConfig(result.config, MANAGED_OPTIONS).config, result.config);
});

// Issue #737. An absent top-level effort stays absent (the #212 xhigh fill is
// gone); only the explicit root apply writes the effective root pair.
test("keeps an absent top-level reasoning effort absent unless the root pair is applied", () => {
  const profile = '[profiles.fast]\nmodel_reasoning_effort = "medium"\n';
  const config = `model = "fixture"\n\n${profile}`;
  const result = prepareManagedConfig(config, MANAGED_OPTIONS);
  assert.ok(result.config.startsWith(config.split("\n\n")[0]!));
  assert.equal((result.config.match(/^model_reasoning_effort/gm) || []).length, 1, "only the profile value");
  assert.deepEqual(result.reasoningEffort, { status: "preserved-absent", value: null });
  assert.equal(prepareManagedConfig(result.config, MANAGED_OPTIONS).config, result.config);
  const applied = prepareManagedConfig(config, { ...MANAGED_OPTIONS, applyRootModel: { model: "gpt-6.10-sol", effort: "xhigh" } });
  assert.ok(applied.config.startsWith('model_reasoning_effort = "xhigh"\nmodel = "gpt-6.10-sol"\n'));
  assert.ok(applied.config.includes(profile), "a profile value is never changed");
  assert.deepEqual(applied.reasoningEffort, { status: "applied", value: "xhigh" });
  const replaced = prepareManagedConfig('model = "old"\nmodel_reasoning_effort = "low"\n', { ...MANAGED_OPTIONS, applyRootModel: { model: "gpt-6.10-sol", effort: "high" } });
  assert.ok(replaced.config.startsWith('model = "gpt-6.10-sol"\nmodel_reasoning_effort = "high"\n'));
});

test("full upgrade recognizes the exact unbound current block, binds only context, and settles", () => {
  const old = prepareManagedConfig("", MANAGED_OPTIONS).config;
  const options = { ...MANAGED_OPTIONS, contextWorkspace: "/synthetic/workspace" };
  const upgraded = prepareManagedConfig(old, options);
  assert.equal(upgraded.managedFragment, "replaced");
  assert.match(upgraded.config, /--workspace-b64/);
  assert.equal(prepareManagedConfig(upgraded.config, options).config, upgraded.config);
  assert.throws(() => prepareManagedConfig(old.replace("Loading Kherep Maestro", "unknown"), options), /exact known managed fragment/);
});
