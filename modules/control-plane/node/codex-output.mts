import fs from "node:fs";

import type { CodexFiles } from "./codex-process.mts";
import { readJson } from "./inbox.mts";

// What a Codex task run left in its files (issue #63): the `--json` events,
// how the process ended, the last agent message and the last stderr line.

// progressed: the model answered in this run's turn (an item.* event or
// turn.completed); thread.started and turn.started come before it (issue #197).
export interface CodexEvents { threadId?: string; completed: boolean; error?: string; progressed?: boolean }

// Reads the events file; a line that is not JSON (a partial last line) is skipped.
export function readEvents(files: CodexFiles): CodexEvents {
  let text: string;
  try {
    text = fs.readFileSync(files.events, "utf8");
  } catch {
    return { completed: false };
  }
  const result: CodexEvents = { completed: false };
  for (const line of text.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string" && !result.threadId) result.threadId = event.thread_id;
    if (event.type === "turn.completed") result.completed = true;
    if (event.type === "turn.completed" || (typeof event.type === "string" && event.type.startsWith("item."))) result.progressed = true;
    const failure = failureOf(event);
    if (typeof failure === "string") result.error = failure;
  }
  return result;
}

// The message of a turn.failed or error event.
function failureOf(event: Record<string, unknown>): unknown {
  if (event.type === "turn.failed") return (event.error as { message?: unknown } | undefined)?.message;
  if (event.type === "error") return event.message;
  return undefined;
}

export interface CodexExit { code: number | null; signal: string | null }
export const readExit = (files: CodexFiles): CodexExit | null => {
  try {
    return readJson<CodexExit>(files.exit);
  } catch {
    return null;
  }
};

export function readLastMessage(files: CodexFiles): string {
  try {
    return fs.readFileSync(files.lastMessage, "utf8").trim();
  } catch {
    return "";
  }
}

// The last non-empty stderr line, for a failure reason (lastLine). The prompt
// goes in on stdin.
export function lastStderrLine(files: CodexFiles): string {
  let text: string;
  try {
    text = fs.readFileSync(files.stderr, "utf8").slice(-65_536);
  } catch {
    return "";
  }
  return lastLine(text);
}

// Secrets a CLI error line may carry: API keys, bearer tokens, JWTs, URL user
// info and URL query strings.
const REDACTIONS: readonly [RegExp, string][] = [
  [/sk-[A-Za-z0-9_*-]+/g, "sk-<redacted>"],
  [/Bearer\s+\S+/gi, "Bearer <redacted>"],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt-redacted>"],
  [/\/\/[^\s/@]+@/g, "//<redacted>@"],
];

// A URL query: inside one run of non-space, non-# characters, everything after the first "?" that follows scheme://.
function redactQuery(run: string): string {
  const scheme = /[a-z][0-9+.-]*:\/\//i.exec(run);
  const at = scheme ? run.indexOf("?", scheme.index + scheme[0].length) : -1;
  return at < 0 ? run : `${run.slice(0, at + 1)}<redacted>`;
}

// The last non-empty line of a CLI's stderr: control characters removed,
// secrets redacted, at most 200 characters. A line that quotes the framed
// prompt (it names Kherep, in any case) is dropped.
export function lastLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (/kherep/i.test(line)) return "";
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement),
    line.replace(/[\u0000-\u001f\u007f]/g, "")).replace(/[^\s#]+/g, redactQuery).slice(0, 200);
}
