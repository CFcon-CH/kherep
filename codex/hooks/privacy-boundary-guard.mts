#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The policy libs are the Claude hook libs, TypeScript since OP-1137: beside
// this file at the install target (hookDir/lib, copied from claude/hooks/lib),
// and in the checkout only under claude/hooks/lib, because the copies that used
// to sit in codex/hooks/lib were parked with that wave. Resolved at runtime
// because the location differs between the two, exactly as the JavaScript
// version did.
//
// TWO THINGS ARE MEASURED HERE, NOT ASSUMED. The probe names the file instead
// of the directory: an unrelated directory may still exist, so
// a directory test would answer yes and then fail on a lib that is not in it.
// And the require carries the explicit .mts extension, because Node 24 loads a
// spelled-out .mts and answers MODULE_NOT_FOUND for the extension-less name.
const require = createRequire(import.meta.url);
const localLib = path.join(import.meta.dirname, "lib");
const checkoutLib = path.resolve(import.meta.dirname, "..", "..", "claude", "hooks", "lib");
const libRoot = fs.existsSync(path.join(localLib, "workspace-scope.mts")) ? localLib : checkoutLib;
const { normalizePathLike } = require(path.join(libRoot, "workspace-scope.mts")) as {
  normalizePathLike: (value: unknown) => string;
};
const { referencesArtifact, referencesCredentials, shellWords } = require(path.join(libRoot, "private-path-policy.mts")) as {
  referencesArtifact: (input: Record<string, unknown>, payload: Record<string, unknown>, env?: NodeJS.ProcessEnv) => boolean;
  referencesCredentials: (input: Record<string, unknown>, payload: Record<string, unknown>, env?: NodeJS.ProcessEnv) => boolean;
  shellWords: (command: string) => string[];
};

const FILE_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "Bash"]);
const CLOUD_TOOLS = new Set(["Agent", "Task", "Workflow", "WebSearch", "WebFetch"]);
const PRIVATE = /work-credentials|\b(?:host_vars|group_vars)\b|customer[ -]?internals?|forge service cred|<private>/i;
const RUNNER_SUFFIX = "/.codex/kherep/local-inference/runner.mts";
const CLAUDE_RUNNER_SUFFIX = "/.claude/kherep/local-inference/runner.mts";
const SHELL_META = /(?:\r|\n|[;&|<>`]|\$\()/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRunnerInvocation(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!command || SHELL_META.test(command)) return false;
  const words = shellWords(command);
  if (words.length < 2) return false;
  const executable = normalizePathLike(words[0]).split("/").pop()?.toLowerCase();
  const userHome = env.USERPROFILE || env.HOME || "";
  const codexHome = normalizePathLike(env.CODEX_HOME || `${userHome}/.codex`).toLowerCase();
  let value = words[1];
  if (/^~[\\/]/.test(value)) value = `${userHome}/${value.slice(2)}`;
  const script = normalizePathLike(value).toLowerCase();
  return (executable === "node" || executable === "node.exe")
    && script === `${codexHome}/kherep/local-inference/runner.mts`;
}

export function referencesInferenceHttp(command: unknown): boolean {
  const text = String(command || "");
  if (/\bhttps?:\/\/(?:\[[^\]]+\]|[^\s/"'`:]+):0*(?:8000|1234)(?=$|[\/\s?&#"'`])/i.test(text)) return true;
  if (!/\b(?:curl(?:\.exe)?|wget|invoke-webrequest|invoke-restmethod)\b/i.test(text)) return false;
  return /(?:^|[\s"'=(])(?:localhost|127\.0\.0\.1|\[::1\]|[A-Za-z0-9.-]+):0*(?:8000|1234)(?=$|[\/\s?&#"'`])/i.test(text);
}

export function evaluate(payload: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  const record = isRecord(payload) ? payload : {};
  const tool = record.tool_name;
  const cloud = (typeof tool === "string" && CLOUD_TOOLS.has(tool)) || (typeof tool === "string" && tool.startsWith("mcp__"));
  if (!(typeof tool === "string" && FILE_TOOLS.has(tool)) && !cloud) return null;
  const input = record.tool_input;
  if (!isRecord(input)) return "Malformed privacy-relevant tool input.";
  if (cloud) {
    return PRIVATE.test(JSON.stringify(input)) || referencesCredentials(input, record, env) || referencesArtifact(input, record, env)
      ? "Private material may not cross Agent, Workflow, web, or MCP boundaries." : null;
  }
  if (["Read", "Edit", "Write"].includes(tool) && typeof input.file_path !== "string") return "Missing file_path.";
  if (tool !== "Bash") {
    return PRIVATE.test(JSON.stringify(input)) || referencesCredentials(input, record, env) || referencesArtifact(input, record, env)
      ? "Private material may not enter Codex file tools." : null;
  }
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return "Missing shell command.";
  const portableCommand = command.replace(/\\/g, "/").toLowerCase();
  if (portableCommand.includes(CLAUDE_RUNNER_SUFFIX)) return "Claude-owned local-inference runner is forbidden from Codex.";
  if (isRunnerInvocation(command, env)) return null;
  if (referencesInferenceHttp(command)) return "Direct local-inference HTTP is forbidden; use the approved Codex runner.";
  if (portableCommand.includes(RUNNER_SUFFIX)
      || PRIVATE.test(JSON.stringify(input)) || referencesCredentials(input, record, env) || referencesArtifact(input, record, env)) {
    return "Private material may only be handled by one unchained invocation of the approved Codex runner.";
  }
  return null;
}

async function main(): Promise<void> {
  let payload: unknown;
  try { payload = JSON.parse((await (await import("./stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")); } catch { return; }
  let reason: string | null;
  try { reason = evaluate(payload); } catch { reason = "Privacy classification failed."; }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[privacy-boundary] ${reason}`,
  } }));
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

if (isMainModule()) await main();
