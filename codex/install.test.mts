import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  AGENTS_START,
  CONFIG_START,
  ATLASSIAN_MCP_SERVER, LOCAL_PLUGIN_ID,
  USER_START,
  install,
  parseArgs,
  renderObservationHook,
  resolveWorkspace,
  setMarkedBlock,
} from "./install.mts";
import { adaptSkillText } from "./lib/component-render.mts";
import { componentHash } from "./lib/component-hash.mts";
import { fixtureModelOptions } from "./lib/model-policy.fixture.mts";
import type { Capabilities } from "./lib/contracts.mts";
import { legacyForm } from "./lib/legacy-control-plane-form.mts";
import { command, hookGroup, renderRegistryMcpServer } from "./lib/parity-config.mts";
import { retiredCentralBrainRender } from "./lib/retired-central-brain.mts";
import { withoutRetiredTable, withRetiredCentralBrain } from "./lib/retired-central-brain-fixture.mts";

// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const here = import.meta.dirname;
const CAPABILITIES = JSON.parse(fs.readFileSync(path.join(here, "parity", "capabilities.json"), "utf8")) as Capabilities;
const FIXTURE_AUTHORIZATION = `Bearer ${"fixture".repeat(8)}`;
const AGENTS_END = "<!-- kherep:end -->";
const CONFIG_END = "# <<< Kherep Codex Maestro <<<";
const POST_EDIT_MATCHER = "Edit|Write|MultiEdit|apply_patch|functions\\.exec";

function renderedObservationHook(workspace: string): string {
  return renderObservationHook(
    fs.readFileSync(path.join(here, "hooks", "observation-turn-completion.mts"), "utf8"),
    workspace,
  );
}

test("renders exactly one observation workspace sentinel and fails closed otherwise", () => {
  const workspace = path.join("C:", "selected workspace with spaces", "Kherep");
  const marker = 'const SELECTED_WORKSPACE = "__KHEREP_SELECTED_WORKSPACE__";';
  const source = fs.readFileSync(
    path.join(here, "hooks", "observation-turn-completion.mts"),
    "utf8",
  );
  const rendered = renderObservationHook(source, workspace);

  assert.equal(rendered.includes(marker), false);
  assert.ok(rendered.includes(`const SELECTED_WORKSPACE = ${JSON.stringify(workspace)};`));
  assert.throws(() => renderObservationHook(source.replace(marker, ""), workspace), /sentinel/i);
  assert.throws(() => renderObservationHook(`${source}\n${marker}\n`, workspace), /sentinel/i);
});

// OP-1138. A config written before the nudge rename names the four shared
// Claude hooks .js. The legacy fixtures below are derived from the CURRENT
// projection, so they have to undo that rename too - otherwise they describe a
// block that never existed on any disk, and the installer is right to refuse it.
const legacyNudgeNames = (config: string): string =>
  ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]
    .reduce((text, name) => text.replaceAll(`${name}.mts`, `${name}.js`), config);

function fixtureMcpServer(root: string, name: string): Record<string, unknown> {
  if (name === "codebase-memory-mcp") {
    return {
      type: "stdio",
      command: path.join(root, "bin", "codebase-memory-mcp"),
      args: [],
    };
  }
  if (name === "n8n") {
    return {
      type: "stdio",
      command: path.join(root, "bin", "n8n-mcp"),
      args: ["--client-secret", FIXTURE_AUTHORIZATION],
      env: { FIXTURE_TOKEN: FIXTURE_AUTHORIZATION },
    };
  }
  if (name === "kherep-linkedin-cli") {
    return { type: "http", url: `https://${name}.example.invalid/mcp` };
  }
  // The fall-through shape is static-bearer HTTP: the only source whose secret
  // lives in the registry entry itself, so it is what proves the bridge keeps
  // the header out of config.toml and out of the receipt. Exactly one manifest
  // server has to carry it or the shape stops being exercised at all - it is
  // forge-knowledge because every other name is already load-bearing in another
  // MCP test. Which name wears the shape is fixture data; the shape is not.
  return {
    type: "http",
    url: `https://example.test/${name}`,
    headers: { Authorization: FIXTURE_AUTHORIZATION },
  };
}

function fixtureMcpServers(root: string): Record<string, unknown> {
  return Object.fromEntries(CAPABILITIES.mcpServers.map((name) => [
    name,
    fixtureMcpServer(root, name),
  ]));
}

function fixture() {
  const tempRoot = process.platform === "win32" ? os.tmpdir() : fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "kherep-codex-install-"));
  const codexHome = path.join(root, "home with spaces", ".codex");
  const claudeConfigDir = path.join(root, "home with spaces", ".claude");
  const claudeRegistryFile = path.join(root, "home with spaces", ".claude.json");
  const workspace = path.join(root, "workspace with spaces ' and $(throw 'expanded')", "Kherep");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(claudeRegistryFile), { recursive: true });
  fs.writeFileSync(
    claudeRegistryFile,
    JSON.stringify({ mcpServers: fixtureMcpServers(root) }),
    { mode: 0o600 },
  );
  const codexCalls: { args: string[]; cwd: string | undefined }[] = [];
  const runCodex = (args: string[], options: { cwd?: string } = {}): string => {
    codexCalls.push({ args, cwd: options.cwd });
    if (args[0] === "--version") return "codex-cli 0.144.6";
    if (args.join(" ") === "plugin marketplace list --json") return '{"marketplaces":[]}';
    return "ok";
  };
  const n8nAuthFile = path.join(root, "operator", "n8n.token");
  const n8nCaFile = path.join(root, "operator", "n8n-ca.pem");
  fs.mkdirSync(path.dirname(n8nAuthFile), { recursive: true });
  fs.writeFileSync(n8nAuthFile, "synthetic auth fixture\n", { mode: 0o600 });
  fs.writeFileSync(n8nCaFile, "synthetic CA fixture\n", { mode: 0o600 });
  const atlassianMcpTokenFile = path.join(root, "operator", "atl-mcp-credential-codex.txt");
  fs.writeFileSync(atlassianMcpTokenFile, `${"a".repeat(48)}\n`, { mode: 0o600 });
  const installOptions = {
    ...fixtureModelOptions(),
    claudeConfigDir, claudeRegistryFile, codexHome,
    workspace, installAtlassianTools: true, atlassianMcpTokenFile,
    nodePath: process.execPath, log: (): void => {},
    resolveRegistryRuntime: () => "fixture", runCodex,
    controlPlaneOutbox: path.join(root, "kherep config", "control-plane", "outbox"),
    mcpCompatibility: {
      operatorBindings: {
        n8n: {
          authentication: "secret-file-bearer" as const,
          authFile: n8nAuthFile,
          endpoint: "https://automation.example.invalid/mcp",
          caFile: n8nCaFile,
        },
      },
    },
  };
  return {
    root, codexCalls, codexHome,
    installOptions, workspace,
  };
}
function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

test("projects the Codex root orchestration boundary into routing and Maestro instructions", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(installOptions);
  const agents = fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8");
  const maestro = agents.slice(agents.indexOf(AGENTS_START), agents.indexOf(AGENTS_END));
  const routing = fs.readFileSync(path.join(codexHome, "orchestra", "ROUTING.md"), "utf8");
  for (const [name, text] of [["routing", routing], ["Maestro", maestro]]) {
    for (const rule of [
      /root.*orchestrator, not.*execution worker/i,
      /implementation, detailed investigations.*builds, long functional suites and native platform tests.*subagents/is,
      /short.*(?:routing|evidence).*read/is,
      /no long synchronous waits/i,
      /close the main turn/i,
      /retrievable.*(?:result|receipt)/i,
      /failure handling.*pickup/i,
      /(?:completion|input) events.*explicit pickup point/is,
      /(?:unknown|unverified).*runtime support.*UNKNOWN/is,
      /artifact identity/i,
      /privacy.*authority/i,
    ]) assert.match(text, rule, `${name} retains ${rule}`);
  }
  assert.match(routing, /Astra designs, SOL builds and coordinates the root/);
  assert.doesNotMatch(routing, /Maestro.*runs proportional checks/);
});

// Issue #376. Every block before this guard lacks its entry, the last one of
// the Agent, web and MCP PreToolUse group.
function withoutAtlassianDestructiveGuard(config: string, hookDir: string): string {
  const guard = command(process.execPath, path.join(hookDir, "atlassian-destructive-guard.mts"), "--runtime", "codex");
  const entry = hookGroup("PreToolUse", "", [{ command: guard, commandWindows: `& ${guard}` }])
    .slice("[[hooks.PreToolUse]]".length);
  assert.equal(config.split(entry).length, 2, "the current destructive guard entry must be present exactly once");
  return config.replace(entry, "");
}

function beforePostEditDispatcher(config: string, hookDir: string): string {
  config = beforeShellDispatcher(config, hookDir);
  const dispatcherCommand = command(process.execPath, path.join(hookDir, "codex-post-edit-checks.mts"));
  const dispatcherGroup = hookGroup("PostToolUse", POST_EDIT_MATCHER, [{
    command: dispatcherCommand, commandWindows: `& ${dispatcherCommand}`,
  }]);
  const predecessorHooks = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]
    .map((name) => {
      const rendered = command(process.execPath, path.join(hookDir, "codex-hook-adapter.mts"),
        path.join(hookDir, `${name}.mts`), "post");
      return { command: rendered, commandWindows: `& ${rendered}` };
    });
  const predecessor = config.replace(dispatcherGroup, hookGroup("PostToolUse", POST_EDIT_MATCHER, predecessorHooks));
  assert.notEqual(predecessor, config, "the current dispatcher group must be present exactly");
  return withoutAtlassianDestructiveGuard(predecessor, hookDir).replace(/\n\n\[\[hooks\.PostToolUse\]\]\nmatcher = "\.\*"\n\n\[\[hooks\.PostToolUse\.hooks\]\]\ntype = "command"\ncommand = .*deliver-hook\.mts.*\n(?:commandWindows = .*\n)?timeout = 10(?=\n)/, "");
}

// Issue #507, part 4. The three guards that ran directly until then, as every
// earlier installer wrote them: command and commandWindows of each, in place.
// Historical fixtures predate the explicit workspace argument.
function withoutContextWorkspace(config: string): string {
  return config.replace(/^(command(?:Windows)? = )(.+)$/gm, (line, prefix: string, raw: string) => {
    const cmd = JSON.parse(raw) as string;
    return cmd.includes('kherep-maestro-context.mts')
      ? prefix + JSON.stringify(cmd.replace(/ "--workspace-b64" "[A-Za-z0-9_-]+"/g, '')) : line;
  });
}

function beforeAdaptedDirectGuards(config: string, hookDir: string): string {
  config = withoutContextWorkspace(config);
  const adapter = path.join(hookDir, "codex-hook-adapter.mts");
  for (const [script, args] of [["atlassian-destructive-guard.mts", ["--runtime", "codex"]],
    ["codex-dispatch-contract-guard.mts", []], ["playwright-file-guard.mts", []]] as const) {
    const adapted = JSON.stringify(command(process.execPath, adapter, path.join(hookDir, script), "pre", ...args)).slice(1, -1);
    const direct = JSON.stringify(command(process.execPath, path.join(hookDir, script), ...args)).slice(1, -1);
    assert.ok(occurrences(config, `command = "${adapted}"`) === 1, `the adapted ${script} entry must be present exactly once`);
    config = config.replaceAll(adapted, direct);
  }
  return config;
}

// Issue #538. The messaging intent entry as the installer renders it now (adapted) and as
// every installer before wrote it (direct, timeout 10).
function intentCommands(codexHome: string, outbox: string): { adapted: string; direct: string } {
  const intentHook = path.join(codexHome, "orchestra", "control-plane", "node", "mcp-intent-hook.mts");
  const configRoot = path.dirname(path.dirname(path.resolve(outbox)));
  const adapter = path.join(codexHome, "hooks", "kherep-maestro", "codex-hook-adapter.mts");
  return { adapted: command(process.execPath, adapter, intentHook, "pre-intent", "--config-root", configRoot),
    direct: command(process.execPath, intentHook, "--config-root", configRoot) };
}

function beforeAdaptedIntentHook(config: string, codexHome: string, outbox: string): string {
  config = withoutContextWorkspace(config);
  // The pre-adapter installer also predates the self-assignment matcher.
  config = config.replace("sessions|send|inbox|reply|status|assign_self)", "sessions|send|inbox|reply|status)");
  const { adapted, direct } = intentCommands(codexHome, outbox);
  const entry = (value: string, timeout: number): string =>
    `command = ${JSON.stringify(value)}\ncommandWindows = ${JSON.stringify(`& ${value}`)}\ntimeout = ${timeout}\n`;
  assert.equal(occurrences(config, entry(adapted, 15)), 1, "the adapted intent entry must be present exactly once");
  return config.replace(entry(adapted, 15), entry(direct, 10));
}

// Reconstruct the exact pre-#386 group before deriving older fixtures. Every
// installer before issue #503 wrote this checkout into the Control Plane hooks.
function beforeShellDispatcher(config: string, hookDir: string): string {
  config = legacyForm(beforeAdaptedDirectGuards(config, hookDir), path.resolve(here, ".."));
  const attribution = path.resolve(here, "..", "modules", "control-plane", "node", "attribution-hook.mts");
  const current = command(process.execPath, path.join(hookDir, "codex-shell-checks.mts"), attribution, "--runtime", "codex");
  const matcher = "Bash|shell_command|exec_command|functions\\.exec";
  const currentGroup = hookGroup("PreToolUse", matcher, [{ command: current, commandWindows: `& ${current}`, timeout: 40 }]);
  const guards = [["commit-guard", "pre"], ["deploy-guard", "pre-no-transcript"], ["main-checkout-guard", "pre"]]
    .map(([name, phase]) => {
      const cmd = command(process.execPath, path.join(hookDir, "codex-hook-adapter.mts"), path.join(hookDir, `${name}.mts`), phase!);
      return { command: cmd, commandWindows: `& ${cmd}` };
    });
  const attr = command(process.execPath, attribution, "--runtime", "codex");
  const previous = hookGroup("PreToolUse", matcher, [...guards, { command: attr, commandWindows: `& ${attr}` }]);
  assert.ok(config.includes(currentGroup));
  return config.replace(currentGroup, previous);
}

// Issues #397 and #503. The Control Plane hooks of a block an install from a
// source pin wrote before issue #503 name that pin.
function fromSourcePin(config: string, pin: string): string {
  assert.ok(config.includes("codex-control-plane-hook.mts"));
  return legacyForm(config, pin);
}

