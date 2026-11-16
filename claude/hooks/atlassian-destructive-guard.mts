#!/usr/bin/env node
// PreToolUse guard: an Atlassian MCP destructive operation needs the operator.
//
// The v2 Atlassian MCP server runs deletes and other irreversible changes
// through one tool, executeDestructive. Read and write go through freely; this
// one does not. Claude asks the operator to confirm the call (issue #376).
// Codex hooks cannot ask, so under --runtime codex the call is denied and the
// operator runs it; the managed Atlassian table also sets approval_mode =
// "prompt" for it, which holds wherever Codex fires no PreToolUse hook.
//
// The server part of the name is not checked: the Kherep service-account
// server, a plugin namespace and a claude.ai connector named by a UUID all
// carry the same operation.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { warnUnclassifiable } from "./lib/tool-event-shape.mts";

// The fields this hook reads from a PreToolUse payload.
interface ToolPayload {
  tool_name?: unknown;
  tool_input?: unknown;
}

const DESTRUCTIVE_TOOL = /^mcp__.+__executeDestructive$/;

export function isDestructiveCall(payload: ToolPayload): boolean {
  return typeof payload.tool_name === "string" && DESTRUCTIVE_TOOL.test(payload.tool_name);
}

function operationName(payload: ToolPayload): string {
  const input = payload.tool_input;
  const name = input && typeof input === "object" ? (input as Record<string, unknown>).name : undefined;
  return typeof name === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : "";
}

export function decide(payload: ToolPayload, runtime: string): string | null {
  if (!isDestructiveCall(payload)) return null;
  const operation = operationName(payload);
  const subject = `Atlassian MCP destructive operation${operation ? ` ${operation}` : ""}`;
  const codex = runtime === "codex";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: codex ? "deny" : "ask",
      permissionDecisionReason: codex
        ? `[atlassian-destructive] ${subject} is not run by an agent in Codex. Name the operation, its target and inputs to the operator, who runs it.`
        : `[atlassian-destructive] ${subject} cannot be undone. Confirm only if the operator asked for exactly this change.`,
    },
  });
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--runtime");
  const runtime = flag >= 0 ? String(process.argv[flag + 1] || "") : "claude";
  // Every quiet allow adds the event-shape warning (issue #808).
  let payload: ToolPayload;
  try {
    const parsed: unknown = JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return warnUnclassifiable(parsed, "atlassian-destructive-guard");
    payload = parsed as ToolPayload;
  } catch {
    return warnUnclassifiable(undefined, "atlassian-destructive-guard");
  }
  const output = decide(payload, runtime);
  if (output) process.stdout.write(output);
  else warnUnclassifiable(payload, "atlassian-destructive-guard");
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory matches only after realpath. The tests import decide().
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
