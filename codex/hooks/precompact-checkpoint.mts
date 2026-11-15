import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface PreCompactInput {
  transcript_path?: unknown;
  session_id?: unknown;
  cwd?: unknown;
}

export function safeId(value: unknown): string {
  return String(value || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 120);
}

export function writeFallback(input: PreCompactInput): string | null {
  const transcript = input.transcript_path;
  if (typeof transcript !== "string" || !transcript || !path.isAbsolute(transcript)) return null;
  const normalized = path.resolve(transcript).replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)\.claude(?:-mem)?(?:\/|$)/.test(normalized)) return null;
  const directory = path.join(path.dirname(transcript), "memory", "codex-checkpoints");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${safeId(input.session_id)}.json`);
  fs.writeFileSync(target, JSON.stringify({
    cwd: input.cwd || null,
    session_id: input.session_id || null,
    timestamp: new Date().toISOString(),
    transcript_path: transcript,
  }, null, 2) + "\n", "utf8");
  return target;
}

async function main(): Promise<void> {
  let input: PreCompactInput = {};
  try { input = JSON.parse((await (await import("./stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}"); } catch { return; }
  const target = writeFallback(input);
  if (target) process.stdout.write(JSON.stringify({ systemMessage: "Local Codex pre-compact metadata recorded; the task transcript remains the continuity source." }));
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