// The layout the Codex app writes when it stores hook trust (issue #274): its
// trust tables inside the block, the block's tail behind the end marker.
const TRUST = "[hooks.state]\n\n[hooks.state.'config.toml:stop:0:0']\ntrusted_hash = \"sha256:fixture\"";
function splitByTrust(config: string): { config: string; head: string; tail: string } {
  const start = config.indexOf(CONFIG_START) + CONFIG_START.length;
  const end = config.indexOf(CONFIG_END);
  const body = config.slice(start, end);
  const cut = body.lastIndexOf("[[hooks.SessionStart]]");
  const head = body.slice(0, cut).trimEnd();
  const tail = body.slice(cut).trim();
  return {
    config: `${config.slice(0, start)}${head}\n\n${TRUST}\n${CONFIG_END}\n\n${tail}\n${config.slice(end + CONFIG_END.length)}`,
    head, tail,
  };
}

test("upgrades a block written from another source pin, also when the Codex app split it", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = fs.readFileSync(install(installOptions).targets.config, "utf8");
  const pin = path.join(codexHome, "orchestra", "source-pins", "0123456789abcdef0123456789abcdef01234567");
  const configTarget = path.join(codexHome, "config.toml");
  const escaped = (value: string): string => JSON.stringify(value).slice(1, -1);
  const pinned = escaped(path.join(pin, "modules"));
  // The issue's Node variant: the earlier install also ran another Node executable.
  const previousNode = path.join(root, "previous node", path.basename(process.execPath));
  const fromNode = (text: string): string => text.replaceAll(escaped(process.execPath), escaped(previousNode));
  fs.writeFileSync(configTarget, splitByTrust(current).config);
  const sameCheckout = fs.readFileSync(install(installOptions).targets.config, "utf8");

  for (const earlier of [(text: string) => fromSourcePin(text, pin), (text: string) => fromNode(fromSourcePin(text, pin))]) {
    fs.writeFileSync(configTarget, earlier(current));
    assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), current);

    const split = splitByTrust(earlier(current));
    assert.ok(split.head.includes(pinned) && split.tail.includes(pinned), "both parts name the earlier pin");
    fs.writeFileSync(configTarget, split.config);
    const upgraded = fs.readFileSync(install(installOptions).targets.config, "utf8");
    const block = upgraded.slice(upgraded.indexOf(CONFIG_START), upgraded.indexOf(CONFIG_END));
    assert.equal(block.includes(pinned) || block.includes(escaped(previousNode)), false);
    assert.ok(upgraded.slice(upgraded.indexOf(CONFIG_END)).includes(TRUST), "the trust tables stay");
    assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), upgraded, "a reinstall is idempotent");
    // A split block from the earlier pin ends exactly as the same split block
    // from this checkout does. The tables the re-anchor leaves behind the end
    // marker are kept as written, so this holds for the pin alone.
    if (!split.config.includes(escaped(previousNode))) assert.equal(upgraded, sameCheckout);
  }
});

test("refuses a block from another source pin that also carries an operator edit", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = fs.readFileSync(install(installOptions).targets.config, "utf8");
  const pin = path.join(codexHome, "orchestra", "source-pins", "0123456789abcdef0123456789abcdef01234567");
  const edit = (text: string): string => text.replace(/^timeout = (\d+)$/m, (_, seconds) => `timeout = ${Number(seconds) + 1}`);
  for (const config of [edit(fromSourcePin(current, pin)), edit(splitByTrust(fromSourcePin(current, pin)).config)]) {
    fs.writeFileSync(path.join(codexHome, "config.toml"), config);
    assert.throws(() => install(installOptions), /without an exact known managed fragment/);
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), config, "nothing is written");
  }
});

test("installs native Codex research hooks and every local dependency idempotently", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const hookDir = path.join(codexHome, "hooks", "kherep-maestro");
  const projected = new Map([
    ["codex-research-first.mts", "research-first.mts"],
    ["codex-research-stop.mts", "research-stop.mts"],
    ["research-common.mts", "research-common.mts"],
    ["research-exec-parser.mts", "research-exec-parser.mts"],
    ["research-transcript.mts", "research-transcript.mts"],
  ]);
  for (const [target, source] of projected) {
    assert.equal(fs.readFileSync(path.join(hookDir, target), "utf8"),
      fs.readFileSync(path.join(import.meta.dirname, "hooks", source), "utf8"), target);
  }
  const config = fs.readFileSync(first.targets.config, "utf8");
  assert.match(renderedHookGroup(config, "UserPromptSubmit"), /codex-research-first\.mts/);
  assert.match(renderedHookGroup(config, "Stop"), /codex-research-stop\.mts/);
  assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), config);
});

test("installs the post-edit dispatcher and safely upgrades its exact four-hook predecessor", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const hookDir = path.join(codexHome, "hooks", "kherep-maestro");
  const sources = new Map([
    ["codex-post-edit-checks.mts", path.join(here, "hooks", "post-edit-checks.mts")],
    ["post-edit-tool-calls.mts", path.join(here, "hooks", "post-edit-tool-calls.mts")],
    ["codex-hook-adapter.mts", path.join(here, "hooks", "hook-adapter.mts")],
    ["hook-adapter.mts", path.join(here, "hooks", "hook-adapter.mts")],
    ["hook-adapter-payload.mts", path.join(here, "hooks", "hook-adapter-payload.mts")],
    ["hook-adapter-verdict.mts", path.join(here, "hooks", "hook-adapter-verdict.mts")],
    ["hook-adapter-run.mts", path.join(here, "hooks", "hook-adapter-run.mts")],
    ["research-exec-parser.mts", path.join(here, "hooks", "research-exec-parser.mts")],
    ["denied-calls.mts", path.join(here, "..", "claude", "hooks", "denied-calls.mts")], // issue #504
    ...["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]
      .map((name) => [`${name}.mts`, path.join(here, "..", "claude", "hooks", `${name}.mts`)] as const),
  ]);
  for (const [target, source] of sources) {
    assert.equal(fs.readFileSync(path.join(hookDir, target), "utf8"), fs.readFileSync(source, "utf8"), target);
  }
  const installedDispatcher = path.join(hookDir, "codex-post-edit-checks.mts");
  const probe = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", installedDispatcher], {
    cwd: root,
    input: JSON.stringify({ tool_name: "functions.exec",
      tool_input: 'await tools.mcp__codebase_memory_mcp__search_graph({query:"hooks"});' }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(probe.status, 0, `${installedDispatcher}\n${probe.stderr}`);
  assert.equal(probe.stdout, "", "a fresh installed read-only dispatch stays silent");

  const current = fs.readFileSync(first.targets.config, "utf8");
  const dispatcherCommand = command(process.execPath, path.join(hookDir, "codex-post-edit-checks.mts"));
  const dispatcherGroup = hookGroup("PostToolUse", POST_EDIT_MATCHER, [{
    command: dispatcherCommand, commandWindows: `& ${dispatcherCommand}`,
  }]);
  assert.ok(current.includes(dispatcherGroup));
  assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), current);

  const predecessorHooks = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"]
    .map((name) => {
      const rendered = command(
        process.execPath,
        path.join(hookDir, "codex-hook-adapter.mts"),
        path.join(hookDir, `${name}.mts`),
        "post",
      );
      return { command: rendered, commandWindows: `& ${rendered}` };
    });
  const predecessorGroup = hookGroup("PostToolUse", POST_EDIT_MATCHER, predecessorHooks);
  const predecessor = beforePostEditDispatcher(current, hookDir);
  assert.notEqual(predecessor, current);
  const insideTrust = [
    "[hooks.state]",
    "[hooks.state.'config.toml:post_tool_use:0:0']",
    'trusted_hash = "sha256:old-0"',
    "[hooks.state.'config.toml:post_tool_use:0:3']",
    'trusted_hash = "sha256:old-3"',
  ].join("\n");
  const outside = [
    "[hooks.state.'operator.toml:post_tool_use:1:0']",
    'trusted_hash = "sha256:attribution"',
    "[[hooks.PostToolUse]]",
    'matcher = "custom"',
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    'command = "keep-custom"',
    "timeout = 19",
  ].join("\n");
  fs.writeFileSync(first.targets.config,
    `${outside}\n` + predecessor.replace(CONFIG_END, `${insideTrust}\n${CONFIG_END}`));
  const upgraded = install(installOptions);
  const upgradedConfig = fs.readFileSync(upgraded.targets.config, "utf8");
  assert.ok(upgradedConfig.includes(dispatcherGroup));
  assert.ok(upgradedConfig.includes(insideTrust));
  assert.ok(upgradedConfig.includes(outside));
  assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), upgradedConfig);

  const drifted = predecessor.replace(predecessorGroup, predecessorGroup.replace("timeout = 10", "timeout = 11"));
  fs.writeFileSync(first.targets.config, drifted);
  assert.throws(() => install(installOptions), /without an exact known managed fragment/);
});

// Issue #275. The integrity hook is installed byte-identical, wired once as the
// last entry of the Maestro SessionStart group, and every file it may restore
// maps to a versioned source with exactly the installed bytes.
test("installs the Codex hook-integrity hook last in its SessionStart group with a source for every hook file", async (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = fs.readFileSync(install(installOptions).targets.config, "utf8");
  const hookDir = path.join(codexHome, "hooks", "kherep-maestro");
  assert.equal(fs.readFileSync(path.join(hookDir, "codex-hook-integrity.mts"), "utf8"),
    fs.readFileSync(path.join(here, "hooks", "hook-integrity.mts"), "utf8"));
  const maestro = renderedHookGroup(config, "SessionStart");
  assert.equal(occurrences(config.replace(/^commandWindows = .*\n/gm, ""), "codex-hook-integrity.mts"), 1);
  assert.match(maestro.split("[[hooks.SessionStart.hooks]]").at(-1)!, /codex-hook-integrity\.mts[\s\S]*timeout = 30/);
  const { sourceOf } = await import("./hooks/hook-integrity-sources.mts");
  const installed = [
    "kherep-maestro-context.mts",
    ...fs.readdirSync(hookDir, { recursive: true, encoding: "utf8" })
      .filter((rel) => /\.(?:mts|js)$/.test(rel)).map((rel) => `kherep-maestro/${rel.replace(/\\/g, "/")}`),
  ];
  for (const rel of installed) {
    const source = sourceOf(rel);
    if ("hint" in source) {
      assert.match(rel, /codex-observation-(?:stop|turn-completion)\.mts$/, `${rel} has no versioned source`);
      continue;
    }
    assert.equal(fs.readFileSync(path.join(codexHome, "hooks", rel), "utf8"),
      fs.readFileSync(path.join(here, "..", source.from), "utf8"), `${rel} <- ${source.from}`);
  }
});

// Without the commandWindows lines, which repeat each command (issue #68), so a
// script name occurs once per hook.
function renderedHookGroup(config: string, event: string): string {
  return config.split(`[[hooks.${event}]]`)[1]!.split(/\n\[\[hooks\.[A-Za-z]+\]\]/)[0]!
    .replace(/^commandWindows = .*\n/gm, "");
}

// OP-1429. The Mac state before the retirement: a persisted Central Brain
// selection and the managed block an older installer rendered from it.
function macShapedCentralBrain(root: string, codexHome: string, config: string) {
  const selection = { provider: "central-brain", mcpCli: path.join(root, "brain", "mcp.mjs"),
    profile: path.join(root, "operator", "codex-profile.json"),
    nativeHooks: { contextCli: path.join(root, "brain", "native-context.js"),
      captureCli: path.join(root, "brain", "native-capture.mjs") } };
  const selectionFile = path.join(codexHome, "orchestra", "memory-provider.json");
  fs.writeFileSync(selectionFile, `${JSON.stringify(selection, null, 2)}\n`);
  const retired = retiredCentralBrainRender(
    { mcpCli: selection.mcpCli, profile: selection.profile, nativeHooks: selection.nativeHooks }, process.execPath);
  const predecessor = beforePostEditDispatcher(config, path.join(codexHome, "hooks", "kherep-maestro"));
  // The Central Brain table preceded every plugin table, the Atlassian one first.
  const block = withRetiredCentralBrain(predecessor, retired, process.execPath,
    [ATLASSIAN_MCP_SERVER, ...Object.keys(CAPABILITIES.pluginMcpServers || {})]);
  return { selection, selectionFile, block, retired };
}

test("a Mac-shaped Central Brain installation is retired on reinstall and kept in the backup", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const custom = '\n[[hooks.SessionStart]]\nmatcher = "custom"\n[[hooks.SessionStart.hooks]]\ncommand = "keep-hook"\n';
  const { selection, selectionFile, block } = macShapedCentralBrain(root, codexHome,
    fs.readFileSync(first.targets.config, "utf8"));
  const mac = `notify = ["personal-notify"]\n${block}${custom}`;
  fs.writeFileSync(first.targets.config, mac);
  assert.match(mac, /\[mcp_servers\.central-brain\]/);
  assert.equal(occurrences(mac, "native-context.js"), 2);
  assert.equal(occurrences(mac, "native-capture.mjs"), 2);

  const retired = install(installOptions);
  const config = fs.readFileSync(retired.targets.config, "utf8");
  assert.doesNotMatch(config, /central-brain|native-context|native-capture|hooks\.SessionEnd/);
  assert.ok(config.endsWith(custom));
  assert.match(config, /^notify = \["personal-notify"\]$/m);
  assert.equal(retired.receipt.memoryProvider, "unconfigured");
  assert.equal(Reflect.get(retired.receipt, "retiredMemoryProvider"), "central-brain");
  assert.deepEqual(JSON.parse(fs.readFileSync(selectionFile, "utf8")), { provider: "unconfigured" });
  assert.equal(fs.readFileSync(path.join(retired.backupRoot, "config.toml"), "utf8"), mac);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(retired.backupRoot, "orchestra", "memory-provider.json"), "utf8")),
    selection);
  assert.equal(fs.existsSync(selection.profile), false, "the referenced profile is never read or created");

  const repeated = install(installOptions);
  assert.equal(fs.readFileSync(repeated.targets.config, "utf8"), config);
  assert.equal(Reflect.get(repeated.receipt, "retiredMemoryProvider"), undefined);
});

