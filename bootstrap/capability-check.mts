#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { productEnv } from "../lib/product-env.mts";
import { RETIRED_CODEX_PLUGIN } from "./codex-plugin-retirement.mts";
import { activeMcpEntries, allMcpEntries, hasCredentialArg, type SupplementalConfig } from "./capability-mcp.mts";
import { errorMessage, field } from "./shape.mts";

interface ProfileBaseline {
  plugins?: string[];
  mcpServers?: string[];
  optionalManagedMcpServers?: string[];
  agents?: string[];
  skills?: string[];
  commands?: string[];
}

// bootstrap/manifest/capabilities.json. Repo-owned and versioned, so its shape
// is asserted at the read instead of validated on every run.
interface CapabilityManifest {
  plugins: string[];
  mcpServers: string[];
  ownedAgents: Record<string, string>;
  skills: string[];
  commands: string[];
  requiredHooks: string[];
  pluginEntrypoints: Record<string, string[]>;
  runtimeFiles: string[];
  profileBaselines?: Record<string, ProfileBaseline>;
}

interface EnabledPlugins {
  enabledPlugins?: Record<string, boolean>;
}

interface InstalledPlugins {
  plugins?: Record<string, unknown>;
}

const here = import.meta.dirname;
const repo = path.resolve(here, "..");
const expected = readJson<CapabilityManifest>(path.join(here, "manifest", "capabilities.json"));
const liveMode = process.argv.includes("--live");
const strictMode = process.argv.includes("--strict") || process.env.CAPABILITY_STRICT === "1";
const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1]
  : (productEnv(process.env, "PROFILE") ?? (process.platform === "darwin" ? "mac" : "win"));
let failures = 0;
let warnings = 0;

// The caller asserts the shape; the parse itself never echoes file content, so
// a broken JSON next to a secret cannot leak it into the report.
export function readJson<T = unknown>(file: string): T {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { throw new Error(`Cannot read JSON file ${path.basename(file)}`); }
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`Invalid JSON file ${path.basename(file)}`); }
}
function readOptionalJson(file: string): unknown {
  return fs.existsSync(file) ? readJson(file) : null;
}
function ok(label: string, condition: boolean, detail = ""): void {
  if (condition) console.log(`PASS | ${label}${detail ? ` | ${detail}` : ""}`);
  else { console.log(`FAIL | ${label}${detail ? ` | ${detail}` : ""}`); failures++; }
}
function warn(label: string, detail: string): void { console.log(`WARN | ${label} | ${detail}`); warnings++; }
function info(label: string, detail: string): void { console.log(`INFO | ${label} | ${detail}`); }
function strictWarning(label: string, detail: string): void {
  if (strictMode) { console.log(`FAIL | ${label} | ${detail}`); failures++; }
  else warn(label, detail);
}
function sorted(value: Iterable<string>): string[] { return [...value].sort((left, right) => Number(left > right) - Number(left < right)); }
function same(a: Iterable<string>, b: Iterable<string>): boolean { return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b)); }
function enabledKeys(value: EnabledPlugins): string[] {
  return Object.entries(value.enabledPlugins || {}).filter(([, on]) => on).map(([key]) => key);
}
function frontmatterName(file: string): string {
  try { return (fs.readFileSync(file, "utf8").match(/^name:\s*(\S.*)$/m) || [])[1] || ""; }
  catch { return ""; }
}
function directFiles(dir: string, suffix = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (!suffix || entry.name.endsWith(suffix)))
    .map((entry) => entry.name);
}
function directSkills(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
}
function reportExtras(label: string, actual: Iterable<string>, managed: Iterable<string>, preserved: Iterable<string> = [], requirePreserved = false): void {
  const actualSet = new Set(actual);
  const managedSet = new Set(managed);
  const preservedSet = new Set(preserved);
  for (const name of sorted(actualSet)) {
    if (managedSet.has(name)) continue;
    if (preservedSet.has(name)) info(`preserved ${profile} ${label}`, name);
    else strictWarning(`unexpected ${label}`, name);
  }
  if (requirePreserved) {
    for (const name of preservedSet) {
      if (!actualSet.has(name)) strictWarning(`missing ${profile} baseline ${label}`, name);
    }
  }
}

function checkSource(): void {
  const plugins = readJson<EnabledPlugins>(path.join(here, "manifest", "plugins.json"));
  const manifestKeys = enabledKeys(plugins);
  ok("plugin contract equals install manifest", same(expected.plugins, manifestKeys), `expected=${expected.plugins.length} actual=${manifestKeys.length}`);

  for (const [name, file] of Object.entries(expected.ownedAgents)) {
    const target = path.join(repo, "claude", "agents", file);
    ok(`owned agent ${name}`, fs.existsSync(target) && frontmatterName(target) === name, file);
  }
  for (const name of expected.skills) {
    const target = path.join(repo, "claude", "skills", name, "SKILL.md");
    ok(`skill ${name}`, fs.existsSync(target) && frontmatterName(target) === name);
  }
  for (const file of expected.commands) ok(`command ${file}`, fs.existsSync(path.join(repo, "claude", "commands", file)));
  for (const file of expected.requiredHooks) ok(`hook ${file}`, fs.existsSync(path.join(repo, "claude", "hooks", file)));
  ok("local runner source", fs.existsSync(path.join(repo, "modules", "local-inference", "runner.mts")));
  ok("secret-safe MCP wrapper source", fs.existsSync(path.join(repo, "modules", "mcp-auth-bridge", "supergateway-secret-wrapper.mts")));

  reportExtras("source agent", directFiles(path.join(repo, "claude", "agents"), ".md"), Object.values(expected.ownedAgents));
  reportExtras("source skill", directSkills(path.join(repo, "claude", "skills")), expected.skills);
  reportExtras("source command", directFiles(path.join(repo, "claude", "commands"), ".md"), expected.commands);
}

