import fs from "node:fs";
import path from "node:path";

import { isTitle, MAX_TITLE_CHARS, type SessionInfo } from "../protocol.mts";
import { CODEX_RUNTIME } from "./codex-sessions.mts";

// Codex thread titles (issue #88). The Codex app shows threads only by title;
// <codex home>/session_index.jsonl holds one JSON line per thread with id,
// thread_name and updated_at (measured with Codex app 0.158 alpha). Only those
// three keys are read, nothing else of the Codex history. The read is bounded
// and fail-soft: a missing, unreadable or garbled index gives no titles.

export const CODEX_INDEX = "session_index.jsonl";
// Only the end of a larger index is read; the latest entries are appended there.
export const INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const INDEX_MAX_LINES = 20_000;

// Control, format and separator characters removed, whitespace collapsed,
// trimmed and cut to MAX_TITLE_CHARS; nothing left is no title.
export function sanitiseTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ +/g, " ").trim();
  const chars = [...clean];
  const title = chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join("").trimEnd()}…` : clean;
  return isTitle(title) ? title : undefined;
}

function readTail(file: string, maxBytes: number, strict = false): string {
  // Only a regular file is opened: a pipe in its place would block the read.
  if (!fs.statSync(file).isFile()) throw new Error("not a file");
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, size - length);
    const bytes = buffer.subarray(0, read);
    // A cut start is a partial line. Assignment also refuses malformed UTF-8
    // rather than changing the native title to replacement characters.
    if (strict) {
      const start = length < size ? bytes.indexOf(0x0a) + 1 : 0;
      if (length < size && start === 0) return "";
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start));
    }
    const text = bytes.toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// Thread id to title; the entry with the latest updated_at wins, and of equal
// times the later line.
export function readCodexTitles(codexHome: string, limits: { maxBytes?: number; maxLines?: number } = {}): Map<string, string> {
  const titles = new Map<string, string>();
  let text: string;
  try {
    text = readTail(path.join(codexHome, CODEX_INDEX), limits.maxBytes ?? INDEX_MAX_BYTES);
  } catch {
    return titles;
  }
  const times = new Map<string, number>();
  for (const line of text.split("\n").slice(-(limits.maxLines ?? INDEX_MAX_LINES))) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { id, thread_name: name, updated_at: at } = entry as Record<string, unknown>;
    const title = sanitiseTitle(name);
    if (typeof id !== "string" || id.length === 0 || id.length > 128 || !title) continue;
    const time = (typeof at === "string" && Date.parse(at)) || 0;
    if (time < (times.get(id) ?? -Infinity)) continue;
    times.set(id, time);
    titles.set(id, title);
  }
  return titles;
}

// Exact native assignment name, separate from the lossy display reader above.
// Protocol length limits belong to the caller: never shorten a valid name here.
// The latest entry wins even if its name is unsupported, preventing a stale
// earlier name from being used for assignment. Missing optional timestamps use
// the same zero-time fallback and later-line tie rule as readCodexTitles. Any
// malformed retained row denies assignment: its chat/rename order is unknown.
export async function codexAssignmentTitle(codexHome: string, sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  let text: string;
  try {
    text = readTail(path.join(codexHome, CODEX_INDEX), INDEX_MAX_BYTES, true);
  } catch {
    return null;
  }
  let latest = -Infinity;
  let title: string | null = null;
  for (const line of text.split("\n").slice(-INDEX_MAX_LINES)) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A corrupt row may be a newer rename of the requested chat.
      return null;
    }
    if (typeof entry !== "object" || entry === null) return null;
    const { id, thread_name: name, updated_at: at } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) return null;
    if (id !== sessionId) continue;
    const time = (typeof at === "string" && Date.parse(at)) || 0;
    if (time < latest) continue;
    latest = time;
    title = typeof name === "string" && name.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(name) ? name : null;
  }
  return title;
}

// Codex sessions with a known thread title carry it; others are unchanged.
export function withCodexTitles(sessions: SessionInfo[], titles: Map<string, string>): SessionInfo[] {
  return sessions.map((s) => {
    const title = s.runtime === CODEX_RUNTIME ? titles.get(s.sessionId) : undefined;
    return title ? { ...s, title } : s;
  });
}