// The Mac as measured: the block without the MCP table, the table further down
// the file and a Codex trust entry for the old checkout.
for (const extra of ["", '\nenv = { SYNTHETIC = "1" }']) {
  test(`a Central Brain MCP table outside the block is ${extra ? "retained" : "removed"} on reinstall`, (t) => {
    const { root, codexHome, installOptions } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = install(installOptions);
    const current = fs.readFileSync(first.targets.config, "utf8");
    const { block, retired } = macShapedCentralBrain(root, codexHome, current);
    const moved = withoutRetiredTable(block, retired);
    const trust = `\n[projects.${JSON.stringify(path.join(root, "Workspaces", "central-brain"))}]\ntrust_level = "trusted"\n`;
    const mac = `${moved.block}\n${moved.table}${extra}\n${trust}`;
    fs.writeFileSync(first.targets.config, mac);

    const result = install(installOptions);
    const config = fs.readFileSync(result.targets.config, "utf8");
    assert.equal(fs.readFileSync(path.join(result.backupRoot, "config.toml"), "utf8"), mac);
    assert.ok(config.includes(trust), "the operator trust entry stays");
    assert.doesNotMatch(config, /native-context|native-capture|hooks\.SessionEnd/);
    assert.equal(config.includes(`${moved.table}${extra}\n`), Boolean(extra));
    assert.deepEqual(result.receipt.retiredMcpServers.find((entry) => entry.name === "central-brain"),
      { name: "central-brain", status: extra ? "retained-for-review" : "removed" });
    if (!extra) assert.equal(config, current + trust, "only the table goes; its leading blank line stays");
  });
}

test("an explicit Central Brain selection is refused before anything is written", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryProvider = { provider: "central-brain", mcpCli: path.join(root, "mcp.mjs"),
    profile: path.join(root, "profile.json") };
  assert.throws(() => install({ ...installOptions, memoryProvider }), /Central Brain memory provider is retired/);
  assert.deepEqual(fs.readdirSync(codexHome), []);
  fs.mkdirSync(path.join(codexHome, "orchestra"));
  fs.writeFileSync(path.join(codexHome, "orchestra", "memory-provider.json"), '{"provider":"typo"}');
  assert.throws(() => install(installOptions), /Memory provider selection is invalid/);
});

test("parses an explicit memory selection config without reading a native profile", () => {
  assert.deepEqual(parseArgs(["--memory-provider-config", "/operator/selection.json"]), {
    memoryProviderConfig: "/operator/selection.json",
  });
});

test("parses only an explicit messaging client opt-in", () => {
  assert.deepEqual(parseArgs(["--enable-messaging-client"]), { messagingClient: true });
  assert.equal(parseArgs([]).messagingClient, undefined);
});


function mcpTable(config: string, name: string): string {
  const start = config.indexOf(`[mcp_servers.${name}]`);
  assert.notEqual(start, -1, `missing MCP table: ${name}`);
  const next = config.indexOf("\n[mcp_servers.", start + 1);
  return config.slice(start, next < 0 ? config.length : next);
}

function pluginTable(config: string, id: string): string {
  const start = config.indexOf(`[plugins.${JSON.stringify(id)}]`);
  assert.notEqual(start, -1, `missing plugin table: ${id}`);
  const next = config.slice(start + 1).search(/\r?\n\s*\[/);
  return config.slice(start, next < 0 ? config.length : start + 1 + next);
}
test("Windows entrypoint delegates to the shared Node installer", () => {
  const entrypoint = fs.readFileSync(path.join(here, "install.ps1"), "utf8");
  assert.match(entrypoint, /Join-Path \$PSScriptRoot "install\.mts"/);
  assert.match(entrypoint, /"--codex-home"/);
  assert.match(entrypoint, /"--claude-config-dir"/);
  assert.match(entrypoint, /"--mcp-registry"/);
  assert.match(entrypoint, /"--workspace"/);
  assert.match(entrypoint, /"--enable-messaging-client"/);
  assert.doesNotMatch(entrypoint, /Set-MarkedBlock/);
});
test("targets the v2 Atlassian MCP server and retires v1 rovo", () => {
  // Issue #376. The server is no plugin table any more and never comes from the
  // Claude registry: Codex reaches it as its own service account only.
  assert.equal(Object.hasOwn(CAPABILITIES.pluginMcpServers || {}, ATLASSIAN_MCP_SERVER), false);
  assert.equal(CAPABILITIES.mcpServers.includes(ATLASSIAN_MCP_SERVER), false);
  assert.deepEqual(CAPABILITIES.retiredMcpServers, ["rovo"]);
  assert.equal(CAPABILITIES.mcpServers.includes("rovo"), false);
  assert.equal(JSON.stringify(CAPABILITIES).includes("atlassian-rovo@openai-curated"), false);
});
test("uses canonical Kherep product identifiers", () => {
  assert.equal(AGENTS_START, "<!-- kherep:start -->");
  assert.equal(CONFIG_START, "# >>> Kherep Codex Maestro >>>");
  assert.equal(LOCAL_PLUGIN_ID, "kherep-maestro@kherep");
  const marketplace = JSON.parse(fs.readFileSync(
    path.join(here, "marketplace", ".agents", "plugins", "marketplace.json"),
    "utf8",
  ));
  assert.equal(marketplace.name, "kherep");
  assert.equal(marketplace.plugins[0].name, "kherep-maestro");
  assert.ok(fs.existsSync(path.join(
    here, "marketplace", "plugins", "kherep-maestro", "skills", "kherep-maestro-parity", "SKILL.md",
  )));
});
test("resolves the neutral default workspace and parses an explicit override", (t) => {
  const previousWorkspace = process.env.KHEREP_WORKSPACE;
  delete process.env.KHEREP_WORKSPACE;
  t.after(() => {
    if (previousWorkspace === undefined) delete process.env.KHEREP_WORKSPACE;
    else process.env.KHEREP_WORKSPACE = previousWorkspace;
  });
  const homeDir = path.join(os.tmpdir(), "kherep-home");
  fs.mkdirSync(path.join(homeDir, "retired-workspace-name"), { recursive: true });
  assert.equal(resolveWorkspace({ homeDir }, "darwin"), path.join(homeDir, "Kherep"));
  assert.deepEqual(parseArgs(["--workspace", path.join(homeDir, "custom")]), {
    workspace: path.join(homeDir, "custom"),
  });
});
test("workspace environment uses canonical values and rejects empty configuration", () => {
  const beforeCanonical = process.env.KHEREP_WORKSPACE;
  try {
    process.env.KHEREP_WORKSPACE = path.join(os.tmpdir(), "canonical-workspace");
    assert.equal(resolveWorkspace(), path.resolve(process.env.KHEREP_WORKSPACE));

    process.env.KHEREP_WORKSPACE = "";
    assert.throws(() => resolveWorkspace(), /KHEREP_WORKSPACE must not be empty/);
  } finally {
    if (beforeCanonical === undefined) delete process.env.KHEREP_WORKSPACE;
    else process.env.KHEREP_WORKSPACE = beforeCanonical;
  }
});
test("installs the Mac-compatible projection without replacing user state", async (t) => {
  const {
    root, codexCalls, codexHome, installOptions, workspace,
  } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentsTarget = path.join(codexHome, "AGENTS.md");
  const configTarget = path.join(codexHome, "config.toml");
  fs.writeFileSync(agentsTarget, "# Personal guidance\n", "utf8");
  fs.writeFileSync(
    configTarget,
    'model = "fixture"\n\n[features]\nhooks = false\n\n[mcp_servers.keep]\ncommand = "keep"\n\n[mcp_servers.context7]\ncommand = "personal-context7"\n\n[mcp_servers.atlassian]\ncommand = "legacy"\n',
    "utf8",
  );
  fs.mkdirSync(path.join(codexHome, "skills", "kickoff"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "skills", "kickoff", "SKILL.md"), "personal kickoff\n");
  fs.mkdirSync(path.join(codexHome, "agents"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "agents", "win-agent.toml"), 'name = "personal"\n');
  const result = install({ ...installOptions, platform: "darwin" });
  const agents = fs.readFileSync(agentsTarget, "utf8");
  const config = fs.readFileSync(configTarget, "utf8");
  assert.match(agents, /# Personal guidance/);
  assert.equal(occurrences(agents, AGENTS_START), 1);
  assert.equal(occurrences(agents, USER_START), 1);
  assert.match(agents, /If a required private processing path is unavailable, report the blocker without exposing the input/);
  assert.match(config, /^model_reasoning_effort = "xhigh"/m);
  assert.match(config, /^hooks = true$/m);
  assert.match(config, /\[mcp_servers\.keep\]/);
  assert.equal(occurrences(config, "[mcp_servers.context7]"), 1);
  assert.match(config, /command = "personal-context7"/);
  assert.doesNotMatch(config, /\[mcp_servers\.fixture_service\]/);
  assert.match(config, /\[mcp_servers\.forge-knowledge\]/);
  const codebaseMemory = mcpTable(config, "codebase-memory-mcp");
  assert.ok(codebaseMemory.includes(`command = ${JSON.stringify(path.join(root, "bin", "codebase-memory-mcp"))}`));
  assert.match(codebaseMemory, /args = \[\]/);
  assert.doesNotMatch(codebaseMemory, /KHEREP_MCP_/);
  assert.doesNotMatch(config, new RegExp(FIXTURE_AUTHORIZATION));
  const n8n = mcpTable(config, "n8n");
  assert.ok(n8n.includes(`args = [${JSON.stringify(result.targets.registryRuntime)}]`));
  assert.match(n8n, /NODE_EXTRA_CA_CERTS/);
  assert.doesNotMatch(n8n, /NODE_TLS_REJECT_UNAUTHORIZED/);
  // The operator's own atlassian table wins over the managed v2 render, as context7's does.
  assert.equal(occurrences(config, "[mcp_servers.atlassian]"), 1);
  assert.match(mcpTable(config, "atlassian"), /command = "legacy"/);
  assert.equal(config.includes("[mcp_servers.openaiDeveloperDocs]"), true);
  assert.equal(config.includes('command = "undefined"'), false);
  assert.match(mcpTable(config, "forge-knowledge"), /^required = false$/m);
  assert.doesNotMatch(config, /^required = true$/m);
  assert.ok(config.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(config.includes(`args = [${JSON.stringify(result.targets.registryBridge)}]`));
  assert.ok(config.includes(`KHEREP_MCP_REGISTRY_FILE = ${JSON.stringify(installOptions.claudeRegistryFile)}`));
  assert.equal(occurrences(config, CONFIG_START), 1);
  assert.equal(result.receipt.memoryProvider, "unconfigured");
  assert.deepEqual(result.receipt.reasoningEffort, { status: "configured", value: "xhigh" });
  assert.deepEqual(codexCalls.map(({ args }) => args), [["plugin", "marketplace", "list", "--json"], ["plugin", "marketplace", "add", "./marketplace", "--json"], ["plugin", "add", LOCAL_PLUGIN_ID]]);
  assert.ok(config.includes(process.execPath.replace(/\\/g, "\\\\")));
  assert.ok(config.includes("kherep-maestro-context.mts"));
  assert.equal(
    fs.readFileSync(result.targets.hook, "utf8"),
    fs.readFileSync(path.join(here, "hooks", "kherep-maestro-context.mts"), "utf8"),
  );
  const observationTarget = path.join(result.targets.hookDir, "codex-observation-turn-completion.mts");
  assert.equal(fs.readFileSync(observationTarget, "utf8"), renderedObservationHook(workspace));
  const stop = renderedHookGroup(config, "Stop");
  assert.equal(occurrences(stop, "codex-observation-stop.mts"), 0);
  assert.equal(occurrences(stop, "codex-acceptance-gate.mts"), 1);
  assert.equal(occurrences(stop, "codex-observation-turn-completion.mts"), 0);
  assert.equal(
    fs.readFileSync(result.targets.registryRuntime, "utf8"),
    fs.readFileSync(path.join(here, "..", "modules", "mcp-auth-bridge", "supergateway-secret-wrapper.mts"), "utf8"),
  );
  assert.ok(fs.existsSync(path.join(result.targets.localInference, "runner.mts")));
  assert.ok(fs.existsSync(path.join(result.targets.twg, "cli.mts")));
  const twgSkill = fs.readFileSync(path.join(codexHome, "skills", "kherep-twg", "SKILL.md"), "utf8");
  assert.doesNotMatch(twgSkill, /~\/\.claude\/kherep\/twg/);
  assert.deepEqual(result.receipt.twg, {
    status: "installed",
    componentSha256: componentHash(path.join(here, "..", "modules", "twg", "runtime")),
  });
  for (const name of [
    "atl-jira.mts",
    "atl-jira-ccoder.mts",
    "atlassian-credentials.mts",
    "atlassian-cli-args.mts",
    "jira-adf.mts",
    "jira-config.mts",
    "jira-fields.mts",
    "jira-links.mts",
    "jira-search.mts",
    "jira-discovery.mts",
    "jira-transition-guard.mts",
    // OP-1405. The Confluence broker travels with the Jira set: same flat
    // tools directory, same projection.
    "atl-confluence.mts",
    "atl-confluence-ccoder.mts",
    "confluence-contract.mts",
    "confluence-content.mts",
    "confluence-pagination.mts",
    "confluence-drainage-rules.mts",
    "confluence-drainage-snapshot.mts",
    "confluence-drainage-scan.mts",
    "confluence-drainage-cli.mts",
    "confluence-evidence.mts",
    "confluence-evidence-report.mts",
    "confluence-evidence-io.mts",
    "confluence-evidence-cli.mts",
    "confluence-claim-text.mts",
    "confluence-observation-validate.mts",
    "confluence-revision-staleness.mts",
    "confluence-revision-staleness-git.mts",

    "confluence-session.mts",
  ]) {
    const target = path.join(workspace, "tools", name);
    const source = path.join(here, "..", "modules", "atl-jira-brokers", name);
    assert.ok(fs.existsSync(target), `${name} must be installed into the workspace`);
    assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(source, "utf8"));
  }
  await import(pathToFileURL(path.join(workspace, "tools", "atl-jira.mts")).href);
  await import(pathToFileURL(path.join(workspace, "tools", "atl-jira-ccoder.mts")).href);
  // The import proves the flat layout: a relative import that only resolves in
  // the checkout would throw right here.
  await import(pathToFileURL(path.join(workspace, "tools", "atl-confluence.mts")).href);
  await import(pathToFileURL(path.join(workspace, "tools", "atl-confluence-ccoder.mts")).href);
  // OP-651: every capability the manifest declares as missing must reach the
  // receipt. degradedCapabilities used to be a hardcoded list, so a declared
  // gap could be absent from the very report meant to surface it.
  const declaredMissing = Object.entries(
    JSON.parse(fs.readFileSync(path.join(here, "parity", "capabilities.json"), "utf8")) as Record<string, unknown>,
  )
    .filter(([, entry]) => entry && typeof entry === "object" && ["missing", "unverified"].includes(String((entry as { status?: unknown }).status)))
    .map(([name]) => name);
  assert.ok(declaredMissing.length > 0, "fixture expects at least one declared-missing capability");
  for (const name of declaredMissing) {
    assert.ok(
      result.receipt.degradedCapabilities.includes(name),
      `capability "${name}" is declared missing but absent from the receipt`,
    );
  }
  assert.doesNotMatch(config, /codex-memory-(prompt|notify)/);
  assert.equal(fs.existsSync(path.join(result.targets.hookDir, "codex-memory-prompt.js")), false);
  assert.equal(fs.existsSync(path.join(result.targets.hookDir, "codex-memory-notify.js")), false);
  assert.ok(fs.existsSync(path.join(result.backupRoot, "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(result.backupRoot, "config.toml")));
  assert.equal(fs.readFileSync(path.join(result.backupRoot, "skills", "kickoff", "SKILL.md"), "utf8"), "personal kickoff\n");
  assert.equal(fs.readFileSync(path.join(result.backupRoot, "agents", "win-agent.toml"), "utf8"), 'name = "personal"\n');
  assert.equal(result.receipt.projection.commands.find((entry) => entry.name === "kickoff")?.status, "replaced-with-backup");
  assert.equal(result.receipt.projection.agents.find((entry) => entry.name === "win-agent")?.status, "replaced-with-backup");
  assert.equal(result.receipt.pluginMcpServers.find((entry) => entry.name === "context7")?.status, "preserved-existing");
  assert.equal(result.receipt.pluginMcpServers.find((entry) => entry.name === "atlassian")?.status, "preserved-existing");
  assert.equal(result.receipt.atlassianMcp.status, "preserved-existing");
  assert.deepEqual(
    result.receipt.retiredMcpServers.find((entry) => entry.name === "rovo"),
    { name: "rovo", status: "absent" },
  );
  assert.equal(result.receipt.pluginMcpServers.find((entry) => entry.name === "openaiDeveloperDocs")?.status, "configured");
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "codebase-memory-mcp"),
    { name: "codebase-memory-mcp", status: "configured", transport: "stdio" },
  );
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "forge-knowledge"),
    { name: "forge-knowledge", status: "configured", transport: "http" },
  );
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "n8n"),
    { name: "n8n", status: "configured", transport: "stdio" },
  );
  assert.doesNotMatch(JSON.stringify(result.receipt), new RegExp(FIXTURE_AUTHORIZATION));
  assert.equal(result.receipt.canonicalTargetPolicy.mode, "replace-with-backup");
});

