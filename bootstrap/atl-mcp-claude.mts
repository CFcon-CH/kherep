#!/usr/bin/env node
// Issue #376. Registers the Atlassian MCP server v2 for Claude Code as the
// Claude service account, then disables the plugin whose server ran as the
// operator's personal OAuth login. The user-scope server is a stdio entry that
// runs the secret-file wrapper Kherep installs under <CLAUDE_HOME>/kherep; the
// registry holds the key file's path, never the key.
//
// Order matters: the plugin is disabled only after the service-account server
// is registered and read back, so a failure never leaves the operator without
// Atlassian. An `atlassian` entry Kherep did not write is the operator's and
// stays, and the plugin then stays as it is too.
//
// Issue #382. A local-scope `atlassian` entry (projects.<dir>.mcpServers in the
// same registry) takes precedence in that directory, so a session there does
// not reach the service account. Such entries are named, never removed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ATLASSIAN_MCP_ENDPOINT, ATLASSIAN_MCP_SERVER, resolveTokenBinding, tokenBindingProblem,
  type TokenBinding,
} from "../lib/atlassian-mcp-binding.mts";
import { parsePluginList } from "./plugin-contract.mts";
import { getClaudeCommand } from "./reconcile-plugins.mts";
import { isRecord } from "./shape.mts";

export const OAUTH_PLUGIN = "atlassian@claude-plugins-official";
const WRAPPER = ["kherep", "mcp-auth-bridge", "supergateway-secret-wrapper.mts"];

export interface StdioEntry {
  type: "stdio";
  command: string;
  args: string[];
  env: { KHEREP_MCP_AUTH_FILE: string; KHEREP_MCP_ENDPOINT: string };
}

export type EntryState = "absent" | "current" | "kherep-previous" | "operator-owned";

export function desiredEntry(claudeHome: string, tokenFile: string): StdioEntry {
  return {
    type: "stdio",
    command: "node",
    args: [path.join(claudeHome, ...WRAPPER)],
    env: { KHEREP_MCP_AUTH_FILE: tokenFile, KHEREP_MCP_ENDPOINT: ATLASSIAN_MCP_ENDPOINT },
  };
}

function sameEntry(left: unknown, right: StdioEntry): boolean {
  if (!isRecord(left) || !isRecord(left.env) || !Array.isArray(left.args)) return false;
  const keys = Object.keys(left).filter((key) => key !== "type").sort((leftText, rightText) => Number(leftText > rightText) - Number(leftText < rightText));
  return (left.type === undefined || left.type === "stdio")
    && keys.join(",") === "args,command,env"
    && left.command === right.command
    && left.args.length === 1 && left.args[0] === right.args[0]
    && Object.keys(left.env).sort((leftText, rightText) => Number(leftText > rightText) - Number(leftText < rightText)).join(",") === "KHEREP_MCP_AUTH_FILE,KHEREP_MCP_ENDPOINT"
    && left.env.KHEREP_MCP_AUTH_FILE === right.env.KHEREP_MCP_AUTH_FILE
    && left.env.KHEREP_MCP_ENDPOINT === right.env.KHEREP_MCP_ENDPOINT;
}

// A previous Kherep entry runs the same wrapper against the same endpoint with
// another key file or Claude home; anything else under the name is not ours.
export function classifyEntry(existing: unknown, desired: StdioEntry): EntryState {
  if (existing === undefined) return "absent";
  if (sameEntry(existing, desired)) return "current";
  if (isRecord(existing) && isRecord(existing.env) && Array.isArray(existing.args)
      && existing.command === desired.command && existing.args.length === 1
      && String(existing.args[0]).replace(/\\/g, "/").endsWith(`/${WRAPPER.join("/")}`)
      && typeof existing.env.KHEREP_MCP_AUTH_FILE === "string"
      && existing.env.KHEREP_MCP_ENDPOINT === ATLASSIAN_MCP_ENDPOINT
      && Object.keys(existing.env).length === 2) return "kherep-previous";
  return "operator-owned";
}

export function userEntry(registryFile: string): unknown {
  if (!fs.existsSync(registryFile)) return undefined;
  const registry: unknown = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const servers = isRecord(registry) ? registry.mcpServers : undefined;
  return isRecord(servers) ? servers[ATLASSIAN_MCP_SERVER] : undefined;
}

// The project directories whose local-scope `atlassian` entry shadows the user-scope server.
export function shadowingProjects(registryFile: string): string[] {
  if (!fs.existsSync(registryFile)) return [];
  const registry: unknown = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const projects = isRecord(registry) ? registry.projects : undefined;
  if (!isRecord(projects)) return [];
  return Object.entries(projects)
    .filter(([, project]) => isRecord(project) && isRecord(project.mcpServers)
      && Object.hasOwn(project.mcpServers, ATLASSIAN_MCP_SERVER))
    .map(([directory]) => directory)
    .sort((left, right) => Number(left > right) - Number(left < right));
}

