import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { launcherCommand } from "../../modules/control-plane/node/launcher.mts";
import { install } from "../install.mts";
import type { Capabilities } from "./contracts.mts";
import { fixtureModelOptions } from "./model-policy.fixture.mts";
import { KNOWLEDGE_READ_RULES_FILE } from "./knowledge-read-rules.mts";
import {
  CONTROL_PLANE_RULES_FILE, MSG_SUBCOMMANDS, controlPlaneRulesPath, launcherRule, renderControlPlaneRules, starlarkString,
} from "./control-plane-rules.mts";

// Issue #72; issue #436: one rule, for the stable launcher.
const WINDOWS_ROOT = String.raw`C:\Users\a\AppData\Roaming\kherep`;
const MAC_ROOT = "/Users/a/Library/Application Support/kherep";

function patterns(rules: string): string[] {
  return rules.split("\n").filter((line) => line.trimStart().startsWith("pattern = ")).map((line) => line.trim());
}

test("the Windows launcher rule names the forward-slash path and the exact command in its examples", () => {
  const command = launcherCommand(WINDOWS_ROOT, "win32");
  const rules = renderControlPlaneRules([launcherRule(command)]);
  assert.deepEqual(patterns(rules), [
    'pattern = ["node", "C:/Users/a/AppData/Roaming/kherep/bin/kherep-node.mjs", "msg", ["send", "sessions", "inbox", "status"]],',
  ]);
  assert.ok(rules.includes(`        ${starlarkString(`${command} msg sessions`)},`));
  assert.ok(rules.includes(`        ${starlarkString(`${command} msg send peer/session -- hello`)},`));
  assert.ok(rules.includes(`        ${starlarkString(`${command} task new --title x`)},`));
  assert.ok(rules.includes('decision = "allow",'));
  assert.equal(rules.match(/# Managed by Kherep/g)?.length, 1);
});

test("a macOS launcher path with a space stays one double-quoted token", () => {
  const command = launcherCommand(MAC_ROOT, "darwin");
  const rule = launcherRule(command);
  assert.deepEqual(rule, { node: "node", cli: `${MAC_ROOT}/bin/kherep-node.mjs`, prefix: command });
  assert.ok(renderControlPlaneRules([rule]).includes(String.raw`"node \"/Users/a/Library/Application Support/kherep/bin/kherep-node.mjs\" msg inbox --all",`));
});

test("Starlark strings escape backslashes and double quotes and refuse control characters", () => {
  assert.equal(starlarkString(String.raw`a\b"c`), String.raw`"a\\b\"c"`);
  assert.throws(() => starlarkString("a\nb"), /Control characters/);
});

test("only the four msg subcommands are allowed, in a single rule without the checkout CLI", () => {
  assert.deepEqual([...MSG_SUBCOMMANDS], ["send", "sessions", "inbox", "status"]);
  const rules = renderControlPlaneRules([launcherRule(launcherCommand(MAC_ROOT, "darwin"))]);
  assert.equal(rules.match(/prefix_rule\(/g)?.length, 1);
  assert.equal(rules.match(/decision = /g)?.length, 1);
  assert.equal(rules.includes("cli.mts"), false);
});

test("launcherRule accepts only the launcher command shape", () => {
  for (const value of ["node /x/kherep-node.mjs", `node "/x/a"b.mjs"`, String.raw`node "C:\x\kherep-node.mjs"`, `node "/x/$HOME.mjs"`, `"node" "/x/kherep-node.mjs"`]) {
    assert.throws(() => launcherRule(value), /launcher command/, value);
  }
  assert.throws(() => renderControlPlaneRules([]), /at least one command/);
});

const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
const codexAvailable = codex.status === 0;

function check(rulesFile: string, ...command: string[]): string {
  const result = spawnSync("codex", ["execpolicy", "check", "--rules", rulesFile, ...command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// The single rule as the installer writes it, for both platforms' roots.
for (const [platform, root] of [["Windows", WINDOWS_ROOT], ["macOS", MAC_ROOT]] as const) {
  test(`codex execpolicy loads the ${platform} launcher rule and allows only msg subcommands`, { skip: !codexAvailable && "codex is not on PATH" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-rules-"));
    const file = path.join(dir, CONTROL_PLANE_RULES_FILE);
    const launcher = launcherRule(launcherCommand(root, platform === "Windows" ? "win32" : "darwin"));
    fs.writeFileSync(file, renderControlPlaneRules([launcher]));
    for (const sub of MSG_SUBCOMMANDS) {
      assert.match(check(file, "node", launcher.cli, "msg", sub, "x"), /"decision":\s*"allow"/);
    }
    for (const other of [["task", "new", "--title", "x"], ["node", "unenroll"], ["msg", "reply", "x"]]) {
      assert.doesNotMatch(check(file, "node", launcher.cli, ...other), /"decision"/);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-rules-install-"));
  const codexHome = path.join(root, "home", ".codex");
  const claudeRegistryFile = path.join(root, "home", ".claude.json");
  fs.mkdirSync(codexHome, { recursive: true });
  const capabilities = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, "..", "parity", "capabilities.json"), "utf8")) as Capabilities;
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: Object.fromEntries(
    capabilities.mcpServers.map((name) => [name, { type: "http", url: `https://example.test/${name}` }])) }), { mode: 0o600 });
  return {
    root, codexHome,
    options: {
      ...fixtureModelOptions(),
      codexHome, claudeRegistryFile,
      claudeConfigDir: path.join(root, "home", ".claude"),
      workspace: path.join(root, "workspace"),
      nodePath: process.execPath, log: (): void => {},
      skipPluginRegistration: true, installAtlassianTools: false,
      resolveRegistryRuntime: () => "fixture",
      runCodex: (): string => "ok",
      controlPlaneOutbox: path.join(root, "kherep config", "control-plane", "outbox"),
    },
  };
}

test("install writes the managed rule file and leaves other rule files byte-identical", () => {
  const { root, codexHome, options } = fixture();
  const own = Buffer.from("# operator rules\r\nprefix_rule(pattern = [\"git\", \"status\"], decision = \"allow\")\n");
  const defaultRules = path.join(codexHome, "rules", "default.rules");
  fs.mkdirSync(path.dirname(defaultRules), { recursive: true });
  fs.writeFileSync(defaultRules, own);
  const expected = renderControlPlaneRules([launcherRule(launcherCommand(path.join(root, "kherep config")))]);

  install(options);
  assert.equal(fs.readFileSync(controlPlaneRulesPath(codexHome), "utf8"), expected);
  assert.deepEqual(fs.readFileSync(defaultRules), own);

  fs.writeFileSync(controlPlaneRulesPath(codexHome), "# edited by hand\n");
  install(options);
  assert.equal(fs.readFileSync(controlPlaneRulesPath(codexHome), "utf8"), expected);
  assert.deepEqual(fs.readFileSync(defaultRules), own);
  assert.deepEqual(fs.readdirSync(path.join(codexHome, "rules")).sort((a, b) => a.localeCompare(b)), ["default.rules", CONTROL_PLANE_RULES_FILE, KNOWLEDGE_READ_RULES_FILE]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("install creates rules/ when it is absent", () => {
  const { root, codexHome, options } = fixture();

  install(options);

  assert.deepEqual(fs.readdirSync(path.join(codexHome, "rules")).sort((a, b) => a.localeCompare(b)), [CONTROL_PLANE_RULES_FILE, KNOWLEDGE_READ_RULES_FILE]);
  fs.rmSync(root, { recursive: true, force: true });
});