// Issue #212. An upgrade used to replace the operator's value with "xhigh".
test("install keeps the operator's reasoning effort and reports it", async (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const operator = "model_reasoning_effort = \"low\"  # operator choice";
  fs.writeFileSync(configTarget, `model = "fixture"\n${operator}\n`, "utf8");
  const result = install({ ...installOptions, platform: "darwin" });
  const config = fs.readFileSync(configTarget, "utf8");
  assert.ok(config.includes(`\n${operator}\n`));
  assert.equal(occurrences(config, "model_reasoning_effort"), 1);
  assert.deepEqual(result.receipt.reasoningEffort, { status: "preserved-existing", value: "low" });
});
// Issue #304. An older installer rendered the v1 rovo table inside the managed
// block and no atlassian table. On the reported host the operator removed that
// rovo table in the Codex app, which also appended an app connector table. No
// rovo table is the wanted state, and the connector table is the operator's.
const OLD_ROVO_TABLE = '[mcp_servers.rovo]\nenabled = true\nrequired = false\nurl = "https://rovo.example.invalid/mcp"\n'
  + "startup_timeout_sec = 30.0\ntool_timeout_sec = 60.0\n\n";
for (const rovo of ["removed by the host", "still in the block"]) {
  test(`installs the v2 Atlassian server over an old block with rovo ${rovo}, beside a foreign app table`, (t) => {
    const { root, codexCalls, codexHome, installOptions } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configTarget = path.join(codexHome, "config.toml");
    install({ ...installOptions, installAtlassianTools: false });
    let old = fs.readFileSync(configTarget, "utf8");
    assert.equal(old.includes("[mcp_servers.atlassian]"), false);
    if (rovo === "still in the block") old = old.replace("[mcp_servers.context7]", `${OLD_ROVO_TABLE}[mcp_servers.context7]`);
    const foreign = "[apps.connector_0000]\nenabled = true\n";
    const seeded = `${old}\n${foreign}`;
    fs.writeFileSync(configTarget, seeded);
    const end = "# <<< Kherep Codex Maestro <<<";
    const outside = (text: string): string => text.slice(text.indexOf(end));

    const result = install(installOptions);
    const config = fs.readFileSync(configTarget, "utf8");
    assert.equal(occurrences(config, foreign), 1);
    assert.equal(outside(config), outside(seeded), "everything after the managed block, the app table included, is unchanged");
    assert.equal(config.includes("[mcp_servers.rovo]"), false);
    assertServiceAccountAtlassian(config, result.targets.registryRuntime, installOptions.atlassianMcpTokenFile);
    assert.ok(config.indexOf("[mcp_servers.atlassian]") < config.indexOf(end));
    assert.equal(result.receipt.pluginMcpServers.find((entry) => entry.name === "atlassian")?.status, "configured");
    assert.deepEqual(result.receipt.atlassianMcp,
      { status: "configured", authentication: "secret-file-bearer", tokenSource: "option" });
    assert.deepEqual(result.receipt.retiredMcpServers.find((entry) => entry.name === "rovo"),
      { name: "rovo", status: rovo === "still in the block" ? "removed" : "absent" });
    assert.equal(codexCalls.some(({ args }) => args.join(" ").includes("atlassian-rovo")), false);
    assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), config, "a reinstall is idempotent");

    // Dropping the optional tool set again removes only the managed v2 table.
    const without = fs.readFileSync(install({ ...installOptions, installAtlassianTools: false }).targets.config, "utf8");
    assert.equal(without.includes("[mcp_servers.atlassian]"), false);
    assert.equal(outside(without), outside(seeded));
  });
}

// Issue #376. The managed Atlassian table: the secret-file wrapper with the
// Codex service account's key file, and executeDestructive behind a prompt.
function assertServiceAccountAtlassian(config: string, runtime: string, tokenFile: string): void {
  const table = mcpTable(config, "atlassian");
  assert.ok(table.includes(`command = ${JSON.stringify(process.execPath)}`), table);
  assert.ok(table.includes(`args = [${JSON.stringify(runtime)}]`), table);
  assert.ok(table.includes(`env = { KHEREP_MCP_AUTH_FILE = ${JSON.stringify(tokenFile)}, `
    + 'KHEREP_MCP_ENDPOINT = "https://mcp.atlassian.com/v2/mcp" }'), table);
  assert.doesNotMatch(table, /^url = /m);
  assert.ok(config.includes('[mcp_servers.atlassian.tools.executeDestructive]\napproval_mode = "prompt"'));
}

// The block an install before issue #376 wrote: the native OAuth url table.
function withNativeAtlassianTable(config: string, tokenFile: string, runtime: string): string {
  const table = mcpTable(config, "atlassian");
  const native = '[mcp_servers.atlassian]\nenabled = true\nrequired = false\nurl = "https://mcp.atlassian.com/v2/mcp"\n'
    + "startup_timeout_sec = 30.0\ntool_timeout_sec = 60.0";
  const prompt = '\n\n[mcp_servers.atlassian.tools.executeDestructive]\napproval_mode = "prompt"';
  assert.ok(table.includes(JSON.stringify(tokenFile)) && table.includes(JSON.stringify(runtime)));
  const replaced = config.replace(`${table.trimEnd()}${prompt}`, native);
  assert.notEqual(replaced, config);
  return replaced;
}

test("replaces the native OAuth Atlassian table with the service-account table", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const current = fs.readFileSync(first.targets.config, "utf8");
  const operator = '\n[mcp_servers.keep]\ncommand = "keep"\n';
  const old = `${withNativeAtlassianTable(current, installOptions.atlassianMcpTokenFile, first.targets.registryRuntime)}${operator}`;
  assert.match(old, /^url = "https:\/\/mcp\.atlassian\.com\/v2\/mcp"$/m);
  fs.writeFileSync(path.join(codexHome, "config.toml"), old);

  const result = install(installOptions);
  const config = fs.readFileSync(result.targets.config, "utf8");
  assertServiceAccountAtlassian(config, result.targets.registryRuntime, installOptions.atlassianMcpTokenFile);
  assert.equal(occurrences(config, "[mcp_servers.atlassian]"), 1);
  assert.ok(config.endsWith(operator));
  assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), config, "a reinstall is idempotent");
});

test("without a usable key file no Atlassian table is written and nothing falls back to OAuth", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const old = withNativeAtlassianTable(fs.readFileSync(first.targets.config, "utf8"),
    installOptions.atlassianMcpTokenFile, first.targets.registryRuntime);
  fs.writeFileSync(path.join(codexHome, "config.toml"), old);

  const missing = path.join(root, "operator", "absent.txt");
  const result = install({ ...installOptions, atlassianMcpTokenFile: missing });
  const config = fs.readFileSync(result.targets.config, "utf8");
  assert.equal(config.includes("[mcp_servers.atlassian"), false, "neither the OAuth table nor a service-account table");
  assert.deepEqual(result.receipt.atlassianMcp,
    { status: "skipped-token-file-missing", authentication: "secret-file-bearer", tokenSource: "option" });
  assert.match(String(result.atlassianMcpProblem), /KHEREP_ATL_MCP_TOKEN_FILE_CODEX|absent\.txt/);
  assert.equal(result.receipt.pluginMcpServers.some((entry) => entry.name === "atlassian"), false);
  // The Jira broker of the tool set still installs.
  assert.ok(fs.existsSync(path.join(workspace, "tools", "atl-jira.mts")));

  if (process.platform !== "win32") {
    fs.chmodSync(installOptions.atlassianMcpTokenFile, 0o644);
    const loose = install(installOptions);
    assert.equal(loose.receipt.atlassianMcp.status, "skipped-token-file-invalid");
    assert.equal(fs.readFileSync(loose.targets.config, "utf8").includes("[mcp_servers.atlassian"), false);
    fs.chmodSync(installOptions.atlassianMcpTokenFile, 0o600);
  }
  const restored = install(installOptions);
  assertServiceAccountAtlassian(fs.readFileSync(restored.targets.config, "utf8"),
    restored.targets.registryRuntime, installOptions.atlassianMcpTokenFile);
});

