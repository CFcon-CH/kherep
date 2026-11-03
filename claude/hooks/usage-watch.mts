#!/usr/bin/env node
/**
 * usage-watch.mts  -  UserPromptSubmit hook (weekly plan-usage watcher, issue #748)
 *
 * Adds a short notice to every prompt while the weekly Claude plan budget is at least
 * half used or usage runs ahead of the 7-day window. The hook never sees rate_limits:
 * it reads <CLAUDE_HOME>/.cache/usage-watch/state.json, which the status line's recorder
 * (hooks/usage-record.mts) wrote, and re-derives the elapsed share at "now". The budget
 * is per account, so the notice is not limited to the workspace. Neither the prompt nor
 * the payload is echoed. Any error exits silently and never blocks the prompt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { noticeText, parseState } from "./lib/usage-window.mts";

export function promptNotice(stateJson: string | null, nowMs: number, timeZone?: string): string {
  const state = parseState(stateJson);
  return state ? noticeText(state, nowMs, timeZone) : "";
}

function stateFile(): string {
  const home = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return path.join(home, ".cache", "usage-watch", "state.json");
}

function main(): void {
  try {
    // The payload is parsed only to honour the hook contract; nothing in it is used.
    // A missing or unreadable state file throws into the silent catch below.
    JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    const text = promptNotice(fs.readFileSync(stateFile(), "utf8"), Date.now());
    if (!text) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    }));
  } catch {
    // Never break the prompt submit.
  }
}

// Same main-module check as research-first.mts: realpath for symlinked directories.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
