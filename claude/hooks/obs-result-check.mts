#!/usr/bin/env node
/**
 * obs-result-check.mts  -  SubagentStop hook (observation result check)
 *
 * Issue #326. claude-obs starts its final message with exactly one OBS-RESULT
 * status line (claude/agents/claude-obs.md, Result), and the Maestro reports a
 * failed or missing one to the user (ROUTING.md, Session observations). A
 * result once read `OBS-RESULT: failed wrote 4 pages: 1,2,3,4`, which says
 * neither. This hook checks the line with lib/obs-result-policy.mts before the
 * result reaches the Maestro. Pure-regex, NO model call.
 *
 * Issue #555. On Claude Code v2.1.271 or later a subagent with the
 * SubagentHandback tool delivers its report through that tool, and
 * last_assistant_message holds only its closing text (claude-hooks.md,
 * SubagentStop). The tool is provided only in auto mode (claude-tools-reference.md).
 * The PostToolUse hook obs-handback-record.mts checks the delivered report and
 * records its verdict (lib/obs-handback-state.mts). In order:
 *
 *   - agent_type is not claude-obs: silent. The matcher already filters on it.
 *   - a recorded delivery for this agent_id: silent; the recorder has judged it.
 *     A record whose tool_use_id differs from the last handback visible in the
 *     transcript is stale (a resumed subagent keeps its id) and is dropped.
 *   - the order of the recorder and this hook is not documented, so without a
 *     record the hook waits up to 2 s for one, only when one can still come:
 *     permission_mode is "auto" or the transcript shows a handback call.
 *   - a SubagentHandback call in the subagent transcript: its message is judged
 *     with a notice and never a block; a call whose tool_result is an error, or
 *     that has none yet, is reported as such.
 *   - permission_mode "auto" without any evidence: a notice, never a block,
 *     because the closing text is then never the report.
 *   - otherwise the final message, as before: a valid wrote or empty line is
 *     silent, a valid failed line a systemMessage, a malformed line with
 *     stop_hook_active exactly false one decision "block" (Claude Code delivers
 *     the reason to the subagent as its next instruction), a malformed line on
 *     the continuation a systemMessage only, no visible result a systemMessage.
 *     The message comes from last_assistant_message, else from the last
 *     assistant text of agent_transcript_path.
 *   - issue #731 PR-B: in the transcript and final-message branches a valid
 *     wrote report is joined with the brief recorded for session_id
 *     (lib/obs-handback-state.mts recordPromotion), as the recorder does; a
 *     label that cannot be read against a measured brief adds a notice.
 *   - any error: a one-line systemMessage, exit 0.
 *
 * Without a valid agent_id there is no record, no wait and no per-agent state
 * write; the session-keyed promotion join above does not need one.
 * With one, the hook clears the record, prunes state older than 24 h and writes
 * <agent_id>.stop, the fixed-key trace of the host measurement, after the
 * decision. Known limits: when the recorder lands after this hook's transcript
 * branch, the operator can see the same notice twice; a resumed subagent whose
 * transcript shows no handback accepts an old record, and one whose last visible
 * handback is the previous run's, matching the old record, stays silent for the new run.
 *
 * PRIVACY. The block reason is a constant, and every systemMessage is built
 * from constants, the policy's fixed problem texts and numeric page ids.
 * Nothing else from the message, the transcript or the payload reaches stdout
 * or the state files.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  claimJoin, clearDelivered, type Delivered, type DeliveredRead, FAILED_MESSAGE, homeOf, joinKey, OBS_RESULT_FORMAT, PREFIX, prune,
  readDelivered, recordPromotion, stillMalformed, type StopTrace, validId, writeStopTrace,
} from "./lib/obs-handback-state.mts";
import { claudeIds, claudePages } from "./lib/obs-promotion-policy.mts";
import { checkObsResult } from "./lib/obs-result-policy.mts";
import { type Handback, lastAssistantText, lastHandback, readTranscript, type TranscriptEntry } from "./lib/turn-substance.mts";

export interface SubagentStopPayload {
  agent_type?: unknown;
  agent_id?: unknown;
  permission_mode?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  agent_transcript_path?: unknown;
  [key: string]: unknown;
}

export type HookOutput = { decision: "block"; reason: string } | { systemMessage: string };
export interface DecideOptions { home: string; waitMs?: number }

const OBSERVATION_AGENT = "claude-obs";
const WAIT_MS = 2_000;
const POLL_MS = 100;

export const OBS_RESULT_REASON = [
  "OBS-RESULT check (ROUTING.md, Session observations): your final message does not start with one valid status line.",
  "Restate exactly one OBS-RESULT line from what you actually did, as the first line of your final message:",
  OBS_RESULT_FORMAT,
].join(" ");

const NOT_VISIBLE = `${PREFIX} the claude-obs result was not visible to the hook; check its OBS-RESULT line by hand.`;
const NOT_DELIVERED = `${PREFIX} the claude-obs handback did not execute; the Maestro treats the run as a failure and checks the result by hand.`;
const NOT_CONFIRMED = `${PREFIX} the claude-obs handback was seen but its delivery was not confirmed; check the result by hand.`;
const ERROR_MESSAGE = `${PREFIX} the hook failed; the claude-obs result was not checked.`;
const UNCONFIRMED = " (delivery not confirmed)";

const isRecord = (state: DeliveredRead): state is Delivered => state !== null && state !== "unreadable";
const TRANSCRIPT: Record<Handback["result"], StopTrace["transcript"]> = { ok: "delivered", error: "refused", unknown: "unknown" };

// Issue #731 PR-B. A wrote report this hook judges itself is joined with the
// brief here; one the recorder judged (branch "state") was joined there. Each
// result is joined once per agent id and join key (claimJoin, joinKey), so a
// resumed agent's earlier handback or a repeated final message is never joined again.
type Join = (text: string, toolUseId?: string | null) => string | null;

// A warning of the join after an existing notice, or alone.
function withWarning(output: { systemMessage: string } | null, warning: string | null): HookOutput | null {
  if (!warning) return output;
  return { systemMessage: output ? `${output.systemMessage} ${warning}` : warning };
}

function finalMessage(payload: SubagentStopPayload, entries: TranscriptEntry[], join: Join): HookOutput | null {
  const message = payload.last_assistant_message;
  const text = typeof message === "string" && message.trim() ? message : lastAssistantText(entries);
  if (!text.trim()) return { systemMessage: NOT_VISIBLE };
  const check = checkObsResult(text);
  if ("status" in check) {
    if (check.status === "wrote") return withWarning(null, join(text));
    return check.status === "failed" ? { systemMessage: FAILED_MESSAGE } : null;
  }
  if (payload.stop_hook_active === false) return { decision: "block", reason: OBS_RESULT_REASON };
  return { systemMessage: stillMalformed(check.problem) };
}

// The handback's own message, judged without a block.
function handbackMessage(handback: Handback, join: Join): HookOutput | null {
  if (handback.result === "error") return { systemMessage: NOT_DELIVERED };
  const suffix = handback.result === "unknown" ? UNCONFIRMED : "";
  if (!handback.message || !handback.message.trim()) return { systemMessage: NOT_VISIBLE };
  const check = checkObsResult(handback.message);
  if ("problem" in check) return { systemMessage: stillMalformed(check.problem) + suffix };
  if (check.status === "failed") return { systemMessage: FAILED_MESSAGE + suffix };
  const output = suffix ? { systemMessage: NOT_CONFIRMED } : null;
  return check.status === "wrote" ? withWarning(output, join(handback.message, handback.id)) : output;
}

async function waitForRecord(home: string, id: string, waitMs: number): Promise<{ state: DeliveredRead; waited: number }> {
  const start = Date.now();
  let state: DeliveredRead = null;
  while (Date.now() - start < waitMs) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    state = readDelivered(home, id);
    if (isRecord(state)) break;
  }
  return { state, waited: Date.now() - start };
}

export async function decide(value: unknown, { home, waitMs = WAIT_MS }: DecideOptions): Promise<HookOutput | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload is no object");
  const payload = value as SubagentStopPayload;
  if (payload.agent_type !== OBSERVATION_AGENT) return null;
  const id = validId(payload.agent_id);
  const auto = payload.permission_mode === "auto";
  const file = payload.agent_transcript_path;
  const entries = (typeof file === "string" && file ? readTranscript(file) : null) ?? [];
  const handback = lastHandback(entries);

  let state: DeliveredRead = id ? readDelivered(home, id) : null;
  let first: StopTrace["state"] = state === null ? "absent" : state === "unreadable" ? "unreadable" : "present";
  if (isRecord(state) && handback?.id && state.toolUseId !== "-" && state.toolUseId !== handback.id) {
    clearDelivered(home, id!); // a record is read only with an id
    state = null;
    first = "stale";
  }
  let waited = 0;
  let after: StopTrace["after"] = "-";
  if (id && !isRecord(state) && (auto || handback)) {
    ({ state, waited } = await waitForRecord(home, id, waitMs));
    after = isRecord(state) ? "present" : "absent";
  }

  const join: Join = (text, toolUseId) =>
    recordPromotion(home, payload.session_id, claudeIds(text), claudePages(text), () => claimJoin(home, id, joinKey(toolUseId, text)));
  let branch: string;
  let output: HookOutput | null;
  if (isRecord(state)) [branch, output] = ["state", null];
  else if (handback) [branch, output] = [`transcript-${handback.result}`, handbackMessage(handback, join)];
  else if (auto) [branch, output] = ["auto", { systemMessage: NOT_VISIBLE }];
  else [branch, output] = ["final-message", finalMessage(payload, entries, join)];

  if (id) {
    clearDelivered(home, id);
    prune(home);
    writeStopTrace(home, id, { mode: payload.permission_mode, state: first, waited, after, transcript: handback ? TRANSCRIPT[handback.result] : "none", branch });
  }
  return output;
}

async function main(): Promise<void> {
  let output: HookOutput | null;
  try {
    output = await decide(JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")), { home: homeOf(process.argv[1] || "") });
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

if (isMainModule()) void main();