test("a key file that moved between installs is still the installer's own table", (t) => {
  const { root, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(installOptions);
  const moved = path.join(root, "operator", "rotated", "atl-mcp-credential-codex.txt");
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.writeFileSync(moved, `${"b".repeat(48)}\n`, { mode: 0o600 });
  const result = install({ ...installOptions, atlassianMcpTokenFile: moved });
  const config = fs.readFileSync(result.targets.config, "utf8");
  assertServiceAccountAtlassian(config, result.targets.registryRuntime, moved);
  assert.equal(config.includes(JSON.stringify(installOptions.atlassianMcpTokenFile)), false);
});

// Issue #397. Runs fn with none of the variables that select the Atlassian tool
// set or its key file, as on a plain upgrade.
const ATLASSIAN_ENV = ["KHEREP_INSTALL_ATLASSIAN_TOOLS", "KHEREP_ATL_MCP_TOKEN_FILE_CODEX", "KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE",
  "KHEREP_ATL_CRED_FILE_CODEX", "KHEREP_ATL_CRED_FILE_CLAUDE"];
function withoutAtlassianEnv(fn: () => void): void {
  const before = Object.fromEntries(ATLASSIAN_ENV.map((key) => [key, process.env[key]]));
  try {
    for (const key of ATLASSIAN_ENV) delete process.env[key];
    fn();
  } finally {
    for (const key of ATLASSIAN_ENV) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test("an upgrade keeps the managed Atlassian table with the key file it names", (t) => {
  const { root, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { atlassianMcpTokenFile, installAtlassianTools: _switch, ...plain } = installOptions;
  withoutAtlassianEnv(() => {
    const first = install(installOptions);
    const configured = fs.readFileSync(first.targets.config, "utf8");
    fs.rmSync(path.join(workspace, "tools", "atl-jira.mts"));

    for (const options of [plain, { ...plain, installAtlassianTools: true }]) {
      const upgraded = install(options);
      const config = fs.readFileSync(upgraded.targets.config, "utf8");
      assert.equal(config, configured, "the table and its key file stay");
      assertServiceAccountAtlassian(config, upgraded.targets.registryRuntime, atlassianMcpTokenFile);
      assert.deepEqual(upgraded.receipt.atlassianMcp,
        { status: "configured", authentication: "secret-file-bearer", tokenSource: "installed" });
      assert.equal(upgraded.atlassianMcpProblem, undefined);
      assert.ok(fs.existsSync(path.join(workspace, "tools", "atl-jira.mts")), "the rest of the tool set is refreshed");
    }
    // Opting out is the one way to drop it, and the receipt says so.
    process.env.KHEREP_INSTALL_ATLASSIAN_TOOLS = "0";
    const removed = install(plain);
    assert.equal(fs.readFileSync(removed.targets.config, "utf8").includes("[mcp_servers.atlassian"), false);
    assert.deepEqual(removed.receipt.atlassianMcp, { status: "removed" });
    delete process.env.KHEREP_INSTALL_ATLASSIAN_TOOLS;
    assert.deepEqual(install(plain).receipt.atlassianMcp, { status: "not-requested" });
  });
});

test("an upgrade refuses to drop the managed Atlassian table when its key file is unusable", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { atlassianMcpTokenFile, installAtlassianTools: _switch, ...plain } = installOptions;
  withoutAtlassianEnv(() => {
    const configured = fs.readFileSync(install(installOptions).targets.config, "utf8");
    fs.rmSync(atlassianMcpTokenFile);
    const missing = path.join(root, "operator", "absent.txt");
    for (const options of [plain, { ...plain, installAtlassianTools: true }, { ...installOptions, atlassianMcpTokenFile: missing }]) {
      assert.throws(() => install(options), (error: Error) => {
        assert.match(error.message, /Refusing to remove the managed mcp_servers\.atlassian table/);
        assert.match(error.message, /KHEREP_ATL_MCP_TOKEN_FILE_CODEX/);
        assert.match(error.message, /KHEREP_INSTALL_ATLASSIAN_TOOLS=0/);
        assert.equal(error.message.includes("a".repeat(16)), false, "the message never holds a key");
        return true;
      });
      assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), configured, "nothing is written");
    }
  });
});

test("Codex reads only its own key file variable and refuses another identity's file", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { atlassianMcpTokenFile: _option, ...options } = installOptions;
  const keys = ["KHEREP_ATL_MCP_TOKEN_FILE_CODEX", "KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE",
    "KHEREP_ATL_CRED_FILE_CODEX", "KHEREP_ATL_CRED_FILE_CLAUDE"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE = installOptions.atlassianMcpTokenFile;
    const ignored = install(options);
    assert.equal(ignored.receipt.atlassianMcp.status, "skipped-token-file-missing");
    assert.equal(ignored.receipt.atlassianMcp.tokenSource, "default");
    assert.match(String(ignored.atlassianMcpProblem), new RegExp(
      path.join(codexHome, "kherep", "atl-mcp-credential-codex.txt").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    process.env.KHEREP_ATL_MCP_TOKEN_FILE_CODEX = installOptions.atlassianMcpTokenFile;
    const shared = install(options);
    assert.equal(shared.receipt.atlassianMcp.status, "skipped-token-file-shared");
    assert.equal(shared.receipt.atlassianMcp.tokenSource, "env");

    delete process.env.KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE;
    process.env.KHEREP_ATL_CRED_FILE_CODEX = installOptions.atlassianMcpTokenFile;
    assert.equal(install(options).receipt.atlassianMcp.status, "skipped-token-file-shared");

    delete process.env.KHEREP_ATL_CRED_FILE_CODEX;
    const configured = install(options);
    assert.equal(configured.receipt.atlassianMcp.status, "configured");
    assert.equal(configured.receipt.atlassianMcp.tokenSource, "env");
    const receipt = JSON.stringify(configured.receipt);
    assert.equal(receipt.includes(installOptions.atlassianMcpTokenFile), false, "the receipt names no key file");
    assert.equal(receipt.includes("a".repeat(48)), false, "the receipt never holds the key");
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});
test("default install projects observation delivery without optional Jira tooling", async (t) => {
  const { root, codexCalls, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { ...installOptions, installAtlassianTools: false };
  const jira = path.join(workspace, "tools", "atl-jira.mts");
  const retired = path.join(workspace, "tools", "atl-jira.mjs");
  fs.mkdirSync(path.dirname(jira), { recursive: true });
  fs.writeFileSync(jira, "operator-owned-current\n");
  const jiraBefore = fs.readFileSync(jira);
  fs.writeFileSync(retired, "operator-owned-retired\n");

  const result = install(options);
  const observationAgent = fs.readFileSync(
    path.join(codexHome, "agents", "codex-obs.toml"),
    "utf8",
  );
  assert.match(observationAgent, /^sandbox_mode = "read-only"$/m);
  // The installed dispatch guard enforces exactly the pin the projection wrote.
  const obsModel = observationAgent.match(/^model = "(.*)"$/m)?.[1] ?? "";
  const installedGuard = path.join(result.targets.hookDir, "codex-dispatch-contract-guard.mts");
  assert.deepEqual(fs.readFileSync(installedGuard), fs.readFileSync(path.join(here, "hooks", "dispatch-contract-guard.mts")));
  const installedCapabilities = JSON.parse(fs.readFileSync(
    path.join(result.targets.hookDir, "..", "parity", "capabilities.json"), "utf8")) as Capabilities;
  assert.deepEqual(installedCapabilities.modelResolution, result.receipt.modelResolution);
  assert.deepEqual(installedCapabilities.projectedAgents, result.receipt.projection.agentDefaults);
  assert.equal(installedCapabilities.agents["claude-obs"].model, obsModel);
  const guard = (extra: Record<string, unknown>): string => spawnSync(process.execPath, [installedGuard], {
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "spawn_agent", tool_input: { task_name: "obs", message: "m", agent_type: "codex-obs", ...extra } }),
  }).stdout;
  assert.ok(guard({}).includes(`pinned to model ${obsModel};`));
  // Issue #331. The installed guard loads the brief check from its lib sibling.
  assert.match(guard({ model: obsModel }), /Observation brief format: the brief marks no finding/);
  assert.equal(guard({ model: obsModel, message: "- measured: code kherep@2733b35e2c102ac54295568509c68b18b6d92cab -- t.mts `node t.mts` -> 1 pass\n- relayed: the operator" }), "");

  assert.deepEqual(fs.readFileSync(jira), jiraBefore);
  assert.equal(fs.readFileSync(retired, "utf8"), "operator-owned-retired\n");
  for (const name of [
    "atlassian-credentials.mts",
    "atlassian-cli-args.mts",
    "atl-confluence.mts",
    "confluence-contract.mts",
    "confluence-content.mts",
    "confluence-pagination.mts",
    "confluence-drainage-rules.mts",
    "confluence-drainage-snapshot.mts",
    "confluence-drainage-scan.mts",
    "confluence-drainage-cli.mts",
    "confluence-evidence.mts",
    "confluence-evidence-report.mts",
    "confluence-evidence-io.mts",
    "confluence-evidence-cli.mts",
    "confluence-claim-text.mts",
    "confluence-observation-validate.mts",
    "confluence-revision-staleness.mts",
    "confluence-revision-staleness-git.mts",

    "confluence-session.mts",
    "confluence-related.mts",
    "confluence-text-search.mts",
    "confluence-semantic.mts",
    "confluence-neighbours.mts",
    "confluence-neighbour-cli.mts",
    "confluence-topic-query.mts",
    "confluence-candidates.mts",
    "confluence-stitch.mts",
    "confluence-list-cli.mts",
    "confluence-runtime-label.mts",
    "confluence-label-cli.mts",
  ]) {
    const target = path.join(workspace, "tools", name);
    const source = path.join(here, "..", "modules", "atl-jira-brokers", name);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source), name);
  }
  assert.equal(fs.existsSync(path.join(workspace, "tools", "atl-jira-ccoder.mts")), false);
  assert.equal(fs.existsSync(path.join(workspace, "tools", "atl-confluence-ccoder.mts")), false);
  await import(pathToFileURL(path.join(workspace, "tools", "atl-confluence.mts")).href);
  const installedObservationHookPath = path.join(
    result.targets.hookDir,
    "codex-observation-turn-completion.mts",
  );
  const installedObservationHook = fs.readFileSync(installedObservationHookPath, "utf8");
  const hookRun = spawnSync(process.execPath, [installedObservationHookPath], {
    encoding: "utf8",
    input: JSON.stringify({ stop_hook_active: false }),
  });
  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.equal(withoutTypeStrippingWarning(hookRun.stderr), "");
  const hookDecision = JSON.parse(hookRun.stdout) as { reason: string };
  assert.match(hookDecision.reason, /mcp__kherep_observations__publish_observations/);
  assert.doesNotMatch(hookDecision.reason, /node '|atl-confluence/);
  assert.doesNotMatch(installedObservationHook, /__KHEREP_SELECTED_WORKSPACE__/);
  assert.doesNotMatch(installedObservationHook, /D:\/Workspaces/i);
  assert.ok(fs.existsSync(path.join(workspace, "tools", "atl-confluence.mts")));
  const instructionsLine = observationAgent.split("\n")
    .find((line) => line.startsWith("developer_instructions = "))!;
  const instructions = JSON.parse(instructionsLine.slice("developer_instructions = ".length)) as string;
  const publisherSection = instructions.split("## Codex publication mode\n")[1]!.split("\n## What an observation is")[0]!;
  assert.match(publisherSection, /mcp__kherep_observations__publish_observations/);
  assert.match(publisherSection, /NO further publication/);
  assert.match(publisherSection, /Maestro independently validates/);
  assert.match(observationAgent, /title.*bodyStorage.*evidence.*labels.*placement/s);
  assert.doesNotMatch(observationAgent, /trusted Maestro main thread is the Codex publisher/);
  assert.ok(fs.existsSync(path.join(workspace, "tools", "observation-stdio.mts")));
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /enabled_tools = \["publish_observations","related_candidates"\]/);
  assert.equal(result.receipt.pluginMcpServers.some((entry) => entry.name === ATLASSIAN_MCP_SERVER), false);
  assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8").includes("[mcp_servers.atlassian]"), false);
  assert.deepEqual(codexCalls.filter(({ args }) => args[1] === "add").map(({ args }) => args), [["plugin", "add", LOCAL_PLUGIN_ID]]);
});
test("normal reinstall preserves the previously validated operator adapter", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configured = installOptions.mcpCompatibility.operatorBindings.n8n;
  const { caFile: _caFile, ...binding } = configured;
  install({
    ...installOptions,
    mcpCompatibility: {
      operatorBindings: { n8n: { ...binding, tlsMode: "legacy-disabled" as const } },
    },
  });
  const before = mcpTable(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "n8n");
  assert.match(before, /NODE_TLS_REJECT_UNAUTHORIZED = "0"/);

  const { mcpCompatibility: _compatibility, ...normalInstall } = installOptions;
  const repeated = install(normalInstall);
  const after = mcpTable(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "n8n");

  assert.equal(after, before);
  assert.deepEqual(
    repeated.receipt.mcpServers.find((entry) => entry.name === "n8n"),
    { name: "n8n", status: "preserved-existing" },
  );
});
test("is idempotent and backs up the previously managed projection", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const staleSkill = path.join(codexHome, "skills", "stale-plugin-skill", "SKILL.md");
  fs.mkdirSync(path.dirname(staleSkill), { recursive: true });
  fs.writeFileSync(staleSkill, "stale managed skill\n");
  const priorReceipt = JSON.parse(fs.readFileSync(first.targets.receipt, "utf8"));
  priorReceipt.projection.skills.push({ name: "stale-plugin-skill", source: "fixture", status: "projected" });
  priorReceipt.projection.skills.push({ name: "../orchestra", source: "hostile", status: "projected" });
  fs.writeFileSync(first.targets.receipt, `${JSON.stringify(priorReceipt, null, 2)}\n`);
  const sentinel = path.join(codexHome, "orchestra", "sentinel.txt");
  fs.writeFileSync(sentinel, "keep unrelated state\n");
  const brokerTarget = path.join(workspace, "tools", "atl-jira.mts");
  fs.writeFileSync(brokerTarget, "local broker drift\n", "utf8");
  const second = install(installOptions);
  const agents = fs.readFileSync(second.targets.agents, "utf8");
  const config = fs.readFileSync(second.targets.config, "utf8");
  assert.equal(occurrences(agents, AGENTS_START), 1);
  assert.equal(occurrences(config, CONFIG_START), 1);
  for (const relative of [
    "AGENTS.md",
    "config.toml",
    path.join("hooks", "kherep-maestro-context.mts"),
    path.join("hooks", "kherep-maestro", "codex-observation-turn-completion.mts"),
    path.join("orchestra", "ROUTING.md"),
    path.join("orchestra", "registry-http-bridge.mts"),
    path.join("orchestra", "supergateway-secret-wrapper.mts"),
    path.join("kherep", "twg"),
  ]) {
    assert.ok(fs.existsSync(path.join(second.backupRoot, relative)));
  }
  assert.deepEqual(
    fs.readFileSync(path.join(second.backupRoot, "hooks", "kherep-maestro", "codex-observation-turn-completion.mts")),
    Buffer.from(renderedObservationHook(workspace)),
  );
  assert.equal(occurrences(renderedHookGroup(config, "Stop"), "codex-observation-turn-completion.mts"), 0);
  assert.equal(occurrences(renderedHookGroup(config, "Stop"), "codex-acceptance-gate.mts"), 1);
  assert.equal(fs.existsSync(staleSkill), false);
  assert.equal(
    fs.readFileSync(path.join(second.backupRoot, "skills", "stale-plugin-skill", "SKILL.md"), "utf8"),
    "stale managed skill\n",
  );
  assert.deepEqual(second.receipt.projection.removed?.skills, ["stale-plugin-skill"]);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep unrelated state\n");
  assert.equal(
    fs.readFileSync(path.join(second.backupRoot, "workspace", "tools", "atl-jira.mts"), "utf8"),
    "local broker drift\n",
  );
  assert.equal(
    fs.readFileSync(brokerTarget, "utf8"),
    fs.readFileSync(path.join(here, "..", "modules", "atl-jira-brokers", "atl-jira.mts"), "utf8"),
  );
});
test("uses repository-canonical plugin sources instead of host Claude versions", (t) => {
  const { root, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registryFile = path.join(installOptions.claudeConfigDir, "plugins", "installed_plugins.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify({
    plugins: { "cloudflare@claude-plugins-official": [{ version: "host-decoy", installPath: root }] },
  }));
  const result = install(installOptions);
  const plugin = result.receipt.projection.plugins
    .find((entry) => entry.id === "cloudflare@claude-plugins-official");
  assert.equal(plugin?.source, "repository-canonical");
  assert.notEqual(plugin?.version, "host-decoy");
});
test("rolls every managed target back when installation fails", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  fs.writeFileSync(configTarget, 'model = "keep"\n', "utf8");
  const brokerNames = [
    "atl-jira", "atl-jira-ccoder", "jira-adf", "jira-config", "jira-fields", "jira-links", "jira-transition-guard",
    "atlassian-credentials", "atlassian-cli-args", "atl-confluence", "confluence-contract", "confluence-content",
    "confluence-session",
    "confluence-related", "confluence-text-search", "confluence-semantic", "confluence-neighbours", "confluence-neighbour-cli", "confluence-topic-query", "confluence-candidates", "confluence-stitch", "confluence-list-cli", "confluence-runtime-label",
    "confluence-label-cli",
    "confluence-pagination",
    "confluence-drainage-rules",
    "confluence-drainage-snapshot",
    "confluence-drainage-scan",
    "confluence-drainage-cli",
    "confluence-evidence",
    "confluence-evidence-report",
    "confluence-evidence-io",
    "confluence-evidence-cli",
    "confluence-claim-text",
    "confluence-observation-validate",
    "confluence-revision-staleness",
    "confluence-revision-staleness-git",

  ];
  for (const name of brokerNames) {
    const target = path.join(workspace, "tools", `${name}.mts`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `prior ${name}\n`, "utf8");
  }
  const failAfterAgentsWrite = (count: number): void => {
    if (count === 6) throw new Error("fixture failure");
  };
  assert.throws(
    () => install({ ...installOptions, afterWrite: failAfterAgentsWrite }),
    /fixture failure/,
  );
  assert.equal(fs.readFileSync(configTarget, "utf8"), 'model = "keep"\n');
  assert.equal(fs.existsSync(path.join(codexHome, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "hooks", "kherep-maestro-context.mts")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "ROUTING.md")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "registry-http-bridge.mts")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "supergateway-secret-wrapper.mts")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "kherep", "twg")), false);
  for (const name of brokerNames) {
    assert.equal(
      fs.readFileSync(path.join(workspace, "tools", `${name}.mts`), "utf8"),
      `prior ${name}\n`,
    );
  }
});
test("rolls combined observation and messaging targets back with bytes modes and config", async (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { CLAUDE_CLIENT_GRAPH } = await import("../modules/control-plane/node/claude-mcp-client.mts");
  const { observationFiles } = await import("./lib/observation-projection.mts");
  const { OBSERVATION_SOURCES } = await import("./lib/observation-source.mts");
  const { isDeepStrictEqual } = await import("node:util");
  const repo = path.join(here, "..");
  const groups = [
    ...CLAUDE_CLIENT_GRAPH.map((relative) => ({
      source: path.join(repo, "modules", "control-plane", relative),
      target: path.join(codexHome, "orchestra", "control-plane", relative),
    })),
    ...observationFiles(repo).map((relative) => ({
      source: path.join(repo, "modules", "atl-jira-brokers", relative),
      target: path.join(workspace, "tools", relative),
    })),
    ...OBSERVATION_SOURCES.map((relative) => ({
      source: path.join(repo, relative),
      target: path.join(codexHome, "orchestra", "observation-source", relative),
    })),
  ];
  for (const [index, { target }] of groups.entries()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `prior combined target ${index}\n`, { mode: index % 2 ? 0o640 : 0o600 });
  }
  const configTarget = path.join(codexHome, "config.toml");
  const priorConfig = Buffer.from('model = "keep"\n');
  fs.writeFileSync(configTarget, priorConfig, { mode: 0o640 });
  const snapshot = (): Record<string, { mode: number; bytes: Buffer }> => {
    const files: Record<string, { mode: number; bytes: Buffer }> = {};
    const backupRoot = path.join(codexHome, "backups");
    const walk = (directory: string): void => {
      for (const name of fs.readdirSync(directory).sort()) {
        const target = path.join(directory, name);
        if (target === backupRoot) continue; // Installer recovery copies are retained separately.
        const info = fs.lstatSync(target);
        assert.equal(info.isSymbolicLink(), false);
        if (info.isDirectory()) walk(target);
        else {
          assert.equal(info.isFile(), true);
          files[path.relative(root, target)] = { mode: info.mode & 0o777, bytes: fs.readFileSync(target) };
        }
      }
    };
    walk(root);
    return files;
  };
  const before = snapshot();
  let copiedTogether = false;
  assert.throws(() => install({ ...installOptions, messagingClient: true, afterWrite() {
    if (!groups.every(({ source, target }) => fs.existsSync(target)
      && fs.readFileSync(target).equals(fs.readFileSync(source)))) return;
    const config = fs.readFileSync(configTarget);
    if (config.equals(priorConfig)) return;
    assert.match(config.toString(), /\[mcp_servers\.kherep_observations\]/);
    assert.match(config.toString(), /\[mcp_servers\.kherep_messaging\]/);
    copiedTogether = true;
    throw new Error("combined rollback fixture");
  } }), /combined rollback fixture/);
  assert.equal(copiedTogether, true);
  assert.ok(isDeepStrictEqual(snapshot(), before), "all target file bytes, modes and config must be restored");
});
test("rolls the observation hook back when reinstall fails after replacing it", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const target = path.join(first.targets.hookDir, "codex-observation-turn-completion.mts");
  const source = Buffer.from(renderedObservationHook(workspace));
  const prior = Buffer.from("prior managed observation hook\n");
  fs.writeFileSync(target, prior);

  assert.throws(() => install({ ...installOptions, afterWrite() {
    if (fs.existsSync(target) && fs.readFileSync(target).equals(source)) {
      throw new Error("synthetic observation rollback");
    }
  } }), /synthetic observation rollback/);
  assert.deepEqual(fs.readFileSync(target), prior);
});
test("rolls managed files back when Codex marketplace registration fails", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  fs.writeFileSync(configTarget, 'model = "keep"\n', "utf8");
  const runCodex = (args: string[]): string => {
    if (args[0] === "--version") return "codex-cli 0.144.6";
    throw new Error("marketplace fixture failure");
  };
  assert.throws(
    () => install({ ...installOptions, runCodex }),
    /marketplace fixture failure/,
  );
  assert.equal(fs.readFileSync(configTarget, "utf8"), 'model = "keep"\n');
  assert.equal(fs.existsSync(path.join(codexHome, "AGENTS.md")), false);
});
test("rolls managed files back when native plugin installation fails", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runCodex = (args: string[]): string => {
    if (args[0] === "--version") return "codex-cli 0.144.6";
    if (args.join(" ") === "plugin marketplace list --json") return '{"marketplaces":[]}';
    if (args[1] === "add") throw new Error("plugin fixture failure");
    return "ok";
  };
  assert.throws(
    () => install({ ...installOptions, runCodex }),
    /plugin fixture failure/,
  );
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
});
test("preserves an unmanaged Fixture service MCP table", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const existing = '[mcp_servers."fixture_service"] # existing\ncommand = "keep"\n';
  fs.writeFileSync(configTarget, existing, "utf8");
  const result = install(installOptions);
  const config = fs.readFileSync(configTarget, "utf8");
  assert.equal(occurrences(config, '[mcp_servers."fixture_service"]'), 1);
  assert.match(config, /command = "keep"/);
  assert.equal(result.receipt.mcpServers.find((entry) => entry.name === "fixture_service"), undefined);
});
test("repairs a mapped legacy HTTP table to a canonical native source", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = JSON.parse(fs.readFileSync(installOptions.claudeRegistryFile, "utf8"));
  registry.mcpServers["legacy-source"] = {
    type: "http", url: "https://oauth.example.invalid/mcp",
  };
  delete registry.mcpServers["kherep-linkedin-cli"];
  fs.writeFileSync(installOptions.claudeRegistryFile, JSON.stringify(registry), { mode: 0o600 });
  const configTarget = path.join(codexHome, "config.toml");
  const bridge = path.join(codexHome, "orchestra", "registry-http-bridge.mts");
  const legacy = [
    "[mcp_servers.legacy-source]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(bridge)}]`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
    "",
    "[mcp_servers.legacy-source.env]",
    'LEGACY_MCP_ALLOW_INSECURE_HTTP = "1"',
    `LEGACY_MCP_REGISTRY_FILE = ${JSON.stringify(installOptions.claudeRegistryFile)}`,
    'LEGACY_MCP_SERVER_NAME = "legacy-source"',
    "",
    "[mcp_servers.legacy-source.tools.search]",
    'approval_mode = "prompt"',
  ].join("\n");
  fs.writeFileSync(configTarget, `${legacy}\n`, "utf8");
  const options = {
    ...installOptions,
    mcpCompatibility: {
      ...installOptions.mcpCompatibility,
      sourceNames: { "kherep-linkedin-cli": "legacy-source" },
      legacyServerNames: { "kherep-linkedin-cli": ["legacy-source"] },
      legacyEnvPrefixes: ["LEGACY_"],
    },
  };

  const first = install(options);
  const config = fs.readFileSync(configTarget, "utf8");
  assert.doesNotMatch(config, /\[mcp_servers\.legacy-source\]/);
  assert.match(config, /\[mcp_servers\.kherep-linkedin-cli\][\s\S]*url = "https:\/\/oauth\.example\.invalid\/mcp"/);
  assert.equal(fs.readFileSync(path.join(first.backupRoot, "config.toml"), "utf8"), `${legacy}\n`);
  assert.deepEqual(
    first.receipt.mcpServers.find((entry) => entry.name === "kherep-linkedin-cli"),
    { name: "kherep-linkedin-cli", status: "repaired-preserved-existing" },
  );
  const { mcpCompatibility: _compatibility, ...normalInstall } = options;
  const second = install(normalInstall);
  assert.equal(fs.readFileSync(configTarget, "utf8"), config);
  assert.deepEqual(
    second.receipt.mcpServers.find((entry) => entry.name === "kherep-linkedin-cli"),
    { name: "kherep-linkedin-cli", status: "preserved-existing" },
  );
});

