import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MESSAGE = [
  "Code discovery protocol:",
  "1. Prefer codebase-memory-mcp graph tools for structural code exploration.",
  "2. Use search_graph before trace_path or get_code_snippet.",
  "3. Use text search for literals, configs, scripts, and non-code files.",
].join("\n");

export async function main(): Promise<void> {
  let input: { hook_event_name?: unknown } = {};
  try { input = JSON.parse((await (await import("./stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}"); } catch { return; }
  const event = input.hook_event_name;
  if (typeof event !== "string" || !["SessionStart", "SubagentStart"].includes(event)) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: MESSAGE },
  }));
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
