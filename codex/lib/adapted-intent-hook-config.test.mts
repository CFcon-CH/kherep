// Issue #538. The optional messaging intent entry runs through the fail-closed hook
// adapter in the phase pre-intent with timeout 15. Only that entry changes; the exact
// block an installer at c44f3e4 wrote is recognised and replaced, and its trust bytes
// and the operator's own groups are kept. Synthetic paths only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import * as parity from "./parity-config.mts";

const INTENT = "/synthetic/orchestra/control-plane/node/mcp-intent-hook.mts";
const ROOT = "/synthetic/config-root";
const OPTIONS: parity.RenderOptions = { contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks",
  node: "/synthetic/node", mcpServers: [], controlPlaneHook: "/synthetic/repo/modules/control-plane/node/deliver-hook.mts",
  messagingClient: { enabled: true, bridge: "/synthetic/orchestra/control-plane/node/mcp-stdio-bridge.mts", intentHook: INTENT, configRoot: ROOT } };
const options = { ...OPTIONS, memoryProvider: "unconfigured" as const, startMarker: "# start", endMarker: "# end", retiredMcpServerNames: [],
  registryProjections: [], pluginMcpServers: {}, registry: "/synthetic/registry.json", registryBridge: "/synthetic/bridge.mts",
  registryRuntime: "/synthetic/runtime.mts", memoryNotifyHook: "/synthetic/notify.mts" };
// sha256 of render(o) at 99ecf26 (identical at c44f3e4) for the three variants below, recorded before the change.
const BASE_SHA = ["772145ab545af98d001eda6582d203660fdff7b5231a0e665364e5b086335abf",
  "115f0cc6254125560a0fe9470f5d45eb868f5fc3967edd6de3b9871ce4c26c37", "152ef70b36765bc6eff6de61ae34a1b9f8286d6615d9e87c525d91d169ab00ba"];