test("normal reinstall preserves a source-mapped static bearer bridge", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = JSON.parse(fs.readFileSync(installOptions.claudeRegistryFile, "utf8"));
  registry.mcpServers["legacy-static"] = registry.mcpServers["forge-knowledge"];
  delete registry.mcpServers["forge-knowledge"];
  fs.writeFileSync(installOptions.claudeRegistryFile, JSON.stringify(registry), { mode: 0o600 });
  const firstOptions = {
    ...installOptions,
    mcpCompatibility: {
      ...installOptions.mcpCompatibility,
      sourceNames: { "forge-knowledge": "legacy-static" },
    },
  };

  install(firstOptions);
  const before = mcpTable(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "forge-knowledge");
  const { mcpCompatibility: _compatibility, ...normalInstall } = firstOptions;
  const repeated = install(normalInstall);
  const after = mcpTable(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "forge-knowledge");

  assert.equal(after, before);
  assert.deepEqual(
    repeated.receipt.mcpServers.find((entry) => entry.name === "forge-knowledge"),
    { name: "forge-knowledge", status: "preserved-existing" },
  );
});

test("migrates the native env-subtable n8n wrapper and preserves it on normal reinstall", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(codexHome, "orchestra", "registry-http-bridge.mts");
  const configTarget = path.join(codexHome, "config.toml");
  const legacy = [
    "[mcp_servers.n8n]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(bridge)}]`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
    "",
    "[mcp_servers.n8n.env]",
    'LEGACY_MCP_ALLOW_INSECURE_HTTP = "1"',
    `LEGACY_MCP_REGISTRY_FILE = ${JSON.stringify(installOptions.claudeRegistryFile)}`,
    'LEGACY_MCP_SERVER_NAME = "n8n"',
    "",
  ].join("\n");
  fs.writeFileSync(configTarget, legacy, "utf8");
  const configured = installOptions.mcpCompatibility.operatorBindings.n8n;
  const { caFile: _caFile, ...binding } = configured;
  const firstOptions = {
    ...installOptions,
    mcpCompatibility: {
      legacyEnvPrefixes: ["LEGACY_"],
      operatorBindings: { n8n: { ...binding, tlsMode: "legacy-disabled" as const } },
    },
  };

  const first = install(firstOptions);
  const config = fs.readFileSync(configTarget, "utf8");
  const n8n = mcpTable(config, "n8n");
  assert.doesNotMatch(config, /LEGACY_MCP_|\[mcp_servers\.n8n\.env\]/);
  assert.doesNotMatch(n8n, /KHEREP_MCP_REGISTRY_FILE/);
  assert.ok(n8n.includes(`args = [${JSON.stringify(first.targets.registryRuntime)}]`));
  assert.match(n8n, /KHEREP_MCP_AUTH_FILE/);
  assert.match(n8n, /NODE_TLS_REJECT_UNAUTHORIZED = "0"/);
  assert.doesNotMatch(n8n, /^enabled\s*=/m);
  assert.doesNotMatch(n8n, /^required\s*=/m);

  const { mcpCompatibility: _compatibility, ...normalInstall } = firstOptions;
  const repeated = install(normalInstall);
  assert.equal(fs.readFileSync(configTarget, "utf8"), config);
  assert.deepEqual(
    repeated.receipt.mcpServers.find((entry) => entry.name === "n8n"),
    { name: "n8n", status: "preserved-existing" },
  );
});

