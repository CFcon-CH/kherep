import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { render, renderBeforeSelfAssignment, type RenderOptions } from "./parity-config.mts";
import { prepareManagedConfig } from "./config-preservation.mts";
import { INTERCOM_SELF_ASSIGNMENT_RULE } from "../../modules/control-plane/node/intercom-instructions.mts";

const options = { contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks", node: "/synthetic/node", mcpServers: [],
  messagingClient: { enabled: true, bridge: "/synthetic/bridge.mts", intentHook: "/synthetic/intent.mts", configRoot: "/synthetic/config" } } satisfies RenderOptions;
test("self-assignment adds only its Codex matcher alternative and recognizes the previous managed block", () => {
  const old = renderBeforeSelfAssignment(options), next = render(options);
  assert.equal(old.replace("sessions|send|inbox|reply|status)", "sessions|send|inbox|reply|status|assign_self)"), next);
  const trust = '[hooks.state."config.toml:pre_tool_use:5:0"]\ntrusted_hash = "old-definition"\n';
  const custom = '[[hooks.PreToolUse]]\nmatcher = "operator"\n[[hooks.PreToolUse.hooks]]\ncommand = "operator"\n';
  const config = `# start\n${old}\n${trust}# end\n${custom}`;
  const upgraded = prepareManagedConfig(config, { ...options, memoryProvider: "unconfigured", startMarker: "# start", endMarker: "# end",
    retiredMcpServerNames: [], registryProjections: [], pluginMcpServers: {}, registry: "/synthetic/registry.json",
    registryBridge: "/synthetic/bridge.mts", registryRuntime: "/synthetic/runtime.mts", memoryNotifyHook: "/synthetic/notify.mts" });
  assert.equal(upgraded.managedFragment, "replaced");assert.ok(upgraded.config.includes("assign_self"));
  assert.ok(upgraded.config.includes(custom));assert.ok(upgraded.config.includes(trust));
});
test("installed Codex instruction source contains the exact explicit-Director policy", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  assert.ok(fs.readFileSync(path.join(root, "codex/AGENTS.maestro.md"), "utf8").includes(INTERCOM_SELF_ASSIGNMENT_RULE));
});