const VARIANTS = [OPTIONS, { ...OPTIONS, windowsHookCommands: false }, { ...OPTIONS, controlPlaneHook: undefined }];
// Built as the renderer builds them (path.join, then TOML-escaped), so they hold on win32 too.
const toml = (...parts: string[]): string => JSON.stringify(parity.command(OPTIONS.node, ...parts));
const DIRECT = toml(INTENT, "--config-root", ROOT);
const ADAPTED = toml(path.join(OPTIONS.hookDir, "codex-hook-adapter.mts"), INTENT, "pre-intent", "--config-root", ROOT);
const MATCHER = 'matcher = "^mcp__kherep_messaging__(sessions|send|inbox|reply|status|assign_self)$"';
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const preEntries = (config: string): string[] => config.split(/^\[\[hooks\.PreToolUse\.hooks\]\]$/m).slice(1)
  .map((entry) => entry.split(/^\[\[?(?!hooks\.PreToolUse\.hooks)/m)[0]!.trim());
// Through the namespace with a cast, so the file loads before the export exists.
const renderBeforeIntent = (o: parity.RenderOptions): string =>
  (parity as unknown as { renderBeforeAdaptedIntentHook: typeof parity.render }).renderBeforeAdaptedIntentHook(o);
const intentEntry = (config: string): string => {
  const group = config.split(MATCHER)[1]!.split(/^\[\[hooks\.(?!PreToolUse\.hooks)/m)[0]!;
  assert.equal(group.split(/^\[\[hooks\.PreToolUse\.hooks\]\]$/m).length, 2, "the intent group has one entry");
  return group;
};

test("C1 the intent entry runs through the adapter in pre-intent with timeout 15 and its Windows form", () => {
  const config = parity.render(OPTIONS);
  const entry = intentEntry(config);
  assert.match(entry, new RegExp(`^command = ${ADAPTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal(/^commandWindows = (".*")$/m.exec(entry)?.[1], JSON.stringify(`& ${JSON.parse(ADAPTED)}`));
  assert.match(entry, /^timeout = 15$/m);
  assert.ok(!config.includes(`command = ${DIRECT}`), "the direct form is gone");
  assert.equal(config.match(/^\[\[hooks\.PreToolUse\]\]$/gm)?.length, 6);
  assert.equal(preEntries(config).length, 7);
  assert.equal(preEntries(config).filter((block) => /^command = .*codex-hook-adapter\.mts[^\n]*\\" \\"pre(?:-privacy)?\\"/m.test(block)).length, 5);
});

test("C2 renderBeforeAdaptedIntentHook reproduces the c44f3e4 render byte for byte",
  { skip: process.platform === "win32" && "the c44f3e4 byte pins are POSIX renders; C3 covers win32" }, () => {
  for (const [index, o] of VARIANTS.entries()) assert.equal(sha256(renderBeforeIntent(o)), BASE_SHA[index], `variant ${index}`);
});

test("C3 exactly the intent entry differs; group headers and matchers stay", () => {
  for (const o of VARIANTS) {
    const before = preEntries(renderBeforeIntent(o));
    const after = preEntries(parity.render(o));
    assert.equal(after.length, before.length);
    const changed = after.map((entry, index) => [entry, before[index]!] as const).filter(([a, b]) => a !== b);
    assert.equal(changed.length, 1);
    assert.ok(changed[0]![1].includes(`command = ${DIRECT}`), changed[0]![1]);
    assert.ok(changed[0]![0].includes(`command = ${ADAPTED}`), changed[0]![0]);
    const headers = (config: string): string[] => config.match(/^\[\[hooks\.[A-Za-z]+\]\]\n(?:matcher = .*)?/gm) ?? [];
    assert.deepEqual(headers(parity.render(o)), headers(renderBeforeIntent(o)).map(header =>
      header.replace("sessions|send|inbox|reply|status)", "sessions|send|inbox|reply|status|assign_self)")));
  }
});

test("C4 every other historical renderer renders the direct intent entry, never the adapter form", () => {
  for (const [name, value] of Object.entries(parity)) {
    if (["renderBeforeAdaptedIntentHook", "renderBeforeSelfAssignment"].includes(name) || !/^render(Before|Previous|Legacy)/.test(name) || typeof value !== "function") continue;
    const config = (value as typeof parity.render)(OPTIONS);
    assert.ok(!config.includes(ADAPTED.slice(1, -1)), name);
    if (config.includes(MATCHER)) assert.ok(config.includes(DIRECT.slice(1, -1)), name);
  }
});

test("C5 the exact c44f3e4 messaging block with trust bytes and an operator group is replaced, settles, drift is refused", () => {
  const trust = '[hooks.state."config.toml:pre_tool_use:5:0"]\ntrusted_hash = "sha256:old-intent"\n';
  const custom = '[[hooks.PreToolUse]]\nmatcher = "operator"\n[[hooks.PreToolUse.hooks]]\ncommand = "operator-hook"\n';
  const written = `${options.startMarker}\n${renderBeforeIntent(OPTIONS)}\n${trust}${options.endMarker}\n${custom}`;
  const result = prepareManagedConfig(written, options);
  assert.equal(result.managedFragment, "replaced");
  assert.equal(result.config.split(`command = ${ADAPTED}`).length, 2);
  assert.ok(!result.config.includes(`command = ${DIRECT}`));
  assert.ok(result.config.includes(trust), "trust bytes kept");
  assert.ok(result.config.includes(custom), "operator group kept verbatim");
  assert.equal((result.config.match(/trusted_hash = /g) || []).length, 1, "no trust minted");
  assert.equal(prepareManagedConfig(result.config, options).config, result.config);
  assert.equal(prepareManagedConfig(result.config, options).managedFragment, "current");
  assert.throws(() => prepareManagedConfig(written.replace("mcp-intent-hook.mts", "mcp-intent-hooK.mts"), options),
    /exact known managed fragment/);
});

// sha256 of the messaging-disabled render at c44f3e4, recorded before the change.
test("C6 with the messaging client disabled the render is byte-identical to c44f3e4",
  { skip: process.platform === "win32" && "the c44f3e4 byte pin is a POSIX render" }, () => {
  const disabled = { ...OPTIONS, messagingClient: { ...OPTIONS.messagingClient!, enabled: false } };
  assert.equal(sha256(parity.render(disabled)), "bc073f8ad478d1e2726a92d7b39f6164286b65d84b7b19bd671621bafe33063d");
  assert.ok(!parity.render(disabled).includes("mcp-intent-hook.mts"));
});
