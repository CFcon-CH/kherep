#!/usr/bin/env node
/** Claude Agent/Task adapter for the provider-neutral dispatch policy. */
import fs from "node:fs";
import { evaluateDispatch, type DispatchMetadata } from "./lib/dispatch-policy.mts";

// The fields this hook reads from a PreToolUse payload.
interface DispatchPayload {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

// The Agent/Task tool input fields the dispatch event is built from.
interface DispatchInput {
  subagent_type?: unknown;
  agent_type?: unknown;
  model?: unknown;
  // Issue #737. Whether PreToolUse carries it is unverified; absent is fine.
  effort?: unknown;
  description?: unknown;
  prompt?: unknown;
}

function emitDeny(ruleId: string | undefined, reason: string | undefined, metadata: Partial<DispatchMetadata> = {}): void {
  const safeMeta = `agent=${metadata.agent || "unknown"}, model=${metadata.model || "missing"}, privacy=${Boolean(metadata.privacy)}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[dispatch-contract:${ruleId}] ${reason} (${safeMeta})`,
    },
  }));
}

// Issue #505. A notice is context for the dispatching session: no
// permissionDecision (it neither grants nor gates), no systemMessage. Its
// prefix names the rule that reported it (issue #701).
function emitNotice(ruleId: string, notice: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `[dispatch-contract:${ruleId}] ${notice}`,
    },
  }));
}

function main(): void {
  let payload: DispatchPayload | null;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8")) as DispatchPayload | null;
  } catch {
    emitDeny("HOOK_INPUT_INVALID", "Dispatch hook received malformed JSON; refusing an unclassifiable dispatch.");
    return;
  }

  if (!payload || !["Agent", "Task"].includes(payload.tool_name as string)) return;
  const input = payload.tool_input as DispatchInput | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    emitDeny("HOOK_SCHEMA_UNKNOWN", "Dispatch payload has no recognized tool_input object.");
    return;
  }

  const event = {
    kind: "dispatch",
    agent: input.subagent_type || input.agent_type,
    model: input.model,
    effort: input.effort,
    prompt: [input.description, input.prompt].filter(Boolean).join("\n"),
    brief: input.prompt,
    cwd: payload.cwd,
  };
  const result = evaluateDispatch(event);
  if (result.decision === "deny") emitDeny(result.ruleId, result.reason, result.metadata);
  else if (result.notice) emitNotice(result.noticeRuleId || "OBS_BRIEF_REVISION", result.notice);
}

try {
  main();
} catch {
  emitDeny("HOOK_RUNTIME_FAILURE", "Dispatch policy failed unexpectedly; refusing the dispatch.");
}
process.exit(0);