test("canonicalizes an owned disabled bearer wrapper without reactivating it", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const disabled = renderRegistryMcpServer("forge-knowledge", "forge-knowledge", "LEGACY_", {
    mcpServers: [], node: process.execPath,
    registry: installOptions.claudeRegistryFile,
    registryBridge: path.join(codexHome, "orchestra", "registry-http-bridge.mts"),
  }).replace("enabled = true", "enabled = false");
  fs.writeFileSync(configTarget, `${disabled}\n\n[mcp_servers.forge-knowledge.tools.list]\napproval_mode = "prompt"\n`, "utf8");

  const result = install({
    ...installOptions,
    mcpCompatibility: {
      ...installOptions.mcpCompatibility,
      legacyEnvPrefixes: ["LEGACY_"],
    },
  });
  const config = fs.readFileSync(configTarget, "utf8");
  assert.equal((config.match(/\[mcp_servers\.forge-knowledge\]/g) || []).length, 1);
  assert.match(config, /\[mcp_servers\.forge-knowledge\]\nenabled = false/);
  assert.match(config, /KHEREP_MCP_SERVER_NAME = "forge-knowledge"/);
  assert.doesNotMatch(config, /LEGACY_MCP_/);
  assert.match(config, /\[mcp_servers\.forge-knowledge\.tools\.list\]\napproval_mode = "prompt"/);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "forge-knowledge"),
    { name: "forge-knowledge", status: "repaired-preserved-existing" },
  );
});
test("preserves an unbound known adapter and reports the required repair", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(codexHome, "orchestra", "registry-http-bridge.mts");
  const registry = JSON.parse(fs.readFileSync(installOptions.claudeRegistryFile, "utf8"));
  registry.mcpServers.n8n = {
    command: process.execPath,
    args: [bridge],
    env: {
      LEGACY_MCP_REGISTRY_FILE: installOptions.claudeRegistryFile,
      LEGACY_MCP_SERVER_NAME: "n8n",
      LEGACY_MCP_ALLOW_INSECURE_HTTP: "1",
    },
  };
  fs.writeFileSync(installOptions.claudeRegistryFile, JSON.stringify(registry), { mode: 0o600 });
  const existing = renderRegistryMcpServer("n8n", "n8n", "LEGACY_", {
    mcpServers: [], node: process.execPath,
    registry: installOptions.claudeRegistryFile,
    registryBridge: bridge,
  }).replace("enabled = true", "enabled = false");
  fs.writeFileSync(path.join(codexHome, "config.toml"), `${existing}\n`, "utf8");

  const result = install({
    ...installOptions,
    mcpCompatibility: { legacyEnvPrefixes: ["LEGACY_"] },
  });
  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");

  assert.match(config, /\[mcp_servers\.n8n\]\nenabled = false/);
  assert.match(config, /KHEREP_MCP_SERVER_NAME = "n8n"/);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "n8n"),
    {
      name: "n8n",
      status: "configured-source-repair-required",
      sourceTransport: "stdio",
      reason: "legacy-registry-adapter",
      localConfigStatus: "repaired-preserved-existing",
    },
  );
  assert.equal(
    result.receipt.mcpServers.find((entry) => entry.name === "forge-knowledge")?.status,
    "configured",
  );
});
test("migrates an exact legacy Codebase Memory wrapper to direct stdio", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const legacy = renderRegistryMcpServer(
    "codebase-memory-mcp", "codebase-memory-mcp", "KHEREP_", {
      mcpServers: [],
      node: process.execPath,
      registry: installOptions.claudeRegistryFile,
      registryBridge: path.join(codexHome, "orchestra", "registry-http-bridge.mts"),
    },
  );
  fs.writeFileSync(configTarget, `${legacy}\n`, "utf8");

  const result = install(installOptions);
  const config = fs.readFileSync(configTarget, "utf8");
  const codebaseMemory = mcpTable(config, "codebase-memory-mcp");

  assert.equal(occurrences(config, "[mcp_servers.codebase-memory-mcp]"), 1);
  assert.match(codebaseMemory, /args = \[\]/);
  assert.doesNotMatch(codebaseMemory, /KHEREP_MCP_|registry-http-bridge\.js/);
  assert.equal(fs.readFileSync(path.join(result.backupRoot, "config.toml"), "utf8"), `${legacy}\n`);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "codebase-memory-mcp"),
    { name: "codebase-memory-mcp", status: "repaired-preserved-existing" },
  );
});
test("migrates the exact pre-TypeScript registry wrapper before retiring its JavaScript bridge", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const legacy = renderRegistryMcpServer(
    "codebase-memory-mcp", "codebase-memory-mcp", "KHEREP_", {
      mcpServers: [],
      node: process.execPath,
      registry: installOptions.claudeRegistryFile,
      registryBridge: path.join(codexHome, "orchestra", "registry-http-bridge.js"),
    },
  );
  fs.writeFileSync(configTarget, `${legacy}\n`, "utf8");

  const result = install(installOptions);
  const config = fs.readFileSync(configTarget, "utf8");
  const codebaseMemory = mcpTable(config, "codebase-memory-mcp");

  assert.equal(occurrences(config, "[mcp_servers.codebase-memory-mcp]"), 1);
  assert.match(codebaseMemory, /args = \[\]/);
  assert.doesNotMatch(codebaseMemory, /registry-http-bridge\.js/);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "registry-http-bridge.js")), false);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "codebase-memory-mcp"),
    { name: "codebase-memory-mcp", status: "repaired-preserved-existing" },
  );
});
test("preserves a customized unmanaged Codebase Memory table", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configTarget = path.join(codexHome, "config.toml");
  const existing = [
    '[mcp_servers."codebase-memory-mcp"] # personal',
    'command = "custom-cbm"',
    'args = ["keep"]',
    "",
  ].join("\n");
  fs.writeFileSync(configTarget, existing, "utf8");

  const result = install(installOptions);
  const config = fs.readFileSync(configTarget, "utf8");

  assert.equal(occurrences(config, '[mcp_servers."codebase-memory-mcp"]'), 1);
  assert.match(config, /command = "custom-cbm"/);
  assert.match(config, /args = \["keep"\]/);
  assert.deepEqual(
    result.receipt.mcpServers.find((entry) => entry.name === "codebase-memory-mcp"),
    { name: "codebase-memory-mcp", status: "preserved-existing" },
  );
});
test("rejects incomplete managed blocks", () => {
  assert.throws(
    () => setMarkedBlock(`${AGENTS_START}\npartial`, AGENTS_START, AGENTS_END, "body"),
    /incomplete managed block/,
  );
  assert.throws(
    () => setMarkedBlock(`${AGENTS_END}\n${AGENTS_START}`, AGENTS_START, AGENTS_END, "body"),
    /ambiguous managed block/,
  );
  assert.throws(
    () => setMarkedBlock(`${AGENTS_START}\na\n${AGENTS_START}\nb\n${AGENTS_END}`, AGENTS_START, AGENTS_END, "body"),
    /ambiguous managed block/,
  );
});

// OP-1122 and OP-1123 renamed projection files from .js to .mts. A stale copy
// under the old name must not survive an install; the backup keeps it. The
// workspace brokers OP-1124 renamed from .mjs are retired through retired.txt
// instead, see the #44 tests below.
test("removes projection files that the TypeScript migration renamed", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = [
    path.join(codexHome, "hooks", "kherep-maestro", "codex-cbm-reminder.js"),
    path.join(codexHome, "hooks", "kherep-maestro", "codex-observation-turn-completion.js"),
    path.join(codexHome, "orchestra", "registry-http-bridge.js"),
    path.join(codexHome, "kherep", "local-inference", "runner.js"),
  ];
  for (const file of stale) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "stale\n", "utf8");
  }
  const result = install(installOptions);
  for (const file of stale) {
    assert.equal(fs.existsSync(file), false, file);
    assert.ok(fs.existsSync(path.join(result.backupRoot, path.relative(codexHome, file))), file);
  }
});

// #44. The Codex installer retires workspace files through the same declaration
// and the same gate as install.sh: bootstrap/manifest/retired.txt, project/
// entries only, parked into a _deprecated/ sibling with a backup, never deleted.
// No version the installer placed is available to a test, so the real manifest
// is copied with one fixture digest appended to the real atl-jira.mjs entry; all
// other entries and hashes stay as shipped.
const RETIRED_MANIFEST = path.join(here, "..", "bootstrap", "manifest", "retired.txt");
const lfSha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

function retiredManifestWith(root: string, entry: string, digest: string): string {
  const real = fs.readFileSync(RETIRED_MANIFEST, "utf8");
  const line = real.split(/\r?\n/).find((candidate) => candidate.startsWith(`${entry} sha256:`));
  assert.ok(line, `${entry} is declared with hashes in retired.txt`);
  const manifest = path.join(root, "retired.txt");
  fs.writeFileSync(manifest, real.replace(line, `${line},${digest}`));
  return manifest;
}

test("retires a declared workspace file into _deprecated without the Jira tooling", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = path.join(workspace, "tools");
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "atl-jira.mjs"), "placed broker\r\n");
  fs.writeFileSync(path.join(tools, "jira-adf.mjs"), "operator edit\n");
  fs.writeFileSync(path.join(tools, "jira-config.mjs"), "no longer declared\n");
  const claudeHook = path.join(installOptions.claudeConfigDir, "hooks", "em-dash-watch.js");
  const codexHook = path.join(codexHome, "hooks", "em-dash-watch.js");
  for (const file of [claudeHook, codexHook]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "claude-home entry\n");
  }
  const lines: string[] = [];
  const result = install({
    ...installOptions, installAtlassianTools: false, log: (line) => lines.push(line),
    retiredManifest: retiredManifestWith(root, "project/tools/atl-jira.mjs", lfSha256("placed broker\n")),
  });

  const parked = path.join(tools, "_deprecated", "atl-jira.mjs");
  assert.equal(fs.existsSync(path.join(tools, "atl-jira.mjs")), false);
  assert.equal(fs.readFileSync(parked, "utf8"), "placed broker\r\n");
  assert.equal(fs.readFileSync(path.join(result.backupRoot, "workspace", "tools", "atl-jira.mjs"), "utf8"), "placed broker\r\n");
  assert.ok(lines.includes(`retire: project/tools/atl-jira.mjs -> ${parked}`));
  assert.deepEqual(lines.filter((line) => line.startsWith("retire: KEEP")),
    ["retire: KEEP project/tools/jira-adf.mjs (content not placed by the installer)"]);
  assert.equal(fs.readFileSync(path.join(tools, "jira-adf.mjs"), "utf8"), "operator edit\n");
  assert.equal(fs.existsSync(path.join(result.backupRoot, "workspace", "tools", "jira-adf.mjs")), false);
  assert.equal(fs.readFileSync(path.join(tools, "jira-config.mjs"), "utf8"), "no longer declared\n");
  assert.ok(lines.includes(`retire: SKIP project/tools/jira-links.mjs (nothing at ${path.join(tools, "jira-links.mjs")})`));
  for (const file of [claudeHook, codexHook]) assert.equal(fs.readFileSync(file, "utf8"), "claude-home entry\n");
  assert.equal(lines.some((line) => line.includes("hooks/em-dash-watch.js")), false);
});

test("refuses a workspace entry without hashes before anything moves", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const known = path.join(workspace, "tools", "atl-jira.mjs");
  fs.mkdirSync(path.dirname(known), { recursive: true });
  fs.writeFileSync(known, "placed broker\n");
  const manifest = path.join(root, "retired.txt");
  fs.writeFileSync(manifest, `project/tools/atl-jira.mjs sha256:${lfSha256("placed broker\n")}\nproject/tools/unhashed.mjs\n`);
  assert.throws(() => install({ ...installOptions, retiredManifest: manifest }),
    /retirement manifest entry project\/tools\/unhashed\.mjs needs 'sha256:/);
  assert.equal(fs.readFileSync(known, "utf8"), "placed broker\n");
  assert.equal(fs.existsSync(path.join(workspace, "tools", "_deprecated")), false);
  assert.deepEqual(fs.readdirSync(codexHome), []);
});

test("rollback puts a parked workspace file back at its path", (t) => {
  const { root, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(workspace, "tools", "atl-jira.mjs");
  const parked = path.join(workspace, "tools", "_deprecated", "atl-jira.mjs");
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, "placed broker\n");
  assert.throws(() => install({
    ...installOptions,
    retiredManifest: retiredManifestWith(root, "project/tools/atl-jira.mjs", lfSha256("placed broker\n")),
    afterWrite: () => { if (fs.existsSync(parked)) throw new Error("fixture failure after park"); },
  }), /fixture failure after park/);
  assert.equal(fs.readFileSync(live, "utf8"), "placed broker\n");
  // As in install.sh, the parked copy stays: removing it would be a delete.
  assert.equal(fs.readFileSync(parked, "utf8"), "placed broker\n");
});

test("Mac install keeps observation hooks unconfigured and acceptance active", (t) => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = install({ ...installOptions, platform: "darwin" });
  const target = path.join(codexHome, "hooks", "kherep-maestro", "codex-observation-stop.mts");
  assert.ok(fs.existsSync(target));
  assert.equal(fs.readFileSync(target, "utf8"),
    renderObservationHook(fs.readFileSync(path.join(here, "hooks", "observation-stop.mts"), "utf8"), workspace));
  const executed = spawnSync(process.execPath, [target], {
    input: JSON.stringify({ turn_id: "synthetic", stop_hook_active: false, cwd: "/synthetic" }),
    encoding: "utf8", env: { ...process.env, KHEREP_WORKSPACE: "/synthetic" },
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).decision, "block");
  const acceptanceTarget = path.join(codexHome, "hooks", "kherep-maestro", "codex-acceptance-gate.mts");
  const gate = spawnSync(process.execPath, [acceptanceTarget], {
    input: JSON.stringify({ last_assistant_message: "Work done.", cwd: "/synthetic" }),
    encoding: "utf8", env: { ...process.env, KHEREP_WORKSPACE: "/synthetic" },
  });
  assert.equal(gate.status, 0, gate.stderr);
  assert.equal(JSON.parse(gate.stdout).continue, false);
  const config = fs.readFileSync(result.targets.config, "utf8");
  assert.doesNotMatch(config, /codex-observation-(?:stop|turn-completion)\.mts/);
  assert.match(config, /codex-acceptance-gate\.mts/);
  assert.equal(fs.readFileSync(install({ ...installOptions, platform: "darwin" }).targets.config, "utf8"), config);
});

