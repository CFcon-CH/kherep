import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig, type ManagedConfigOptions } from "./config-preservation.mts";
import { controlPlaneCommand, hookGroup, render, renderBeforeAttributionHook } from "./parity-config.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const SHELL = "Bash|shell_command|exec_command|functions\\.exec";
const OPTIONAL = { fixture_optional: { url: "https://fixture.example.invalid/mcp" } };
const TRUST = "[hooks.state]\n" + Array.from({ length: 29 }, (_, index) =>
  `"fixture:${index}" = { enabled = true }`).join("\n");

function options(windows: boolean): ManagedConfigOptions {
  const root = windows ? String.raw`C:\Synthetic` : "/synthetic";
  const file = (suffix: string): string => `${root}/${suffix}`;
  return {
    startMarker: START, endMarker: END, retiredMcpServerNames: [], registryProjections: [],
    pluginMcpServers: {}, optionalPluginMcpServers: OPTIONAL,
    node: file("node"), contextHook: file("codex/context.mts"), hookDir: file("codex/hooks"),
    registry: file("registry.json"), registryBridge: file("codex/bridge.mts"),
    registryRuntime: file("codex/runtime.mts"), memoryNotifyHook: file("codex/notify.mts"),
    controlPlaneHook: file("kherep/modules/control-plane/node/deliver-hook.mts"),
    messagingClient: { enabled: true, bridge: file("messaging/bridge.mts"),
      intentHook: file("messaging/intent.mts"), configRoot: file("node-config") },
  };
}

function externalGroups(o: ManagedConfigOptions): string {
  // Issue #503. Exact external groups in the stable entry-point form.
  const bound = controlPlaneCommand(o.node, o.hookDir, "deliver");
  return [["SessionStart", "startup|resume|clear|compact"], ["UserPromptSubmit", ""], ["Stop", ""]]
    .map(([event, matcher]) => hookGroup(event!, matcher!, [{ command: bound, commandWindows: `& ${bound}` }]))
    .join("\n\n");
}

