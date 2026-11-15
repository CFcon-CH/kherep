#!/usr/bin/env node
/**
 * research-first.mts  -  UserPromptSubmit hook (evidence first, OP-1440)
 *
 * Adds a short research-first instruction to every prompt inside the configured
 * Kherep workspace: classify the prompt, and for a relevant one research before
 * answering - the Central Brain always, the code graph first when the working
 * directory is inside a git repository. research-stop.mts enforces it.
 *
 * No model call, no network, nothing leaves the host. It reads two local facts:
 * whether cwd sits in a git repository, and the space key in
 * <claude-home>/kherep/confluence.json. Neither the prompt nor the payload is
 * echoed. Any error exits silently and never blocks the prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { brainSearchCommand, gitRepositoryOf, type Exists } from "./lib/research-evidence.mts";
import { workspaceForPayload, type EnvLike } from "./lib/workspace-scope.mts";

export interface PromptPayload {
  cwd?: unknown;
  [key: string]: unknown;
}

export function promptContext(
  value: unknown,
  env: EnvLike = process.env,
  configPath?: string,
  exists?: Exists,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const payload = value as PromptPayload;
  const workspace = workspaceForPayload(payload, env);
  if (!workspace) return "";

  const lines = [
    "RESEARCH FIRST (ROUTING.md, Evidence first): classify this prompt. A banal one (greeting, acknowledgement, a fact that needs no lookup) is answered directly. For a relevant one, research before answering:",
    `1. Central Brain: ${brainSearchCommand(workspace, configPath)}. Search terms follow the privacy classification; private content never goes to Atlassian. Exit 2 means unavailable (UNKNOWN), not no match.`,
  ];
  if (gitRepositoryOf(payload.cwd, exists)) {
    lines.push("2. Code graph: the working directory is inside a git repository. If it is indexed by codebase-memory, query the code graph (mcp__codebase-memory-mcp__*) first, before reading files.");
  }
  lines.push("Answer after comparing with the Brain; name the page id of a Brain page your result contradicts. A substantial turn without research ends with [research: none - <reason>].");
  return lines.join("\n");
}

async function main(): Promise<void> {
  try {
    const text = promptContext(JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}"));
    if (!text) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    }));
  } catch {
    // Never break the prompt submit.
  }
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
