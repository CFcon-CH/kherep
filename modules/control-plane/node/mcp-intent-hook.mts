import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MCP_TOOLS, digestMcpArguments, isSelfAssignmentSlot, type McpRuntime, type McpTool } from "../protocol-mcp.mts";
import { fullSessionId } from "../protocol-session-identity.mts";
import { nodePaths, readConfig, type NodePaths } from "./config.mts";
import { consumeMcpIntentReceipt, enqueueMcpIntent } from "./mcp-local.mts";
import { rememberGuardedMcpReply } from "./guarded-replies.mts";
import { loadPolicy, mcpRuntimeEnabled } from "./policy.mts";

const PREFIX = "mcp__kherep_messaging__";
const MAX_INPUT_BYTES = 32 * 1024;
const ACK_WAIT_MS = 8_000;
const ACK_POLL_MS = 25;
export const ACK_DIAGNOSTICS_MAX_BYTES = 64 * 1024;

type Output = { hookSpecificOutput: { hookEventName: "PreToolUse"; updatedInput?: Record<string, unknown>;
  permissionDecision?: "allow" | "deny"; permissionDecisionReason?: string } };

const deny = (reason: string): Output => ({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
} });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolOf(name: unknown): McpTool | null {
  if (typeof name !== "string" || !name.startsWith(PREFIX)) return null;
  const tool = name.slice(PREFIX.length);
  return (MCP_TOOLS as readonly string[]).includes(tool) ? tool as McpTool : null;
}

function effectivePolicyFile(root: string): string | null {
  const paths = nodePaths(root);
  try { return readConfig(paths.config)?.policyFile ?? paths.policy; } catch { return null; }
}

type AckOutcome = "accepted" | "rejected" | "timeout" | "storage_error";
interface AckTiming { runtime: McpRuntime; tool: McpTool; outcome: AckOutcome; ackWaitMs: number | null; hookMs: number }

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

