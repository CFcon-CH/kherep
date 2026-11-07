// Issue #507, part 4. The three Codex guards that ran directly (the Atlassian
// destructive guard, the dispatch-contract guard, the Playwright guard) are
// wired through the fail-closed hook adapter. Only those three entries change;
// the exact block an installer at 3054123 wrote is recognised and replaced, and
// its trust bytes and the operator's own groups are kept.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import * as parity from "./parity-config.mts";

const OPTIONS: parity.RenderOptions = { contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks",
  node: "/synthetic/node", mcpServers: [], controlPlaneHook: "/synthetic/repo/modules/control-plane/node/deliver-hook.mts" };
const options = { ...OPTIONS, memoryProvider: "unconfigured" as const, startMarker: "# start", endMarker: "# end", retiredMcpServerNames: [],
  registryProjections: [], pluginMcpServers: {}, registry: "/synthetic/registry.json", registryBridge: "/synthetic/bridge.mts",
  registryRuntime: "/synthetic/runtime.mts", memoryNotifyHook: "/synthetic/notify.mts" };
// sha256 of render(o) at 3054123 for the three variants below, recorded before the change.
const BASE_SHA = ["884ffa3348166c920a277c48545d505a36a410a49097d4d490d024447b8c2138",
  "ca32d9fc26a77ef7d69bad08c20421602d4ab6af9e232e07ebffcc52f98b8aed", "9fb30bc11ab37062a448128d94ba8df9451016953c59fbfe961dd02b95ab6d99"];