function checkLive(): void {
  const claudeHome = process.env.CLAUDE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude");
  const userHome = productEnv(process.env, "USER_HOME") || path.dirname(claudeHome);
  const defaultWorkspace = path.join(userHome, "Kherep");
  const workspace = productEnv(process.env, "WORKSPACE") ?? defaultWorkspace;
  const baseline: ProfileBaseline = (expected.profileBaselines && expected.profileBaselines[profile]) || {};
  const settings = readJson<EnabledPlugins>(path.join(claudeHome, "settings.json"));
  const workspaceSettings = readOptionalJson(path.join(workspace, ".claude", "settings.local.json")) as EnabledPlugins | null;
  const registry = readJson<InstalledPlugins>(path.join(claudeHome, "plugins", "installed_plugins.json"));
  const enabled = enabledKeys(settings);
  const installed = Object.keys(registry.plugins || {});
  for (const key of expected.plugins) {
    ok(`live plugin enabled ${key}`, enabled.includes(key));
    ok(`live plugin installed ${key}`, installed.includes(key));
  }
  reportExtras("enabled plugin", enabled, expected.plugins, baseline.plugins, true);
  const retiredInstalled = installed.includes(RETIRED_CODEX_PLUGIN);
  ok(`retired plugin disabled ${RETIRED_CODEX_PLUGIN}`,
    !enabled.includes(RETIRED_CODEX_PLUGIN) && workspaceSettings?.enabledPlugins?.[RETIRED_CODEX_PLUGIN] !== true
      && (!retiredInstalled || settings.enabledPlugins?.[RETIRED_CODEX_PLUGIN] === false));
  // The retained exact retired registry entry is a recovery artifact, not an
  // unexpected active capability. Its disabled state is asserted above.
  reportExtras("installed plugin", installed, [...expected.plugins, RETIRED_CODEX_PLUGIN], baseline.plugins, true);

  for (const [plugin, files] of Object.entries(expected.pluginEntrypoints)) {
    const entries = registry.plugins && registry.plugins[plugin];
    const versions: unknown[] = Array.isArray(entries) ? [...entries] : [];
    const current = versions.sort((a, b) => String(field(b, "lastUpdated") || "").localeCompare(String(field(a, "lastUpdated") || "")))[0];
    const installPath = field(current, "installPath");
    for (const rel of files) ok(`plugin entrypoint ${plugin}:${rel}`, Boolean(installPath) && fs.existsSync(path.join(String(installPath), rel)));
  }

  const config = readJson(path.join(userHome, ".claude.json"));
  const supplementalMcpConfigs: SupplementalConfig[] = [
    { source: "claude-home", value: readOptionalJson(path.join(claudeHome, ".mcp.json")) },
    { source: "workspace", value: readOptionalJson(path.join(workspace, ".mcp.json")) },
  ];
  const mcpEntries = activeMcpEntries(config, workspace, supplementalMcpConfigs);
  const mcpNames = new Set(mcpEntries.keys());
  for (const name of expected.mcpServers) {
    if ((baseline.optionalManagedMcpServers || []).includes(name) && !mcpNames.has(name)) {
      warn(`optional ${profile} managed MCP absent`, name);
    } else ok(`configured MCP ${name}`, mcpNames.has(name));
  }
  reportExtras("configured MCP", [...mcpNames], expected.mcpServers, baseline.mcpServers, true);
  const unsafeMcpArgs = allMcpEntries(config, supplementalMcpConfigs)
    .filter(({ value }) => hasCredentialArg(value))
    .map(({ name }) => name);
  const unsafeMcpNames = [...new Set(unsafeMcpArgs)].sort((left, right) => Number(left > right) - Number(left < right));
  ok("configured MCP command args are well-formed and secret-safe", unsafeMcpNames.length === 0, unsafeMcpNames.join(","));

  for (const [name, file] of Object.entries(expected.ownedAgents)) {
    const target = path.join(claudeHome, "agents", file);
    ok(`live owned agent ${name}`, fs.existsSync(target) && frontmatterName(target) === name);
  }
  for (const name of expected.skills) ok(`live skill ${name}`, fs.existsSync(path.join(claudeHome, "skills", name, "SKILL.md")));
  for (const file of expected.commands) ok(`live command ${file}`, fs.existsSync(path.join(claudeHome, "commands", file)));
  for (const file of expected.runtimeFiles) ok(`live runtime ${file}`, fs.existsSync(path.join(claudeHome, file)));
  for (const file of expected.requiredHooks) ok(`live hook ${file}`, fs.existsSync(path.join(claudeHome, "hooks", file)));

  reportExtras("agent", directFiles(path.join(claudeHome, "agents"), ".md"), Object.values(expected.ownedAgents), baseline.agents, true);
  reportExtras("skill", directSkills(path.join(claudeHome, "skills")), expected.skills, baseline.skills, true);
  reportExtras("command", directFiles(path.join(claudeHome, "commands"), ".md"), expected.commands, baseline.commands, true);
}

function main(): number {
  try {
    if (!["win", "mac"].includes(profile)) throw new Error("profile must be win or mac");
    checkSource();
    if (liveMode) checkLive();
  } catch (error) {
    console.error(`FAIL | capability checker crashed | ${errorMessage(error)}`);
    failures++;
  }
  console.log(`\nCAPABILITY CHECK: ${failures ? "FAIL" : "PASS"} (${failures} failures, ${warnings} warnings, mode=${liveMode ? "source+live" : "source"}, profile=${profile}, strict=${strictMode})`);
  return failures === 0 ? 0 : 1;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main();
