#!/usr/bin/env node
/** Codex SubagentStop receipt check. Fixed privacy-safe feedback; one correction. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkObsHandback } from "./obs-result-policy.mts";
import { readLatestTurn } from "./research-transcript.mts";

export interface SubagentStopPayload {
  agent_type?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  agent_transcript_path?: unknown;
  [key: string]: unknown;
}

export type HookOutput = { decision: "block"; reason: string } | { systemMessage: string };

const OBSERVATION_AGENT = "codex-obs";
const PREFIX = "Kherep obs-result-check:";

export const OBS_RESULT_REASON = [
  "Observation receipt check: your final message is not one strict publication receipt or worker attempt.",
  "Restate only the existing result as one strict OBS-RESULT line or the bounded OBS-ATTEMPT form in your worker contract, with no Markdown fence or surrounding prose.",
  "Use wrote <n> <comma-separated numeric IDs>, empty no-admissible-findings, or failed <safe-code> with created=<IDs> when applicable.",
  "Preserve a visible canonical receipt and all its IDs even when isError is true. Do not invent adapter codes or infer missing IDs as none.",
  "If the original tool result is unavailable, return exactly OBS-ATTEMPT: failed evidence-unavailable detail=unknown publication=unknown created=unknown.",
  "NO further publication, tool call, retry, new extraction or replacement pages. Perform no configuration or broker I/O.",
].join(" ");
const NOT_VISIBLE = `${PREFIX} the codex-obs result was not visible to the hook; the Maestro independently validates the receipt and target.`;
const ERROR_MESSAGE = `${PREFIX} the hook failed; the codex-obs receipt was not checked.`;

function resultText(payload: SubagentStopPayload): string {
  const message = payload.last_assistant_message;
  if (typeof message === "string" && message.trim()) return message;
  const file = payload.agent_transcript_path;
  if (typeof file !== "string" || !file) return "";
  return readLatestTurn(file)?.finalAssistantText ?? "";
}

export function decide(value: unknown): HookOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload is no object");
  const payload = value as SubagentStopPayload;
  if (payload.agent_type !== OBSERVATION_AGENT) return null;
  const text = resultText(payload);
  if (!text.trim()) return { systemMessage: NOT_VISIBLE };
  const check = checkObsHandback(text);
  if ('status' in check && check.status === 'attempt-failed') return { systemMessage:
    `${PREFIX} non-adapter worker attempt failed (${check.reason}/${check.detail}); report this failure in the same turn; ${check.publication === 'unknown'
      ? 'publication and created IDs are UNKNOWN' : 'publication was not attempted; created IDs: none'}; no retry, publication or silent repair.` };
  if ("status" in check) return check.status === "failed"
    ? {systemMessage: `${PREFIX} OBS-RESULT: failed; report this failure and any created IDs to the operator in the same turn.`} : null;
  if (payload.stop_hook_active === false) return { decision: "block", reason: OBS_RESULT_REASON };
  return { systemMessage: `${PREFIX} the codex-obs receipt is still malformed (${check.problem}); the Maestro treats it as a failure; publication state is UNKNOWN and it must not publish or repair silently.` };
}

function main(): void {
  let output: HookOutput | null;
  try {
    output = decide(JSON.parse(fs.readFileSync(0, "utf8")));
  } catch {
    output = { systemMessage: ERROR_MESSAGE };
  }
  if (output) process.stdout.write(JSON.stringify(output));
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

if (isMainModule()) main();