function groups(config: string, event: string): string[][] {
  return config.split(/^(?=\[\[hooks\.[A-Za-z]+\]\]$)/m).slice(1)
    .filter((group) => group.startsWith(`[[hooks.${event}]]`))
    .map((group) => group.split(/^\[(?!\[)/m)[0]!)
    .map((group) => group.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m).map((entry) => entry.trim()));
}

const attributionCount = (config: string): number =>
  [...config.matchAll(/^command = .*codex-control-plane-hook\.mts\\" \\"attribution/gm)].length;
const deliveryCount = (config: string): number =>
  [...config.matchAll(/^command = .*codex-control-plane-hook\.mts\\" \\"deliver/gm)].length;

for (const windows of [false, true]) {
  const o = options(windows);
  const previous = renderBeforeAttributionHook({ ...o, mcpServers: [], controlPlaneHook: undefined });
  const tail = [externalGroups(o), hookGroup("PreToolUse", "^fixture_binding_probe$",
    [{ command: "operator-binding-probe" }]), TRUST].join("\n\n");
  const input = `${START}\n${previous}${END}\n\n${tail}\n`;

  test(`external delivery ownership retains attribution and positional trust (${windows ? "Windows" : "POSIX"})`, () => {
    assert.equal(attributionCount(input), 0);
    const result = prepareManagedConfig(input, o);
    assert.equal(attributionCount(result.config), 2);
    assert.equal(result.managedFragment, "replaced");
    assert.equal(deliveryCount(result.config), 4);
    assert.ok(result.config.includes(tail));

    const beforePre = groups(input, "PreToolUse");
    const afterPre = groups(result.config, "PreToolUse");
    assert.equal(afterPre.length, beforePre.length);
    const shellIndex = beforePre.findIndex(([header]) => header!.includes(JSON.stringify(SHELL)));
    assert.ok(shellIndex >= 0);
    // Issue #376. The destructive guard ends the Agent, web and MCP group.
    const mcpIndex = beforePre.findIndex(([header]) => header!.includes("|mcp__.*"));
    assert.ok(mcpIndex >= 0);
    assert.match(afterPre[mcpIndex]!.at(-1)!, /atlassian-destructive-guard\.mts/);
    afterPre.forEach((group, index) => {
      if (index === shellIndex) {
        assert.equal(group[0], beforePre[index]![0], "shell group position and matcher stay intact");
        assert.equal(group.length, 2, "one dispatcher includes attribution");
        assert.match(group[1]!, /codex-shell-checks\.mts.*codex-control-plane-hook\.mts\\" \\"attribution/);
      } else if (/Agent\|spawn_agent"$|mcp__playwright__browser_navigate"$/.test(group[0]!)) {
        // Issue #507, part 4: the guard of these one-entry groups now runs through the adapter.
        assert.equal(group[0], beforePre[index]![0]);
        assert.equal(group.length, 2);
        assert.match(group[1]!, /^command = .*codex-hook-adapter\.mts\\" \\".*\\" \\"pre\\""$/m);
      } else if (group[0]!.includes("^mcp__kherep_messaging__")) {
        // Issue #538: the messaging intent entry now runs through the adapter in pre-intent.
        assert.equal(group[0], beforePre[index]![0]!.replace(
          "sessions|send|inbox|reply|status)", "sessions|send|inbox|reply|status|assign_self)"));
        assert.equal(group.length, 2);
        assert.match(group[1]!, /^command = .*codex-hook-adapter\.mts\\" \\".*intent\.mts\\" \\"pre-intent\\" \\"--config-root\\" .*$/m);
        assert.match(group[1]!, /^timeout = 15$/m);
      } else assert.deepEqual(index === mcpIndex ? group.slice(0, -1) : group, beforePre[index]);
    });
    assert.match(afterPre[shellIndex]!.at(-1)!, /codex-control-plane-hook\.mts\\" \\"attribution/);
    const afterPost = groups(result.config, "PostToolUse");
    const beforePost = groups(input, "PostToolUse");
    assert.equal(beforePost.length, 1);
    assert.equal(beforePost[0]!.length, 5, "the historical group has four watchers");
    ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"].forEach((name, index) => {
      assert.match(beforePost[0]![index + 1]!, new RegExp(`${name}\\.mts`));
    });
    assert.equal(afterPost.length, 3);
    assert.equal(afterPost[0]![0], beforePost[0]![0], "the edit group keeps its position and matcher");
    assert.equal(afterPost[0]!.length, 2, "one dispatcher replaces the four watcher entries");
    assert.deepEqual(afterPost[0], groups(render({ ...o, mcpServers: [], controlPlaneHook: undefined }), "PostToolUse")[0]);
    assert.ok(afterPost[1]![0]!.includes(JSON.stringify(SHELL)));
    assert.match(afterPost[1]!.at(-1)!, /codex-control-plane-hook\.mts\\" \\"attribution/);
    assert.match(afterPost[2]![0]!, /matcher = "\.\*"/);
    assert.match(afterPost[2]![1]!, /codex-control-plane-hook\.mts\\" \\"deliver/);
    assert.equal(prepareManagedConfig(result.config, o).config, result.config);
  });

  test(`external delivery block stays upgradeable after messaging and optional MCP changes (${windows ? "Windows" : "POSIX"})`, () => {
    const upgraded = prepareManagedConfig(input, o).config;
    for (const next of [
      { ...o, messagingClient: { ...o.messagingClient!, enabled: false } },
      { ...o, pluginMcpServers: OPTIONAL },
    ]) {
      const changed = prepareManagedConfig(upgraded, next).config;
      assert.equal(attributionCount(changed), 2);
      assert.equal(deliveryCount(changed), 4);
      assert.ok(changed.includes(tail));
      assert.equal(prepareManagedConfig(changed, next).config, changed);
      const restored = prepareManagedConfig(changed, o).config;
      assert.equal(restored, upgraded);
    }
  });
}