const VARIANTS = [OPTIONS, { ...OPTIONS, windowsHookCommands: false }, { ...OPTIONS, controlPlaneHook: undefined }];
// The renderer joins hook paths with path.join, so on win32 they carry backslashes
// (issue #534). The expected commands are built the same way and TOML-escaped as the
// render writes them; on POSIX they are exactly "\"/synthetic/node\" \"/synthetic/hooks/...\"".
const hook = (name: string): string => path.join(OPTIONS.hookDir, name);
const toml = (...parts: string[]): string => JSON.stringify(parity.command(OPTIONS.node, ...parts));
const ADAPTER = JSON.stringify(`"${hook("codex-hook-adapter.mts")}"`).slice(1, -1);
const GUARDS: Array<[string, string[]]> = [
  ["atlassian-destructive-guard.mts", ["--runtime", "codex"]], ["codex-dispatch-contract-guard.mts", []], ["playwright-file-guard.mts", []],
];
const DIRECT = GUARDS.map(([name, args]) => toml(hook(name), ...args));
const ADAPTED = GUARDS.map(([name, args]) => toml(hook("codex-hook-adapter.mts"), hook(name), "pre", ...args));
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
// Each [[hooks.PreToolUse.hooks]] entry of a render, in order.
const preEntries = (config: string): string[] => config.split(/^\[\[hooks\.PreToolUse\.hooks\]\]$/m).slice(1)
  .map((entry) => entry.split(/^\[\[?(?!hooks\.PreToolUse\.hooks)/m)[0]!.trim());
const renderBeforeAdapted = (o: parity.RenderOptions): string =>
  (parity as unknown as { renderBeforeAdaptedDirectGuards: typeof parity.render }).renderBeforeAdaptedDirectGuards(o);

test("T1a every adapter command of the render has timeout 10 and its Windows form", () => {
  const entries = preEntries(parity.render(OPTIONS)).filter((entry) => entry.includes(ADAPTER));
  assert.equal(entries.length, 5, "two privacy entries and the three former direct guards");
  for (const entry of entries) {
    assert.match(entry, /^timeout = 10$/m);
    const command = /^command = (".*")$/m.exec(entry)![1]!;
    assert.equal(/^commandWindows = (".*")$/m.exec(entry)?.[1], JSON.stringify(`& ${JSON.parse(command)}`));
  }
  for (const [index, adapted] of ADAPTED.entries()) {
    assert.equal(entries.filter((entry) => entry.includes(`command = ${adapted}`)).length, 1, adapted);
    assert.ok(!parity.render(OPTIONS).includes(`command = ${DIRECT[index]}`), DIRECT[index]);
  }
});

// The byte pins were recorded on POSIX; on win32 the joined hook paths differ, and T1c
// still proves there that exactly the three guard entries differ (issue #534).
test("T1b renderBeforeAdaptedDirectGuards reproduces the 3054123 render byte for byte",
  { skip: process.platform === "win32" && "the 3054123 byte pins are POSIX renders; T1c covers win32" }, () => {
  for (const [index, o] of VARIANTS.entries()) assert.equal(sha256(renderBeforeAdapted(o)), BASE_SHA[index], `variant ${index}`);
});

test("T1c exactly the three guard entries differ; group count, matchers and entry counts stay", () => {
  for (const o of VARIANTS) {
    const before = preEntries(renderBeforeAdapted(o));
    const after = preEntries(parity.render(o));
    assert.equal(after.length, before.length);
    const changed = after.map((entry, index) => [entry, before[index]!] as const).filter(([a, b]) => a !== b);
    assert.equal(changed.length, 3);
    for (const [index, [a, b]] of changed.entries()) {
      assert.ok(b.includes(`command = ${DIRECT[index]}`), b);
      assert.ok(a.includes(`command = ${ADAPTED[index]}`), a);
    }
    const headers = (config: string): string[] => config.match(/^\[\[hooks\.[A-Za-z]+\]\]\n(?:matcher = .*)?/gm) ?? [];
    assert.deepEqual(headers(parity.render(o)), headers(renderBeforeAdapted(o)));
  }
});

test("T1d every other historical renderer renders no adapted direct guard", () => {
  for (const [name, value] of Object.entries(parity)) {
    // Issue #538: the predecessor of the adapted intent entry already has the adapted guards.
    if (name === "renderBeforeAdaptedDirectGuards" || name === "renderBeforeAdaptedIntentHook" || name === "renderBeforeSelfAssignment" || !/^render(Before|Previous|Legacy)/.test(name) || typeof value !== "function") continue;
    const config = (value as typeof parity.render)(OPTIONS);
    for (const adapted of ADAPTED) assert.ok(!config.includes(adapted.slice(1, -1)), `${name}: ${adapted}`);
  }
});

test("T2 the exact 3054123 block with trust bytes and an operator group is replaced, settles, drift is refused", () => {
  const trust = '[hooks.state."config.toml:pre_tool_use:3:0"]\ntrusted_hash = "sha256:old-dispatch"\n';
  const custom = '[[hooks.PreToolUse]]\nmatcher = "operator"\n[[hooks.PreToolUse.hooks]]\ncommand = "operator-hook"\n';
  const written = `${options.startMarker}\n${renderBeforeAdapted(OPTIONS)}\n${trust}${options.endMarker}\n${custom}`;
  const result = prepareManagedConfig(written, options);
  assert.equal(result.managedFragment, "replaced");
  for (const adapted of ADAPTED) assert.equal(result.config.split(`command = ${adapted}`).length, 2, adapted);
  for (const direct of DIRECT) assert.ok(!result.config.includes(`command = ${direct}`), direct);
  assert.ok(result.config.includes(trust), "trust bytes kept");
  assert.ok(result.config.includes(custom), "operator group kept verbatim");
  assert.equal((result.config.match(/trusted_hash = /g) || []).length, 1, "no trust minted");
  assert.equal(prepareManagedConfig(result.config, options).config, result.config);
  assert.equal(prepareManagedConfig(result.config, options).managedFragment, "current");
  assert.throws(() => prepareManagedConfig(written.replace("playwright-file-guard.mts", "playwright-file-guarD.mts"), options),
    /exact known managed fragment/);
});
