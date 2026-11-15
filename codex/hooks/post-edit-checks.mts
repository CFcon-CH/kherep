import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inputText, normalizePayloads, type HookPayload } from "./hook-adapter.mts";
import { isCompleteReadOnlyToolSequence } from "./post-edit-tool-calls.mts";

const WATCHERS = ["manifest-watch.mts", "loc-watch.mts", "umlaut-translit-watch.mts", "simplify-nudge.mts"];

export function planPostEditPayloads(payload: HookPayload): HookPayload[] {
  if (payload.tool_name === "functions.exec"
      && isCompleteReadOnlyToolSequence(inputText(payload.tool_input))) return [];
  return normalizePayloads(payload, "post");
}

interface Finding {
  additionalContext: string;
  systemMessage?: string;
}

function finding(output: string, watcher: string): Finding | null {
  const text = output.trim();
  if (!text) return null;
  if (!text.startsWith("{")) return { additionalContext: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(watcher + " returned malformed structured output");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(watcher + " returned unsupported structured output");
  }
  const record = parsed as Record<string, unknown>;
  const hook = record.hookSpecificOutput;
  const context = hook && typeof hook === "object"
    ? (hook as Record<string, unknown>).additionalContext : undefined;
  const message = record.systemMessage;
  if (typeof context !== "string" && typeof message !== "string") {
    throw new Error(watcher + " returned structured output without a finding");
  }
  return {
    additionalContext: typeof context === "string" ? context : String(message),
    ...(typeof message === "string" && { systemMessage: message }),
  };
}

function run(payload: HookPayload): number {
  const findings: Finding[] = [];
  for (const normalized of planPostEditPayloads(payload)) {
    // All four versioned watchers reject Bash before inspecting input. Keep
    // patch extraction and its conservative normalization; skip only that
    // proven no-op outcome, rather than attempting to classify shell commands.
    if (normalized.tool_name === "Bash") continue;
    for (const watcher of WATCHERS) {
      const target = path.join(import.meta.dirname, watcher);
      const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", target], {
        encoding: "utf8",
        input: JSON.stringify(normalized),
        windowsHide: true,
      });
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) {
        process.stderr.write(watcher + " could not start: " + result.error.message + "\n");
        return 1;
      }
      if (result.signal) {
        process.stderr.write(watcher + " stopped by signal " + result.signal + "\n");
        return 1;
      }
      if (result.status !== 0) return result.status ?? 1;
      try {
        const found = finding(result.stdout || "", watcher);
        if (found) findings.push(found);
      } catch (error) {
        process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
        return 1;
      }
    }
  }
  if (findings.length) {
    const additionalContext = findings.map((item) => item.additionalContext).join("\n");
    const messages = findings.flatMap((item) => item.systemMessage ? [item.systemMessage] : []);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
      ...(messages.length && { systemMessage: messages.join("\n") }),
    }));
  }
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  let payload: HookPayload;
  try {
    payload = JSON.parse((await (await import("./stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")) as HookPayload;
  } catch {
    process.stderr.write("post-edit-checks received malformed JSON input\n");
    process.exitCode = 1;
    payload = {};
  }
  if (!process.exitCode) process.exitCode = run(payload);
}
