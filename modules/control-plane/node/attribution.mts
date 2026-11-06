import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isCodexSessionId } from "./codex-sessions.mts";
import { ensureDir, type NodePaths } from "./config.mts";

// Issue #325, PR-A. The local attribution log: which session pushed a branch or
// opened a PR. One JSON object per line in nodePaths().attribution, mode 0600,
// written by the pre-push git hook (claude/kherep/githooks/attribution-record.mts,
// a self-contained copy of the rules below) and by attribution-hook.mts, read
// only by `kherep-node attribution`. The daemon protocol, the Worker and
// sessions.json never read it. A record names ids, paths, refs and SHAs, never
// message text, commit subjects, PR titles or bodies, tokens or environments.
//
// Retention follows task-refusals.mts: every append trims what has expired.

export const ATTRIBUTION_RETENTION_MS = 90 * 24 * 60 * 60_000;
// How long a Codex PreToolUse marker waits for the pre-push hook it announces.
export const PENDING_MARKER_MS = 120_000;

export type AttributionRuntime = "claude" | "codex" | "unknown";

export interface AttributionRecord {
  v: 1; ts: string; kind: "push" | "pr-create";
  sessionId: string; runtime: AttributionRuntime;
  // CLAUDE_CODE_SESSION_ID, KHEREP_SESSION_ID, marker, hook (the hook payload) or none.
  sessionSource: string;
  repo: string | null; toplevel: string; branch: string | null; remoteRef: string | null; sha: string | null;
  pr: number | null; prSource?: "stdout" | "gh" | "unresolved";
}

// Session ids reach file names and the log, so only plain file-name characters.
export const isSessionId = isCodexSessionId;

// owner/name from a remote URL, a scp-like address or a path. Scheme, userinfo
// and host are dropped before anything is kept, so a token never survives.
export function repoSlug(url: string): string | null {
  const rest = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "").replace(/^[^/\\:]+@[^:/]+:/, "");
  const parts = rest.split(/[\\/:]+/).filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts.at(-2)}/${parts.at(-1)!.replace(/\.git$/, "")}`;
}

function recordTime(line: string): number {
  try {
    const at = Date.parse((JSON.parse(line) as { ts?: unknown } | null)?.ts as string);
    return Number.isNaN(at) ? -Infinity : at;
  } catch {
    return -Infinity;
  }
}

// Drops every line older than ATTRIBUTION_RETENTION_MS; a line without a
// readable ts goes with them, like an unreadable refusal. Rewrites only when
// something expired.
export function trimAttribution(paths: NodePaths, now: number): void {
  let text: string;
  try {
    text = fs.readFileSync(paths.attribution, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter(Boolean);
  const kept = lines.filter((line) => now - recordTime(line) < ATTRIBUTION_RETENTION_MS);
  if (kept.length === lines.length) return;
  const temp = `${paths.attribution}.${process.pid}.tmp`;
  fs.writeFileSync(temp, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  fs.renameSync(temp, paths.attribution);
}

export function appendAttribution(paths: NodePaths, record: AttributionRecord, now = Date.now()): void {
  ensureDir(paths.dir);
  fs.appendFileSync(paths.attribution, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  trimAttribution(paths, now);
}

function isRecord(value: unknown): value is AttributionRecord {
  const record = value as Partial<AttributionRecord> | null;
  return typeof record === "object" && record !== null && !Array.isArray(record) && record.v === 1
    && typeof record.ts === "string" && (record.kind === "push" || record.kind === "pr-create");
}

// Malformed lines are skipped. A missing log is no records; any other read
// failure is thrown, so it never looks like an empty log.
export function readAttribution(paths: NodePaths): AttributionRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(paths.attribution, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

// The marker file name: sha256 of the toplevel with forward slashes and no
// trailing slash, lower case on Windows, where git prints the drive either way.
export function markerKey(toplevel: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = toplevel.replace(/\\/g, "/").replace(/(?<!\/)\/+$/, "");
  return crypto.createHash("sha256").update(platform === "win32" ? normalized.toLowerCase() : normalized).digest("hex");
}

export function pendingMarkerFile(paths: NodePaths, toplevel: string): string {
  return path.join(paths.attributionPending, `${markerKey(toplevel)}.json`);
}

// Written by the Codex PreToolUse phase, consumed by the pre-push hook. Markers
// nobody consumed within PENDING_MARKER_MS are removed here. An invalid id
// writes nothing.
export function writePendingMarker(paths: NodePaths, toplevel: string, sessionId: unknown, runtime: "codex",
  now: number): boolean {
  if (!isSessionId(sessionId)) return false;
  ensureDir(paths.attributionPending);
  for (const name of fs.readdirSync(paths.attributionPending)) {
    const file = path.join(paths.attributionPending, name);
    try {
      if (now - fs.statSync(file).mtimeMs > PENDING_MARKER_MS) fs.rmSync(file, { force: true });
    } catch { /* removed by a concurrent writer or reader */ }
  }
  fs.writeFileSync(pendingMarkerFile(paths, toplevel), `${JSON.stringify({ sessionId, runtime, at: new Date(now).toISOString() })}\n`,
    { mode: 0o600 });
  return true;
}
