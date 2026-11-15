#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  brainSearchCommand, codexConfigPath, gitRepositoryOf, workspaceFor, type EnvLike,
} from "./research-common.mts";
import type { Exists } from "./research-transcript.mts";

export function promptContext(
  value: unknown,
  env: EnvLike = process.env,
  configPath?: string,
  exists?: Exists,
): string {
  const workspace = workspaceFor(value, env);
  if (!workspace) return "";
  const payload = value as { cwd?: unknown };
  const lines = [
    "RESEARCH FIRST (ROUTING.md, Evidence first): classify this prompt. Answer a banal prompt directly. For a relevant prompt, research before answering:",
    `1. Central Brain: ${brainSearchCommand(workspace, configPath || codexConfigPath(env))}. Search terms follow the privacy classification; private content never goes to Atlassian. A lookup attempt is evidence of process, not proof that the lookup succeeded.`,
    'If sandbox networking blocks this read-only broker search, request command-scoped approval with sandbox_permissions="require_escalated". Headless research needs codex exec --approve-for-me so the request can be reviewed. Keep the sandbox and privacy guards; an unavailable lookup is UNKNOWN, not evidence of a service outage.',
  ];
  if (gitRepositoryOf(payload.cwd, exists)) {
    lines.push("2. Code graph: this working directory is in a repository. If code changes, query codebase-memory first (mcp__codebase_memory_mcp__* or mcp__codebase-memory-mcp__*).");
  }
  lines.push("Compare the evidence with the answer. If research is not relevant, end the final response with [research: none - <reason>].");
  return lines.join("\n");
}

async function main(): Promise<void> {
  try {
    const context = promptContext(JSON.parse((await (await import("./stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}"));
    if (context) process.stdout.write(context);
  } catch {
    // A reminder hook never blocks prompt submission.
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch { return false; }
}

if (isMainModule()) await main();
