#!/usr/bin/env node
/**
 * SessionStart hook: inject a secret-safe snapshot of installed/enabled
 * plugins and configured MCP server names. This prevents version/tool-state
 * claims from being reconstructed from memory at the start of a fresh session.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isKherepScope, workspaceForPayload, type ScopePayload } from "./lib/workspace-scope.mts";
import { findTrustedExecutable } from "./lib/trusted-executable.mts";

// The parts of the live JSON files this hook reads. Everything else, the
// secret-bearing MCP server definitions above all, stays untyped and unread.
interface PluginInstall {
  version?: unknown;
  lastUpdated?: unknown;
  installedAt?: unknown;
}
interface Settings {
  enabledPlugins?: Record<string, unknown>;
}
interface Registry {
  plugins?: Record<string, unknown>;
}
interface LocalInferenceConfig {
  backends?: Record<string, { engine?: unknown; endpoint?: unknown; model?: unknown }>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function collectMcpNames(value: unknown, names: Set<string>, seen: Set<object> = new Set()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (record.mcpServers && typeof record.mcpServers === "object") {
    Object.keys(record.mcpServers).forEach((name) => names.add(name));
  }
  for (const child of Object.values(record)) collectMcpNames(child, names, seen);
}

function newestInstall(entries: unknown): PluginInstall | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return [...(entries as PluginInstall[])].sort((a, b) =>
    String(b.lastUpdated || b.installedAt || "").localeCompare(
      String(a.lastUpdated || a.installedAt || "")
    )
  )[0];
}

function gitValue(cwd: string, args: string[]): string {
  try {
    const command = findTrustedExecutable("git", { cwd });
    if (!command) return "UNKNOWN";
    const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 2_000, windowsHide: true });
    return result.status === 0 ? String(result.stdout || "").trim() : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function main(): void {
  let payload: ScopePayload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}") as ScopePayload;
  } catch {
    return;
  }
  if (!isKherepScope(payload)) return;

  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const claudeHome = process.env.CLAUDE_HOME || path.join(userHome, ".claude");
  const settings = (readJson(path.join(claudeHome, "settings.json")) || {}) as Settings;
  const registry = (readJson(path.join(claudeHome, "plugins", "installed_plugins.json")) || {}) as Registry;
  const localConfig = readJson(path.join(claudeHome, "kherep", "local-inference", "config.json")) as LocalInferenceConfig | null;
  const cwd = (payload.cwd || workspaceForPayload(payload) || process.cwd()) as string;

  const enabled = Object.entries(settings.enabledPlugins || {})
    .filter(([, on]) => on === true)
    .map(([name]) => name)
    .sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
  const installedMap = registry.plugins || {};
  const installed = Object.keys(installedMap).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  const enabledInstalled = enabled
    .filter((name) => installedMap[name])
    .map((name) => {
      const item = newestInstall(installedMap[name]);
      return `${name}@${(item && item.version) || "unknown"}`;
    });
  const enabledMissing = enabled.filter((name) => !installedMap[name]);
  const installedDisabled = installed.filter((name) => !enabled.includes(name));

  const mcpNames = new Set<string>();
  [
    path.join(userHome, ".claude.json"),
    path.join(claudeHome, ".mcp.json"),
    path.join(cwd, ".mcp.json"),
  ].forEach((file) => collectMcpNames(readJson(file), mcpNames));

  const lines = [
    `LIVE CAPABILITY SNAPSHOT (${new Date().toISOString()}):`,
    `Workspace: cwd=${cwd}; branch=${gitValue(cwd, ["branch", "--show-current"])}; HEAD=${gitValue(cwd, ["rev-parse", "HEAD"])}`,
    `Enabled+installed plugins (${enabledInstalled.length}): ${enabledInstalled.join(", ") || "none detected"}`,
    `Enabled but missing (${enabledMissing.length}): ${enabledMissing.join(", ") || "none"}`,
    `Installed but disabled (${installedDisabled.length}): ${installedDisabled.join(", ") || "none"}`,
    `Configured MCP names (${mcpNames.size}; configuration is NOT a health claim): ${[...mcpNames].sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }).join(", ") || "none detected"}`,
    `Local inference contract: ${localConfig && localConfig.backends ? Object.entries(localConfig.backends).map(([name, spec]) => `${name}=${spec.engine}@${spec.endpoint}${spec.model ? `#${spec.model}` : ""}`).join(", ") : "UNKNOWN (config not installed)"}`,
    "Use this snapshot as startup evidence only. Re-probe the live registry/tool before a load-bearing availability or version claim.",
  ];

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
  }));
}

try {
  main();
} catch {
  // Fail-open: capability reporting must never prevent session startup.
}
process.exit(0);