function hookSha256(): string | null {
  try { return createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"); } catch { return null; }
}

// Opt-in ACK latency diagnostics (issue #191). The record exists only while the
// operator-created directory control-plane/mcp/diagnostics exists. It holds
// monotonic durations and fixed labels: no identifiers, arguments or bodies.
// A diagnostics failure never changes the hook decision.
function recordAckTiming(paths: NodePaths, timing: AckTiming): void {
  const dir = path.join(paths.mcp, "diagnostics");
  try {
    if (!fs.lstatSync(dir).isDirectory()) return;
    const file = path.join(dir, "ack-latency.jsonl");
    try {
      if (fs.lstatSync(file).size >= ACK_DIAGNOSTICS_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* absent or concurrently rotated */ }
    const record = { at: new Date().toISOString(), method: "hook-intent-receipt", runtime: timing.runtime,
      tool: timing.tool, outcome: timing.outcome, pollIntervalMs: ACK_POLL_MS,
      ackWaitMs: timing.ackWaitMs, hookMs: timing.hookMs, hookSha256: hookSha256() };
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(record)}\n`); } finally { fs.closeSync(fd); }
  } catch { /* diagnostics are optional */ }
}

export async function processMcpIntentHook(input: Record<string, unknown>, root: string, now = Date.now(),
  runtime: McpRuntime = "codex"): Promise<Output | null> {
  const tool = toolOf(input.tool_name);
  if (!tool) return null;
  const paths = nodePaths(root);
  const policyFile = effectivePolicyFile(root);
  if (!policyFile || !mcpRuntimeEnabled(loadPolicy(policyFile), runtime)) return deny("remote_mcp_disabled");
  if (input.hook_event_name !== "PreToolUse" || typeof input.session_id !== "string"
    || typeof input.tool_use_id !== "string" || !record(input.tool_input)) return deny("remote_mcp_missing_native_identity");
  if (Object.hasOwn(input.tool_input, "requestId")) return deny("remote_mcp_request_id_must_be_native");
  if (tool === "assign_self" && (runtime !== "codex" || !fullSessionId(input.session_id)
    || typeof input.turn_id !== "string" || !input.turn_id || input.turn_id.length > 128
    || Object.keys(input.tool_input).join(",") !== "slot" || !isSelfAssignmentSlot(input.tool_input.slot))) {
    return deny("remote_mcp_invalid_self_assignment");
  }
  const requestId = crypto.randomUUID();
  const hookStart = performance.now();
  let enqueued: number | null = null;
  const timed = (outcome: AckOutcome, output: Output): Output => {
    const end = performance.now();
    recordAckTiming(paths, { runtime, tool, outcome, hookMs: round(end - hookStart),
      ackWaitMs: enqueued === null ? null : round(end - enqueued) });
    return output;
  };
  try {
    if (tool === "reply") rememberGuardedMcpReply(paths, requestId, input.tool_input.inReplyTo);
    const common = { requestId, sessionId: input.session_id, callId: input.tool_use_id,
      tool, argumentsDigest: await digestMcpArguments(input.tool_input) };
    enqueueMcpIntent(paths, tool === "assign_self"
      ? { ...common, runtime: "codex", threadId: input.session_id,
        assignment: { slot: input.tool_input.slot as "codex-mac" | "kherep-lead", turnId: input.turn_id as string } }
      : runtime === "codex" ? { ...common, runtime: "codex" } : { ...common, runtime: "claude-code" });
    enqueued = performance.now();
    const deadline = now + ACK_WAIT_MS;
    while (Date.now() < deadline) {
      const receipt = consumeMcpIntentReceipt(paths, requestId);
      if (receipt) {
        if (!receipt.ok) {
          const category = receipt.rejectionCategory;
          const coherent = category && (category !== "node_assignment_preparation" || tool === "assign_self");
          return timed("rejected", deny(`remote_mcp_intent_rejected${coherent ? `_${category}` : ""}`));
        }
        return timed("accepted", { hookSpecificOutput: { hookEventName: "PreToolUse",
          ...(runtime === "codex" ? { permissionDecision: "allow" as const } : {}),
          updatedInput: { ...input.tool_input, requestId } } });
      }
      await new Promise((resolve) => setTimeout(resolve, ACK_POLL_MS));
    }
    return timed("timeout", deny("remote_mcp_intent_ack_timeout"));
  } catch {
    return timed("storage_error", deny("remote_mcp_intent_storage_error"));
  }
}

function main(argv: string[]): Promise<void> {
  const validRoot = argv[0] === "--config-root" && path.isAbsolute(argv[1] ?? "");
  let runtime: McpRuntime | null = null;
  if (argv.length === 2 && validRoot) runtime = "codex";
  else if (argv.length === 4 && validRoot && argv[2] === "--runtime" && argv[3] === "claude-code") runtime = "claude-code";
  if (!runtime) {
    return Promise.resolve(void process.stdout.write(JSON.stringify(deny("remote_mcp_invalid_arguments"))));
  }
  const raw = fs.readFileSync(0);
  if (raw.length > MAX_INPUT_BYTES) return Promise.resolve(void process.stdout.write(JSON.stringify(deny("remote_mcp_input_too_large"))));
  let input: unknown;
  try { input = JSON.parse(raw.toString("utf8")); } catch { input = null; }
  if (!record(input)) return Promise.resolve(void process.stdout.write(JSON.stringify(deny("remote_mcp_invalid_input"))));
  return processMcpIntentHook(input, argv[1]!, Date.now(), runtime).then((output) => {
    if (output) process.stdout.write(JSON.stringify(output));
  });
}

const entry = process.argv[1] ?? "";
if (entry) {
  let isMain = import.meta.url === pathToFileURL(path.resolve(entry)).href;
  try { isMain ||= import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { /* invalid entry is not main */ }
  if (isMain) void main(process.argv.slice(2));
}