export interface ClaudeRun { ok: boolean; stdout: string }
export type RunClaude = (args: string[]) => ClaudeRun;

export interface RegisterOptions {
  claudeHome: string;
  codexHome: string;
  registryFile: string;
  env: Record<string, string | undefined>;
  run: RunClaude;
}

export interface RegisterResult {
  status: "configured" | "current" | "preserved-existing" | "skipped" | "failed";
  binding: TokenBinding;
  message: string;
  plugin?: "disabled" | "already-disabled" | "absent" | "disable-failed";
  /** Project directories whose local-scope entry shadows the managed server there. */
  shadowedIn?: string[];
}

function pluginEnabled(run: RunClaude): boolean | undefined {
  const listed = run(["plugin", "list", "--json"]);
  if (!listed.ok) return undefined;
  const entry = parsePluginList(JSON.parse(listed.stdout)).get(`${OAUTH_PLUGIN}\0user`);
  return entry ? entry.enabled : undefined;
}

function disablePlugin(run: RunClaude): RegisterResult["plugin"] {
  const before = pluginEnabled(run);
  if (before === undefined) return "absent";
  if (!before) return "already-disabled";
  run(["plugin", "disable", "--scope", "user", OAUTH_PLUGIN]);
  return pluginEnabled(run) === false ? "disabled" : "disable-failed";
}

export function registerAtlassianMcp(options: RegisterOptions): RegisterResult {
  const result = registerUserServer(options);
  const shadowedIn = result.status === "skipped" ? [] : shadowingProjects(options.registryFile);
  return shadowedIn.length ? { ...result, shadowedIn } : result;
}

function registerUserServer(options: RegisterOptions): RegisterResult {
  const binding = resolveTokenBinding("claude",
    { claude: options.claudeHome, codex: options.codexHome }, options.env);
  const problem = tokenBindingProblem(binding);
  if (problem) return { status: "skipped", binding, message: problem };
  const desired = desiredEntry(options.claudeHome, binding.file);
  const state = classifyEntry(userEntry(options.registryFile), desired);
  if (state === "operator-owned") {
    return { status: "preserved-existing", binding,
      message: `the user-scope MCP server '${ATLASSIAN_MCP_SERVER}' is not Kherep's and stays as it is; ${OAUTH_PLUGIN} is left unchanged` };
  }
  if (state !== "current") {
    if (state === "kherep-previous") options.run(["mcp", "remove", "--scope", "user", ATLASSIAN_MCP_SERVER]);
    options.run(["mcp", "add-json", "--scope", "user", ATLASSIAN_MCP_SERVER, JSON.stringify(desired)]);
    if (classifyEntry(userEntry(options.registryFile), desired) !== "current") {
      return { status: "failed", binding,
        message: `the user-scope MCP server '${ATLASSIAN_MCP_SERVER}' did not read back as registered; ${OAUTH_PLUGIN} is left unchanged` };
    }
  }
  const plugin = disablePlugin(options.run);
  if (plugin === "disable-failed") {
    return { status: "failed", binding, plugin,
      message: `${OAUTH_PLUGIN} is still enabled, so its personal OAuth server runs beside the service account` };
  }
  return { status: state === "current" ? "current" : "configured", binding, plugin,
    message: `'${ATLASSIAN_MCP_SERVER}' runs as the Claude service account; ${OAUTH_PLUGIN}: ${plugin}` };
}

function cli(): void {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--claude-home");
  if (flag < 0 || !args[flag + 1] || args.length !== 2) {
    process.stderr.write("usage: atl-mcp-claude.mts --claude-home <dir>\n");
    process.exitCode = 2;
    return;
  }
  const command = getClaudeCommand(process.env);
  const run: RunClaude = (claudeArgs) => {
    try {
      const stdout = execFileSync(command.executable, [...command.prefixArgs, ...claudeArgs], {
        encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      });
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: "" };
    }
  };
  const result = registerAtlassianMcp({
    claudeHome: path.resolve(args[flag + 1]!),
    codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    registryFile: path.join(os.homedir(), ".claude.json"),
    env: process.env,
    run,
  });
  const ok = ["configured", "current", "preserved-existing"].includes(result.status);
  process.stdout.write(`atl-mcp-claude: ${ok ? "" : "WARNING "}${result.status}: ${result.message}\n`);
  for (const directory of result.shadowedIn ?? []) {
    process.stdout.write(`atl-mcp-claude: WARNING a local-scope '${ATLASSIAN_MCP_SERVER}' entry for ${directory} `
      + "shadows the service-account server in that directory and is left as it is; remove it with: "
      + `cd ${JSON.stringify(directory)} && claude mcp remove ${ATLASSIAN_MCP_SERVER} -s local\n`);
  }
  if (!ok || result.shadowedIn?.length) process.exitCode = 1;
}

function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`atl-mcp-claude: WARNING failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
