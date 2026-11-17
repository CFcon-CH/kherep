#!/usr/bin/env node
/**
 * obs-handback-gate.mts  -  PreToolUse guard on SubagentHandback (observation result gate)
 *
 * Issue #571. A claude-obs report delivered through SubagentHandback whose first
 * non-empty line is not exactly one valid OBS-RESULT status line is refused once,
 * with a reason naming the policy's fixed problem, so the subagent sends a
 * corrected handback. Measured on Claude Code 2.1.309: one conditional deny led
 * to a corrected handback about 4 s later (2 of 2); a deny on every attempt led
 * to five identical attempts and a subagent that ended without a report. So the
 * refusal is bounded: at most once per agent_id.
 *
 *   - tool_name is not SubagentHandback, or agent_type is not claude-obs: allow.
 *   - no visible message: allow; the recorder reports it.
 *   - a valid empty or failed status line: allow.
 *   - a valid wrote status line: allow, unless the session (a valid session_id)
 *     has a recorded brief with a `measured:` finding and a page id of the
 *     line has no page line the promotion join can read (issue #950); that
 *     handback is refused with the fixed page line reason.
 *   - a malformed status line is refused; with such a measured brief the reason
 *     also states the page line format, since the refusal is the only one.
 *   - no valid agent_id: allow; without an id the bound cannot be kept.
 *   - before a refusal the marker <home>/.cache/obs-result-check/<agent_id>.refused
 *     is created exclusively: created, deny; it exists already, allow (the
 *     once-only rule, one refusal per id for both checks together); it cannot
 *     be created, allow, because a refusal the gate cannot remember may repeat
 *     on every attempt. A delivered malformed report
 *     is then judged by the PostToolUse recorder obs-handback-record.mts.
 *   - any error: the canonical event-shape warning, exit 0. The gate never
 *     denies on its own error; a missing shape library fails to load (deny).
 *
 * The marker is retained: prune skips it and no hook removes it, because a
 * resumed subagent keeps its id and no event says an id is used for the last
 * time. The once-per-id bound is the policy of a gate that ran; it does not
 * bound the dispatcher's fail-closed deny for a guard that cannot run.
 *
 * PRIVACY. The deny reason is built from constants and the policy's fixed
 * problem text. Nothing from the message or the payload reaches stdout, and the
 * marker holds only the opaque tool_use_id.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  hasMeasuredBrief, homeOf, markRefused, pageLinesReason, pageLinesUnreadable, refusedReason, validId,
} from "./lib/obs-handback-state.mts";
import { checkObsResult } from "./lib/obs-result-policy.mts";
import { warnUnclassifiable } from "./lib/tool-event-shape.mts";

export type HookOutput = {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string };
};

const OBSERVATION_AGENT = "claude-obs";

export function decide(value: unknown, home: string): HookOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload is no object");
  const payload = value as Record<string, unknown>;
  if (payload.tool_name !== "SubagentHandback" || payload.agent_type !== OBSERVATION_AGENT) return null;
  const input = payload.tool_input as { message?: unknown } | null | undefined;
  const message = input && typeof input === "object" ? input.message : undefined;
  if (typeof message !== "string" || !message.trim()) return null;
  const check = checkObsResult(message);
  let reason: string;
  if (!("status" in check)) reason = refusedReason(check.problem, hasMeasuredBrief(home, payload.session_id));
  else if (check.status === "wrote" && pageLinesUnreadable(home, payload.session_id, message)) reason = pageLinesReason();
  else return null;
  const id = validId(payload.agent_id);
  if (!id) return null;
  if (markRefused(home, id, payload.tool_use_id) !== "created") return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

async function main(): Promise<void> {
  let output: HookOutput | null;
  let value: unknown;
  try {
    value = JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8"));
    output = decide(value, homeOf(process.argv[1])); // main runs only when argv[1] names this module
  } catch {
    output = null;
  }
  if (output) process.stdout.write(JSON.stringify(output));
  else warnUnclassifiable(value, "obs-handback-gate"); // the quiet allow (issue #808)
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