// Issue #31, step 4: the control-plane delivery hook runs with --runtime codex
// for SessionStart, UserPromptSubmit and Stop; since issue #503 through the
// stable entry point, which runs this checkout's hook.
test("wires the control-plane delivery hook from the checkout and upgrades a block without it", (t) => {
  const { root, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hookPath = path.resolve(here, "..", "modules", "control-plane", "node", "deliver-hook.mts");
  assert.ok(fs.existsSync(hookPath));
  const group = (value: string) => {
    const deliver = { command: value, commandWindows: `& ${value}` };
    return [hookGroup("SessionStart", "startup|resume|clear|compact", [deliver]),
      hookGroup("UserPromptSubmit", "", [deliver]), hookGroup("Stop", "", [deliver])].join("\n\n");
  };
  const entry = path.join(installOptions.codexHome, "hooks", "kherep-maestro", "codex-control-plane-hook.mts");
  const groups = group(command(process.execPath, hookPath, "--runtime", "codex"));
  const result = install(installOptions);
  const config = fs.readFileSync(result.targets.config, "utf8");
  assert.equal(occurrences(config, group(command(process.execPath, "--disable-warning=ExperimentalWarning", entry, "deliver", "--runtime", "codex"))), 1);
  assert.equal(occurrences(config, String.raw`codex-control-plane-hook.mts\" \"deliver\"`), 8);
  assert.equal(occurrences(config, "deliver-hook.mts"), 0);
  // Issue #325. The attribution hook beside it: a PreToolUse entry and a PostToolUse group.
  assert.equal(occurrences(config, String.raw`codex-control-plane-hook.mts\" \"attribution\"`), 4);
  // The existing hooks are untouched: without the three groups, the attribution
  // hook that only comes with them, and the commandWindows forms (issue #68) the
  // block is the one the previous installer wrote, and a reinstall recognises and
  // upgrades it.
  const hookDir = path.join(installOptions.codexHome, "hooks", "kherep-maestro");
  const previous = beforeShellDispatcher(config, hookDir).replace(`\n\n${groups}`, "").replace(/^commandWindows = .*\n/gm, "")
    .replace(/\n\n\[\[hooks\.PostToolUse\]\]\nmatcher = "\.\*"\n\n\[\[hooks\.PostToolUse\.hooks\]\]\ntype = "command"\ncommand = .*deliver-hook\.mts.*\ntimeout = 10(?=\n)/, "")
    .replace(/^\[sandbox_workspace_write\]\nwritable_roots = .*\n\n/m, "")
    .replace(/\n\n\[\[hooks\.PostToolUse\]\]\nmatcher = "Bash[^\n]*\n\n\[\[hooks\.PostToolUse\.hooks\]\]\ntype = "command"\ncommand = .*attribution-hook\.mts.*\ntimeout = 10(?=\n)/, "")
    .replace(/\n\n\[\[hooks\.PreToolUse\.hooks\]\]\ntype = "command"\ncommand = .*attribution-hook\.mts.*\ntimeout = 10(?=\n)/, "");
  assert.equal(occurrences(previous, "attribution-hook.mts"), 0);
  assert.notEqual(previous, config);
  fs.writeFileSync(result.targets.config, previous);
  assert.equal(fs.readFileSync(install(installOptions).targets.config, "utf8"), config);
});

test("installs the disabled-by-default messaging client with its public dependency graph", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const normal = install(installOptions);
  const normalConfig = fs.readFileSync(normal.targets.config, "utf8");
  assert.doesNotMatch(normalConfig, /kherep_messaging|mcp-intent-hook|mcp-stdio-bridge/);
  assert.equal(fs.existsSync(path.join(codexHome, "orchestra", "control-plane")), false);

  const enabled = install({ ...installOptions, messagingClient: true });
  const config = fs.readFileSync(enabled.targets.config, "utf8");
  const clientRoot = path.join(codexHome, "orchestra", "control-plane");
  const matcher = "^mcp__kherep_messaging__(sessions|send|inbox|reply|status|assign_self)$";
  assert.match(config, new RegExp(`matcher = ${JSON.stringify(matcher).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(config, /\[mcp_servers\.kherep_messaging\]/);
  assert.match(config, new RegExp(JSON.stringify(path.join(clientRoot, "node", "mcp-stdio-bridge.mts"))
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const clientTable = mcpTable(config, "kherep_messaging");
  const clientHook = config.split(`matcher = ${JSON.stringify(matcher)}`)[1]!.split("[[hooks.")[0]!;
  assert.doesNotMatch(`${clientTable}\n${clientHook}`, /Authorization|Bearer|token|approval_mode/i);
  // Issue #538: the intent entry runs through the adapter in pre-intent; the direct form is gone.
  const { adapted: adaptedIntent, direct: directIntent } = intentCommands(codexHome, installOptions.controlPlaneOutbox);
  assert.equal(occurrences(config, `command = ${JSON.stringify(adaptedIntent)}\n`
    + `commandWindows = ${JSON.stringify(`& ${adaptedIntent}`)}\ntimeout = 15\n`), 1);
  assert.equal(occurrences(config, `command = ${JSON.stringify(directIntent)}`), 0);
  for (const relative of [
    "protocol.mts", "protocol-mcp.mts", "protocol-messages.mts", "protocol-session-identity.mts", "protocol-message-binding.mts", "protocol-task-control.mts", "protocol-tasks.mts",
    "node/config.mts", "node/inbox.mts", "node/inbox-storage.mts", "node/inbox-selected-read.mts", "node/inbox-record-lock.mts", "node/mcp-local.mts", "node/mcp-credential-file.mts",
    "node/session-publication.mts", "node/guarded-replies.mts", "node/message-owner.mts",
    "node/policy.mts", "node/session-policy.mts",
    "node/mcp-intent-hook.mts", "node/mcp-stdio-bridge.mts",
  ]) assert.ok(fs.statSync(path.join(clientRoot, relative)).isFile(), relative);
  for (const relative of ["node/inbox-storage.mts", "node/inbox-selected-read.mts"]) {
    assert.deepEqual(fs.readFileSync(path.join(clientRoot, relative)),
      fs.readFileSync(path.join(here, "../modules/control-plane", relative)), relative);
  }
  assert.deepEqual(fs.readFileSync(path.join(clientRoot, "protocol-session-identity.mts")),
    fs.readFileSync(path.join(here, "../modules/control-plane/protocol-session-identity.mts")));
  const configRoot = path.dirname(path.dirname(installOptions.controlPlaneOutbox));
  fs.mkdirSync(path.join(configRoot, "control-plane"), { recursive: true });
  fs.writeFileSync(path.join(configRoot, "control-plane", "policy.json"),
    JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true } }));
  const hook = spawnSync(process.execPath, [path.join(clientRoot, "node", "mcp-intent-hook.mts"),
    "--config-root", configRoot], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__kherep_messaging__sessions",
      tool_input: {} }), encoding: "utf8",
    env: { ...process.env, KHEREP_CONFIG_DIR: path.join(root, "wrong ambient root") },
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecisionReason, "remote_mcp_missing_native_identity");
  assert.equal(fs.readFileSync(install({ ...installOptions, messagingClient: true }).targets.config, "utf8"), config);
  const disabledAgain = install(installOptions);
  assert.doesNotMatch(fs.readFileSync(disabledAgain.targets.config, "utf8"), /kherep_messaging|mcp-intent-hook/);
  assert.deepEqual(disabledAgain.receipt.messagingClient, { status: "disabled" });
});

// Issue #72. The outbox is a writable root of the workspace-write sandbox, in
// exactly one sandbox_workspace_write table: the managed block's, or the
// operator's when there is one.
test("makes the Control Plane outbox a sandbox writable root without ever writing a second table", (t) => {
  const { root, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outbox = installOptions.controlPlaneOutbox;
  const table = `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(outbox)}]`;
  const headers = (text: string): number => text.match(/^\s*\[\s*sandbox_workspace_write\s*\]/gm)?.length ?? 0;
  const read = (file: string): string => fs.readFileSync(file, "utf8");

  const first = install(installOptions);
  const managed = read(first.targets.config);
  const block = managed.slice(managed.indexOf(CONFIG_START));
  assert.ok(block.includes(`# Managed Kherep Codex Maestro parity projection.\n\n${table}\n\n[[hooks.`));
  assert.equal(headers(managed), 1);
  assert.doesNotMatch(managed, /control-plane[\\/]+"|policy\.json|node-ed25519/, "only the outbox, never the node directory");
  // A Kherep permission profile showed up in the Codex app's approval menu and
  // was reverted on 2026-09-27; the intercom works without one.
  assert.doesNotMatch(managed, /^\s*\[\s*permissions[.\]]|^\s*default_permissions\s*=/m, "never a permission profile");
  assert.deepEqual(first.receipt.controlPlaneOutbox, { status: "managed" });
  assert.equal(read(install(installOptions).targets.config), managed, "a reinstall is idempotent");

  // A block from an install with another config directory is still recognised.
  const moved = managed.replace(JSON.stringify(outbox), JSON.stringify(path.join(root, "old", "outbox")));
  fs.writeFileSync(first.targets.config, moved);
  assert.equal(read(install(installOptions).targets.config), managed);

  // The operator adds a table of their own (Codex now refuses the file): the
  // block drops its table and the outbox joins the operator's list.
  const operator = `[sandbox_workspace_write]\nwritable_roots = ["/operator/cache"]\nnetwork_access = false\n\n`;
  const firstTable = managed.search(/^\[/m);
  fs.writeFileSync(first.targets.config, managed.slice(0, firstTable) + operator + managed.slice(firstTable));
  const merged = install(installOptions);
  const config = read(merged.targets.config);
  assert.equal(headers(config), 1);
  assert.ok(config.includes(`\n[sandbox_workspace_write]\nwritable_roots = ["/operator/cache", ${JSON.stringify(outbox)}]\n`
    + "network_access = false\n\n"));
  assert.ok(!config.includes(table));
  assert.deepEqual(merged.receipt.controlPlaneOutbox, { status: "operator-merged" });
  const again = install(installOptions);
  assert.equal(read(again.targets.config), config);
  assert.deepEqual(again.receipt.controlPlaneOutbox, { status: "operator-present" });

  // Operator config the installer cannot merge into stays byte-identical.
  const inline = `sandbox_workspace_write = { network_access = true }\n${managed.replace(`${table}\n\n`, "")}`;
  fs.writeFileSync(first.targets.config, inline);
  const skipped = install(installOptions);
  assert.equal(read(skipped.targets.config), inline);
  assert.equal(headers(inline), 0);
  assert.deepEqual(skipped.receipt.controlPlaneOutbox, { status: "skipped-inline-table" });
});

// Issue #507, part 4. The dispatch-contract guard runs through the adapter; its deny
// reasons and its brief notice keep their top-level systemMessage (issue #505).
test("T3b the wired dispatch-contract command keeps the guard's deny, notice and systemMessage", (t) => {
  const { root, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = install(installOptions);
  const config = fs.readFileSync(result.targets.config, "utf8");
  const group = config.split("[[hooks.PreToolUse]]").find((block) => block.startsWith('\nmatcher = "Agent|spawn_agent"\n'))!;
  const wired = JSON.parse(/^command = (".*")$/m.exec(group)![1]!) as string;
  assert.match(wired, /codex-hook-adapter\.mts" ".*codex-dispatch-contract-guard\.mts" "pre"$/);
  // A proven integrity run first, so no re-check notice joins the guard's output.
  spawnSync(process.execPath, [path.join(result.targets.hookDir, "codex-hook-integrity.mts"), "--trigger", "fixture"],
    { input: "{}", encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_HOME: undefined } });
  const obsModel = fs.readFileSync(path.join(installOptions.codexHome, "agents", "codex-obs.toml"), "utf8").match(/^model = "(.*)"$/m)?.[1] ?? "";
  const run = (extra: Record<string, unknown>) => {
    const out = spawnSync(wired, { shell: true, encoding: "utf8", windowsHide: true, input: JSON.stringify({ hook_event_name: "PreToolUse",
      tool_name: "spawn_agent", tool_input: { task_name: "obs", message: "m", agent_type: "codex-obs", ...extra } }) });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout ? JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, string>; systemMessage?: string } : undefined;
  };
  const denied = run({})!;
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(denied.hookSpecificOutput.permissionDecisionReason!.includes(`pinned to model ${obsModel};`));
  assert.equal(denied.systemMessage, denied.hookSpecificOutput.permissionDecisionReason);
  const format = run({ model: obsModel })!;
  assert.match(String(format.hookSpecificOutput.permissionDecisionReason), /^Observation brief format: the brief marks no finding/);
  assert.equal(format.systemMessage, format.hookSpecificOutput.permissionDecisionReason);
  const notice = run({ model: obsModel, message: "- measured: code `npm test` -> 42 pass" })!;
  assert.equal(notice.hookSpecificOutput.permissionDecision, undefined, JSON.stringify(notice));
  assert.match(String(notice.hookSpecificOutput.additionalContext), /^Observation brief revision: finding 1 \(measured:\) is code-bound/);
  assert.equal(notice.systemMessage, notice.hookSpecificOutput.additionalContext);
  assert.equal(run({ model: obsModel, message: "- measured: code kherep@2733b35e2c102ac54295568509c68b18b6d92cab -- t.mts `node t.mts` -> 1 pass\n- relayed: the operator" }), undefined);
});

// Issue #507, part 4 (lead decision 8): the trust review leaves the three changed
// guards unrun until the operator trusts them, so the installer says so.
test("T13 replacing the managed block prints one trust-review line naming the three guards", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const LINE = "config.toml: the managed hook block was replaced; Codex skips a changed hook definition until it is reviewed and trusted in /hooks"
    + " (this upgrade changes the atlassian-destructive-guard, codex-dispatch-contract-guard, playwright-file-guard, SessionStart context and UserPromptSubmit context entries, which do not run until then)";
  const logged = (): { lines: string[]; result: ReturnType<typeof install> } => {
    const lines: string[] = [];
    return { lines, result: install({ ...installOptions, log: (line: string) => { lines.push(line); } }) };
  };
  const fresh = logged();
  assert.ok(!fresh.lines.some((line) => line.startsWith("config.toml: the managed hook block")), fresh.lines.join("\n"));
  const config = fs.readFileSync(fresh.result.targets.config, "utf8");
  fs.writeFileSync(fresh.result.targets.config, beforeAdaptedDirectGuards(config, path.join(codexHome, "hooks", "kherep-maestro")));
  const upgrade = logged();
  assert.deepEqual(upgrade.lines.filter((line) => line.startsWith("config.toml:")), [LINE]);
  assert.equal(fs.readFileSync(upgrade.result.targets.config, "utf8"), config);
  const again = logged();
  assert.ok(!again.lines.some((line) => line.startsWith("config.toml:")), again.lines.join("\n"));
});

// Issue #538: an upgrade from a c44f3e4 messaging block changes only the intent entry, and the
// trust-review line names it and none of the part 4 guards.
test("T14 replacing a c44f3e4 messaging block prints one trust-review line naming the messaging intent entry", (t) => {
  const { root, codexHome, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const LINE = "config.toml: the managed hook block was replaced; Codex skips a changed hook definition until it is reviewed and trusted in /hooks"
    + " (this upgrade changes the SessionStart context, UserPromptSubmit context and messaging intent entries, which do not run until then)";
  const logged = (): { lines: string[]; result: ReturnType<typeof install> } => {
    const lines: string[] = [];
    return { lines, result: install({ ...installOptions, messagingClient: true, log: (line: string) => { lines.push(line); } }) };
  };
  const fresh = logged();
  const config = fs.readFileSync(fresh.result.targets.config, "utf8");
  fs.writeFileSync(fresh.result.targets.config, beforeAdaptedIntentHook(config, codexHome, installOptions.controlPlaneOutbox));
  const upgrade = logged();
  assert.deepEqual(upgrade.lines.filter((line) => line.startsWith("config.toml:")), [LINE]);
  assert.equal(fs.readFileSync(upgrade.result.targets.config, "utf8"), config);
  const again = logged();
  assert.ok(!again.lines.some((line) => line.startsWith("config.toml:")), again.lines.join("\n"));
});

test("explicit selected workspace binds both context hooks and an unbound upgrade names their trust review", t => {
  const { root, codexHome, installOptions, workspace } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = install(installOptions);
  const config = fs.readFileSync(first.targets.config, "utf8");
  const token = Buffer.from(workspace).toString("base64url");
  assert.equal((config.match(/--workspace-b64/g) || []).length, 4);
  assert.ok(config.includes(token));
  const stateFile = path.join(codexHome, 'hooks.state.json');
  fs.writeFileSync(stateFile, '{"synthetic":"preserve"}');
  fs.writeFileSync(first.targets.config, withoutContextWorkspace(config));
  const lines: string[] = [];
  install({ ...installOptions, log: line => lines.push(line) });
  assert.equal(fs.readFileSync(first.targets.config, "utf8"), config);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{"synthetic":"preserve"}');
  assert.ok(lines.some(line => /SessionStart context and UserPromptSubmit context entries/.test(line)));
});


test("GitHub broker projection stages both actual entrypoints without activation and restores prior bytes", async (t) => {
  const { root, workspace, installOptions } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(installOptions);
  const directory = path.join(workspace, "tools", "github-broker");
  const before = fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]);
  for (const runtime of ["claude", "codex"]) {
    const staged = await import(pathToFileURL(path.join(directory, `github-${runtime}.mts`)).href);
    assert.equal(typeof staged.run, "function");
  }
  const entrypoint = path.join(directory, "github-claude.mts");
  fs.writeFileSync(entrypoint, "prior synthetic entrypoint");
  const prior = fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]);
  assert.throws(() => install({ ...installOptions, afterWrite: () => {
    if (fs.readFileSync(entrypoint, "utf8") !== "prior synthetic entrypoint") throw new Error("synthetic rollback");
  } }), /synthetic rollback/);
  assert.deepEqual(fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]), prior);
  install(installOptions);
  assert.deepEqual(fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]), before);
});
