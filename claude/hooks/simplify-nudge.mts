#!/usr/bin/env node
// PostToolUse hook: surfaces the code-simplifier anti-overengineering rule once
// per session when a code file inside workspace is edited. Soft nudge, never blocks.
// Pairs with project CLAUDE.md golden rule #10 (code-simplifier gate).
// The hook CANNOT run the agent itself (hooks are shell, not the model) - it only
// reminds; the model dispatches the code-simplifier agent per the CLAUDE.md rule.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configuredWorkspace, isWithinPath } from "./lib/workspace-scope.mts";

const CODE_EXT = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|java|go|rs|rb|php|cs|kt|swift|scala|c|cc|cpp|h|hpp)$/i;
const SKIP_DIRS = /(?:^|[\\/])(?:node_modules|dist|build|target|\.next|\.nuxt|out|coverage|_deprecated)[\\/]/;
const TOOLS = ["Edit", "Write", "MultiEdit"];

const NUDGE = "[simplify-watch] Code in the configured workspace changed. Before declaring done, "
  + "run the configured code-simplifier on the lines changed in this task.\n";

// The three fields this hook reads. The rest of a PostToolUse payload stays
// unread and is therefore not typed here.
interface NudgePayload {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown } | null;
}

function watched(payload: NudgePayload | null): boolean {
  if (!payload || !TOOLS.includes(String(payload.tool_name))) return false;
  const filePath = typeof payload.tool_input?.file_path === "string" ? payload.tool_input.file_path : "";
  if (!filePath) return false;
  if (!CODE_EXT.test(filePath)) return false;
  if (SKIP_DIRS.test(filePath)) return false;
  // Project-level rule: only code inside workspace
  return isWithinPath(filePath, configuredWorkspace());
}

// Rate-limit to one nudge per session (the CLAUDE.md rule is the every-turn enforcer).
// Returns false only when the marker proves this session was nudged already.
function claimSession(sessionId: unknown): boolean {
  const sid = String(sessionId || "nosession").replace(/[^a-zA-Z0-9_-]/g, "");
  const flag = path.join(os.tmpdir(), `.simplify-nudged-${sid}`);
  try {
    if (fs.existsSync(flag)) return false;
    fs.writeFileSync(flag, "1");
  } catch {
    // best-effort; if flag I/O fails, still nudge once (acceptable)
  }
  return true;
}

async function main(): Promise<void> {
  try {
    const payload = JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")) as NudgePayload | null;
    if (!watched(payload)) return;
    if (!claimSession(payload?.session_id)) return;
    process.stdout.write(NUDGE);
  } catch {
    // Fail-open: a hook that cannot answer says nothing and exits 0.
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
