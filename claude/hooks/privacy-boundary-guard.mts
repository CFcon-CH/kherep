#!/usr/bin/env node
import { normalizePathLike, type ScopePayload } from "./lib/workspace-scope.mts";
import { referencesArtifact, referencesCredentials, shellWords, type PolicyInput } from "./lib/private-path-policy.mts";
import { warnUnclassifiable } from "./lib/tool-event-shape.mts";

// The fields this hook reads from a PreToolUse payload.
interface ToolPayload extends ScopePayload {
  tool_name?: unknown;
  tool_input?: unknown;
}

const FILE_SHELL_TOOLS = new Set<unknown>(["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "Bash", "PowerShell"]);
const CLOUD_BOUNDARY_TOOLS = new Set<unknown>(["Agent", "Task", "Workflow", "WebSearch", "WebFetch"]);
const PRIVATE_PATTERN = /work-credentials|\b(?:host_vars|group_vars)\b|customer[ -]?internals?|forge service cred|<private>/i;
const RUNNER_SUFFIX = "/.claude/kherep/local-inference/runner.mts";
const SHELL_META = /(?:\r|\n|[;&|<>`]|\$\()/;

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[privacy-boundary] ${reason}`,
    },
  }));
}

function isRunnerInvocation(command: string): boolean {
  if (!command || SHELL_META.test(command)) return false;
  const words = shellWords(command);
  if (words.length < 2) return false;
  const executable = normalizePathLike(words[0]).split("/").pop()!.toLowerCase();
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const claudeHome = normalizePathLike(process.env.CLAUDE_HOME || `${userHome}/.claude`).toLowerCase();
  let scriptValue = words[1];
  if (/^~[\\/]/.test(scriptValue)) scriptValue = `${userHome}/${scriptValue.slice(2)}`;
  const script = normalizePathLike(scriptValue).toLowerCase();
  return (executable === "node" || executable === "node.exe")
    && script === `${claudeHome}/kherep/local-inference/runner.mts`;
}

function mentionsRunner(command: unknown): boolean {
  return String(command || "").replace(/\\/g, "/").toLowerCase().includes(RUNNER_SUFFIX);
}

function referencesInferenceHttp(command: unknown): boolean {
  const text = String(command || "");
  if (/\bhttps?:\/\/(?:\[[^\]]+\]|[^\s/"'`:]+):0*(?:8000|1234)(?=$|[\/\s?&#"'`])/i.test(text)) return true;
  if (!/\b(?:curl(?:\.exe)?|wget|invoke-webrequest|invoke-restmethod)\b/i.test(text)) return false;
  return /(?:^|[\s"'=(])(?:localhost|127\.0\.0\.1|\[::1\]|[A-Za-z0-9.-]+):0*(?:8000|1234)(?=$|[\/\s?&#"'`])/i.test(text);
}

async function main(): Promise<void> {
  let payload: ToolPayload | null;
  // The two returns before any policy check are quiet allows: they add the event-shape warning (issue #808).
  try { payload = JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")) as ToolPayload | null; }
  catch { warnUnclassifiable(undefined, "privacy-boundary-guard"); return; }

  const tool = payload && payload.tool_name;
  const cloudBoundary = CLOUD_BOUNDARY_TOOLS.has(tool) || (typeof tool === "string" && tool.startsWith("mcp__"));
  if (!FILE_SHELL_TOOLS.has(tool) && !cloudBoundary) { warnUnclassifiable(payload, "privacy-boundary-guard"); return; }
  const scope = payload as ToolPayload;
  const input = scope.tool_input as (PolicyInput & { file_path?: unknown }) | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    deny("Malformed input for a privacy-relevant tool; request denied.");
    return;
  }

  try {
    if (cloudBoundary) {
      if (PRIVATE_PATTERN.test(JSON.stringify(input)) || referencesCredentials(input, scope) || referencesArtifact(input, scope)) {
        deny("Private paths/content and local-inference artifacts may not cross Agent, Workflow, web, or MCP boundaries.");
      }
      return;
    }
    if (["Read", "Edit", "Write"].includes(tool as string) && typeof input.file_path !== "string") {
      deny("Missing file_path for a privacy-relevant file operation.");
      return;
    }
    if (tool === "Bash" || tool === "PowerShell") {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (!command) { deny("Missing command for a privacy-relevant shell operation."); return; }
      if (isRunnerInvocation(command)) return;
      if (referencesInferenceHttp(command)) {
        deny("Direct HTTP access to local inference ports 8000/1234 is forbidden; invoke the approved local runner.");
        return;
      }
      if (mentionsRunner(command) || PRIVATE_PATTERN.test(JSON.stringify(input)) || referencesCredentials(input, scope) || referencesArtifact(input, scope)) {
        deny("Private paths or local-inference artifacts may only be handled by one unchained invocation of the approved local runner.");
      }
      return;
    }
    if (PRIVATE_PATTERN.test(JSON.stringify(input)) || referencesCredentials(input, scope) || referencesArtifact(input, scope)) {
      deny("Private paths/content and local-inference artifacts may not enter Claude file tools. Use the approved local runner and do not read its artifact back.");
    }
  } catch {
    deny("Privacy policy failed while classifying a relevant tool request; request denied.");
  }
}

try { await main(); } catch {
  // Unknown/non-tool events stay fail-open. Relevant tool errors are handled in main.
}
process.exit(0);
