#!/usr/bin/env node
/**
 * obs-handback-record.mts  -  PostToolUse hook on SubagentHandback (observation result record)
 *
 * Issue #555. On Claude Code v2.1.271 or later a subagent that has the
 * SubagentHandback tool delivers its report through that tool before it stops,
 * and last_assistant_message at SubagentStop then holds only its closing text
 * (claude-hooks.md, SubagentStop). The tool is provided only in auto mode, to
 * subagents the Agent tool runs locally other than forks, even when left out
 * of `tools` (claude-tools-reference.md). This hook checks a claude-obs report
 * where it is delivered: PostToolUse runs after the tool executed successfully,
 * with tool_input and tool_use_id (claude-hooks.md, PostToolUse).
 *
 *   - tool_name is not SubagentHandback, or agent_type is not claude-obs: silent.
 *   - the verdict (wrote, empty, failed, or malformed with the policy's fixed
 *     problem text) is recorded with tool_use_id under
 *     <home>/.cache/obs-result-check/<agent_id>.delivered, which the SubagentStop
 *     hook obs-result-check.mts reads, so it neither judges the closing text nor
 *     blocks a delivered report.
 *   - a valid failed report, and a malformed one: the operator notice that
 *     obs-result-check.mts prints for them, the same text. A malformed report is
 *     reported, never refused: the tool already ran. Issue #571: the PreToolUse
 *     gate obs-handback-gate.mts refuses the first malformed handback of an
 *     agent id before it runs; this hook judges what is delivered.
 *   - no visible message: a notice, nothing recorded.
 *   - any error: a one-line systemMessage, exit 0.
 *
 * It never prints a decision and never exits 2. The relative order of this hook
 * and the subagent's SubagentStop is not documented; the stop hook waits for
 * this record for a bounded time (obs-result-check.mts).
 *
 * PRIVACY. Every systemMessage is a constant or the policy's fixed problem
 * text. Nothing from the message, the response or the payload reaches stdout,
 * and the state file holds only the verdict and the opaque tool_use_id.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { FAILED_MESSAGE, homeOf, recordDelivered, stillMalformed, validId } from "./lib/obs-handback-state.mts";
import { checkObsResult } from "./lib/obs-result-policy.mts";

export type HookOutput = { systemMessage: string };

const OBSERVATION_AGENT = "claude-obs";
const PREFIX = "Kherep obs-handback-record:";
const NOT_VISIBLE_HANDBACK = `${PREFIX} the claude-obs handback carried no visible message; check its OBS-RESULT line by hand.`;
const ERROR_MESSAGE = `${PREFIX} the hook failed; the claude-obs handback was not checked.`;

export function decide(value: unknown, home: string): HookOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload is no object");
  const payload = value as Record<string, unknown>;
  if (payload.tool_name !== "SubagentHandback" || payload.agent_type !== OBSERVATION_AGENT) return null;
  const input = payload.tool_input as { message?: unknown } | null | undefined;
  const message = input && typeof input === "object" ? input.message : undefined;
  if (typeof message !== "string" || !message.trim()) return { systemMessage: NOT_VISIBLE_HANDBACK };
  const check = checkObsResult(message);
  const id = validId(payload.agent_id);
  if (id) recordDelivered(home, id, "status" in check ? check.status : `malformed ${check.problem}`, payload.tool_use_id);
  if ("problem" in check) return { systemMessage: stillMalformed(check.problem) };
  return check.status === "failed" ? { systemMessage: FAILED_MESSAGE } : null;
}

async function main(): Promise<void> {
  let output: HookOutput | null;
  try {
    output = decide(JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")), homeOf(process.argv[1] || ""));
  } catch {
    output = { systemMessage: ERROR_MESSAGE };
  }
  if (output) process.stdout.write(JSON.stringify(output));
}

// The isMainModule rule of obs-result-check.mts: the real path or the path as given.
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
